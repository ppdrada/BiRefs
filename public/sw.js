// Service worker do BiRefs: deixa o site abrir e buscar sem internet depois da primeira visita.
// - Arquivos do próprio site: mostra o que está guardado e atualiza por trás (stale-while-revalidate).
// - Índice: tenta a rede primeiro, para pegar a versão nova, e usa a guardada se estiver offline.
// - Modelos de IA (MediaPipe e CLIP, ~70 MB, nunca mudam na mesma URL): guardados na primeira vez.
// - Imagens de outros sites e a /api não passam por aqui.
const CACHE = 'birefs-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

async function cacheFirst(req) {
  const hit = await caches.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok) (await caches.open(CACHE)).put(req, res.clone())
  return res
}

async function networkFirst(req) {
  try {
    const res = await fetch(req)
    if (res.ok) (await caches.open(CACHE)).put(req, res.clone())
    return res
  } catch {
    return (await caches.match(req)) ?? Response.error()
  }
}

async function staleWhileRevalidate(req) {
  const hit = await caches.match(req)
  const update = fetch(req)
    .then(async (res) => {
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone())
      return res
    })
    .catch(() => hit ?? Response.error())
  return hit ?? update
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  const model =
    (url.hostname === 'storage.googleapis.com' && url.pathname.startsWith('/mediapipe-models/')) ||
    (url.hostname === 'huggingface.co' && url.pathname.endsWith('.onnx'))
  if (model) return e.respondWith(cacheFirst(req))
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return
  if (url.pathname.startsWith('/index/')) return e.respondWith(networkFirst(req))
  // Páginas: qualquer navegação abre o app guardado quando estiver offline.
  // (só a página inicial: as outras, como /privacidade, são arquivos próprios)
  if (req.mode === 'navigate' && url.pathname === '/') return e.respondWith(networkFirst(new Request('/')))
  e.respondWith(staleWhileRevalidate(req))
})
