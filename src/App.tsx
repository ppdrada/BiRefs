import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import Editor from './Editor'
import { Icon } from './icons'
import { NO_EDITS, renderEdited, sameEdits, type Edits } from './lib/edit'
import { interleave, rank, type IndexEntry, type Mode } from './lib/features'
import { refine } from './lib/keyword'
import { embeddingBits, fromBase64, similar } from './lib/similar'
import Credit from './Credit'
import Viewer from './Viewer'

const MODES: Mode[] = ['face', 'body', 'hand']
const POOL_PER_MODE = 40 // parecidas por tipo; a palavra-chave reordena dentro delas
const SIMILAR = 60 // parecidas no geral, que entram depois das parecidas pelo ângulo
const SHOW = 36
const KINDS = [
  { id: 'all', label: 'Tudo' },
  { id: 'photo', label: 'Fotos' },
  { id: 'drawing', label: 'Desenhos' },
] as const
type Kind = (typeof KINDS)[number]['id']

// O que está sendo usado na busca: a foto da pessoa ou uma referência do índice.
type Query = { src: string; entry?: IndexEntry }
type Snapshot = { query: Query; edits: Edits; searched: Edits | null; pool: IndexEntry[]; keyword: string; angles: number[] | null }

// Rabisco e valores são só para estudar: não mudam a busca.
const forSearch = (e: Edits) => ({ ...e, rabisco: 0, valores: 0 })

export default function App() {
  const [index, setIndex] = useState<IndexEntry[] | null>(null)
  const [query, setQuery] = useState<Query | null>(null)
  const [status, setStatus] = useState('')
  const [angles, setAngles] = useState<number[] | null>(null)
  const [pool, setPool] = useState<IndexEntry[]>([]) // parecidas pelo ângulo, da mais para a menos
  const [keyword, setKeyword] = useState('')
  const [kind, setKind] = useState<Kind>('all')
  const [open, setOpen] = useState<IndexEntry | null>(null)
  const [edits, setEdits] = useState<Edits>(NO_EDITS)
  const [searched, setSearched] = useState<Edits | null>(null) // edição usada na última busca
  const [history, setHistory] = useState<Snapshot[]>([]) // buscas anteriores, para o botão Voltar
  const imgRef = useRef<HTMLImageElement | null>(null) // imagem da busca carregada fora da tela
  const runRef = useRef(0)

  useEffect(() => {
    fetch('/index/index.json')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setIndex)
      .catch(() => setStatus('Não deu para carregar o índice de imagens.'))
  }, [])

  async function loadImage(q: Query) {
    if (imgRef.current?.src === q.src) return imgRef.current
    const img = new Image()
    img.crossOrigin = 'anonymous' // sem isso a IA não pode ler imagens de outros sites
    img.referrerPolicy = 'no-referrer'
    img.src = q.src
    await img.decode()
    imgRef.current = img
    return img
  }

  async function search(withEdits = edits, q = query) {
    if (!index || !q) return
    const run = ++runRef.current // ignora respostas de buscas antigas
    setStatus('Analisando a imagem no seu aparelho…')
    setPool([])
    setAngles(null)
    setSearched(withEdits)
    let queries: (number[] | undefined)[]
    let emb: Uint8Array | undefined
    try {
      if (q.entry && sameEdits(forSearch(withEdits), NO_EDITS)) {
        // Referência sem edição: os números já estão no índice, não precisa rodar a IA.
        queries = MODES.map((m) => q.entry![m])
        emb = q.entry.emb ? fromBase64(q.entry.emb) : undefined
      } else {
        let img: HTMLImageElement
        try {
          img = await loadImage(q)
        } catch {
          if (run === runRef.current) setStatus('O site de origem não deixa analisar esta imagem com edição. Busque sem editar ou escolha outra.')
          return
        }
        // O MediaPipe só carrega quando há imagem, para a página abrir leve.
        const { detect } = await import('./lib/detect')
        const source = sameEdits(forSearch(withEdits), NO_EDITS) ? img : renderEdited(img, withEdits)
        // Procura rosto, corpo e mão de uma vez e mostra o que encontrar.
        const [face, body, hand, general] = await Promise.all([...MODES, 'embed' as const].map((m) => detect(m, source)))
        queries = [face, body, hand]
        emb = general?.length ? embeddingBits(general) : undefined
      }
    } catch {
      if (run === runRef.current) setStatus('Não deu para carregar a IA. Confira a conexão e tente de novo.')
      return
    }
    if (run !== runRef.current) return
    const others = q.entry ? index.filter((e) => e.id !== q.entry!.id) : index
    const byAngle = interleave(MODES.map((m, i) => (queries[i] ? rank(others, m, queries[i]!, POOL_PER_MODE).map((r) => r.entry) : [])))
    // Depois das parecidas pelo ângulo vêm as parecidas no geral (servem para animais, objetos e desenhos).
    const general = emb ? similar(others, emb, SIMILAR).filter((e) => !byAngle.includes(e)) : []
    setAngles(queries[0] ?? null)
    setPool([...byAngle, ...general])
    if (!byAngle.length && !general.length) setStatus('Ainda não há referências parecidas no índice.')
    else if (!queries.some(Boolean)) setStatus('Não achei pessoa nesta imagem, então mostro as parecidas no geral.')
    else setStatus('')
  }

  // Busca quando o índice chega depois da foto; as outras buscas são disparadas pelas ações.
  useEffect(() => {
    search()
  }, [index]) // eslint-disable-line react-hooks/exhaustive-deps

  // shortcut: as URLs blob das fotos não são liberadas, para o Voltar continuar mostrando a foto; são poucas por visita.
  async function pick(file: File | undefined) {
    if (!file?.type.startsWith('image/')) return setStatus('Escolha um arquivo de imagem.')
    const q = { src: URL.createObjectURL(file) }
    try {
      await loadImage(q)
    } catch {
      return setStatus('Não deu para abrir essa imagem. Tente outra.')
    }
    setQuery(q)
    setHistory([])
    setEdits(NO_EDITS)
    search(NO_EDITS, q)
  }

  function searchWith(entry: IndexEntry, entryEdits: Edits) {
    if (query) setHistory([...history, { query, edits, searched, pool, keyword, angles }])
    const q = { src: entry.image, entry }
    setQuery(q)
    setEdits(entryEdits)
    setOpen(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
    search(entryEdits, q)
  }

  function back() {
    const prev = history.at(-1)
    if (!prev) return
    runRef.current++ // cancela uma busca que ainda esteja rodando
    setHistory(history.slice(0, -1))
    setQuery(prev.query)
    setEdits(prev.edits)
    setSearched(prev.searched)
    setPool(prev.pool)
    setKeyword(prev.keyword)
    setAngles(prev.angles)
    setStatus('')
  }

  const changePhoto = <input type="file" accept="image/*" onChange={(e) => pick(e.target.files?.[0])} />

  function onDrop(e: DragEvent) {
    e.preventDefault()
    pick(e.dataTransfer.files[0])
  }

  const entry = query?.entry
  const refined = useMemo(() => refine(kind === 'all' ? pool : pool.filter((e) => e.kind === kind), keyword), [pool, keyword, kind])
  const results = refined.list.slice(0, SHOW)
  const word = keyword.trim()
  return (
    <div className="app">
      <header className="top">
        <h1 className="logo" aria-label="BiRefs">
          <img src="/favicon.svg" alt="" width="36" height="36" />
          {/* i sem pingo de propósito: é o desenho da marca */}
          <span aria-hidden="true">BıRefs</span>
        </h1>
        <p className="tagline">Suba uma foto e encontre referências parecidas com a sua imagem.</p>
      </header>

      <main>
        <section className="query">
          {query ? (
            <div onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
              <Editor
                key={query.src}
                src={query.src}
                alt={entry ? entry.title : 'Sua foto'}
                edits={edits}
                onChange={setEdits}
                fileName={entry ? `${entry.title.slice(0, 60)} - ${entry.creator} (${entry.license}).png` : 'birefs-minha-foto.png'}
              />
              {entry && <Credit entry={entry} />}
              <div className="photo-actions">
                {history.length > 0 && (
                  <button type="button" className="btn" onClick={back}>
                    <Icon name="voltar" /> Voltar
                  </button>
                )}
                {searched && !sameEdits(forSearch(edits), forSearch(searched)) && (
                  <button type="button" className="btn primary" onClick={() => search()}>
                    <Icon name="buscar" /> Buscar com esta edição
                  </button>
                )}
                <label className="btn">
                  {changePhoto}
                  <Icon name="trocar" /> {entry ? 'Usar minha foto' : 'Trocar foto'}
                </label>
              </div>
              <label className="keyword">
                <Icon name="buscar" />
                <input
                  type="search"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="Palavra-chave (opcional): mulher, dança…"
                  aria-label="Palavra-chave para refinar as referências"
                />
              </label>
              <div className="kinds" role="radiogroup" aria-label="Tipo de referência">
                {KINDS.map((k) => (
                  <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className={kind === k.id ? 'btn primary' : 'btn'} onClick={() => setKind(k.id)}>
                    {k.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <label className="drop" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
              {changePhoto}
              <span>
                <strong>Escolha uma foto</strong> ou arraste aqui
              </span>
            </label>
          )}

          {angles && (
            <p className="angles">
              Virado {angles[0]}°, inclinado {angles[1]}°, girado {angles[2]}°
            </p>
          )}
          <p className="status" role="status">
            {status ||
              (word && pool.length > 0
                ? refined.matched
                  ? `${refined.matched} das parecidas combinam com “${word}” e aparecem primeiro.`
                  : `Nenhuma das parecidas combina com “${word}”. Mostrando sem a palavra.`
                : pool.length > 0 && !results.length
                  ? 'Nenhuma referência desse tipo entre as parecidas. Tente "Tudo".'
                  : '')}
          </p>
        </section>

        {results.length > 0 && (
          <section aria-label="Referências parecidas">
            <ul className="results">
              {results.map((r) => (
                <li key={r.id} className="card">
                  <button type="button" className="open" onClick={() => setOpen(r)} aria-label={`Estudar ${r.title}`}>
                    <img src={r.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  </button>
                  <Credit entry={r} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>

      {open && <Viewer entry={open} onClose={() => setOpen(null)} onSearch={(e) => searchWith(open, e)} />}

      <footer className="foot">
        Sua foto é analisada aqui no seu navegador e não é enviada a lugar nenhum. As referências são imagens livres
        (CC0 e CC BY) do Openverse, sempre com o crédito de quem fez.
      </footer>
    </div>
  )
}
