import { Hono } from 'hono'
import { handle } from 'hono/cloudflare-pages'
import { monthKey, take, used } from '../../server/counters'

type Env = {
  DB: D1Database
  KV: KVNamespace
  WEB_MONTHLY_LIMIT: string
  WEB_DAILY_PER_IP: string
  DEVIANTART_CLIENT_ID?: string
  DEVIANTART_CLIENT_SECRET?: string
  GOOGLE_VISION_KEY?: string
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const DA_TOKEN_KEY = 'deviantart:token'

const app = new Hono<{ Bindings: Env }>().basePath('/api')

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'Erro interno.' }, 500)
})
app.notFound((c) => c.json({ error: 'Rota não encontrada.' }, 404))

// ---------- DeviantArt: busca por tag, sem IA, sempre com crédito ----------

async function deviantArtToken(env: Env, fresh = false): Promise<string | null> {
  if (!fresh) {
    const cached = await env.KV.get(DA_TOKEN_KEY)
    if (cached) return cached
  }
  const r = await fetch('https://www.deviantart.com/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.DEVIANTART_CLIENT_ID!,
      client_secret: env.DEVIANTART_CLIENT_SECRET!,
    }),
  })
  if (!r.ok) return null
  const { access_token, expires_in } = await r.json<{ access_token: string; expires_in: number }>()
  // O KV exige pelo menos 60 s de TTL; a margem de 5 min evita usar um token prestes a vencer.
  await env.KV.put(DA_TOKEN_KEY, access_token, { expirationTtl: Math.max(60, expires_in - 300) })
  return access_token
}

type Deviation = {
  title?: string
  url?: string
  author?: { username?: string }
  preview?: { src: string }
  thumbs?: { src: string }[]
}

app.get('/deviantart', async (c) => {
  const tag = (c.req.query('tag') ?? '').trim()
  if (!/^[a-z0-9_]{1,50}$/i.test(tag)) {
    return c.json({ error: 'Informe ?tag= com 1 a 50 letras, números ou _ (ex.: hands).' }, 400)
  }
  if (!c.env.DEVIANTART_CLIENT_ID || !c.env.DEVIANTART_CLIENT_SECRET) {
    return c.json({ error: 'DeviantArt não configurado: faltam DEVIANTART_CLIENT_ID e DEVIANTART_CLIENT_SECRET.' }, 503)
  }

  const url = `https://www.deviantart.com/api/v1/oauth2/browse/tags?${new URLSearchParams({ tag, mature_content: 'false', limit: '24' })}`
  let token = await deviantArtToken(c.env)
  let r = token ? await fetch(url, { headers: { Authorization: `Bearer ${token}` } }) : null
  if (r?.status === 401) {
    token = await deviantArtToken(c.env, true)
    r = token ? await fetch(url, { headers: { Authorization: `Bearer ${token}` } }) : null
  }
  if (!r) return c.json({ error: 'O DeviantArt recusou as credenciais.' }, 502)
  if (!r.ok) return c.json({ error: `O DeviantArt respondeu ${r.status}.` }, 502)

  const { results = [] } = await r.json<{ results?: Deviation[] }>()
  return c.json({
    results: results
      .filter((d) => d.url && (d.thumbs?.length || d.preview))
      .map((d) => ({
        title: d.title ?? '',
        author: d.author?.username ?? '',
        thumb: d.thumbs?.at(-1)?.src ?? d.preview!.src,
        url: d.url!,
      })),
  })
})

// ---------- Google Vision: botão "mais na web" (envia a foto ao Google) ----------

function imageType(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to))
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return null
}

function toBase64(b: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(bin)
}

async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(hash)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

app.post('/web', async (c) => {
  const key = c.env.GOOGLE_VISION_KEY
  if (!key) return c.json({ error: 'Busca na web não configurada: falta GOOGLE_VISION_KEY.' }, 503)

  if (Number(c.req.header('Content-Length') ?? 0) > MAX_IMAGE_BYTES + 64 * 1024) {
    return c.json({ error: 'Imagem grande demais: o máximo é 4 MB.' }, 413)
  }
  const form = await c.req.formData().catch(() => null)
  if (!form) return c.json({ error: 'Envie multipart/form-data com os campos "image" e "consent".' }, 400)
  if (form.get('consent') !== 'true') {
    return c.json({ error: 'Para buscar na web é preciso aceitar o envio da foto ao Google (consent=true).' }, 400)
  }
  const file = form.get('image')
  if (!(file instanceof File)) return c.json({ error: 'Falta o arquivo no campo "image".' }, 400)
  if (file.size > MAX_IMAGE_BYTES) return c.json({ error: 'Imagem grande demais: o máximo é 4 MB.' }, 413)
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!imageType(bytes)) return c.json({ error: 'Formato não suportado: use JPEG, PNG ou WebP.' }, 415)

  // O IP é guardado só como hash, e o contador por IP vem antes para não gastar a cota mensal.
  // shortcut: as linhas diárias de IP não são apagadas; adicione uma limpeza agendada se a tabela crescer.
  const day = new Date().toISOString().slice(0, 10)
  const ipKey = `ip:${day}:${await sha256(c.req.header('CF-Connecting-IP') ?? 'local')}`
  if (!(await take(c.env.DB, ipKey, Number(c.env.WEB_DAILY_PER_IP)))) {
    return c.json({ error: 'Limite diário de buscas na web atingido para este endereço. Tente amanhã.' }, 429)
  }
  if (!(await take(c.env.DB, monthKey(), Number(c.env.WEB_MONTHLY_LIMIT)))) {
    return c.json({ error: 'A cota mensal gratuita de buscas na web acabou. Volta no próximo mês.' }, 429)
  }

  // A cota é contada antes da chamada: se o Google falhar, perdemos uma busca, mas nunca passamos do limite.
  const r = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{ image: { content: toBase64(bytes) }, features: [{ type: 'WEB_DETECTION', maxResults: 24 }] }],
    }),
  })
  if (!r.ok) return c.json({ error: `O Google Vision respondeu ${r.status}.` }, 502)

  type Web = {
    visuallySimilarImages?: { url: string }[]
    pagesWithMatchingImages?: { url: string; pageTitle?: string }[]
    bestGuessLabels?: { label: string }[]
  }
  const { responses } = await r.json<{ responses: { webDetection?: Web; error?: { message: string } }[] }>()
  if (responses?.[0]?.error) return c.json({ error: 'O Google Vision não conseguiu analisar a imagem.' }, 502)
  const web = responses?.[0]?.webDetection ?? {}
  return c.json({
    similar: (web.visuallySimilarImages ?? []).map((i) => i.url),
    pages: (web.pagesWithMatchingImages ?? []).map((p) => ({ url: p.url, title: p.pageTitle ?? '' })),
    labels: (web.bestGuessLabels ?? []).map((l) => l.label),
  })
})

app.get('/quota', async (c) => {
  const limit = Number(c.env.WEB_MONTHLY_LIMIT)
  const remaining = Math.max(0, limit - (await used(c.env.DB, monthKey())))
  return c.json({ active: Boolean(c.env.GOOGLE_VISION_KEY) && remaining > 0, remaining })
})

export const onRequest = handle(app)
