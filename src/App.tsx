import { useEffect, useRef, useState, type DragEvent } from 'react'
import { rank, type IndexEntry, type Mode } from './lib/features'

const MODES: { id: Mode; label: string }[] = [
  { id: 'face', label: 'Rosto' },
  { id: 'body', label: 'Corpo' },
  { id: 'hand', label: 'Mão' },
]

const NOT_FOUND: Record<Mode, string> = {
  face: 'Não encontrei um rosto nesta foto. Tente outra ou mude o filtro.',
  body: 'Não encontrei um corpo com ombros e quadril visíveis. Tente outra ou mude o filtro.',
  hand: 'Não encontrei uma mão nesta foto. Tente outra ou mude o filtro.',
}

type Result = ReturnType<typeof rank>[number]

export default function App() {
  const [index, setIndex] = useState<IndexEntry[] | null>(null)
  const [photo, setPhoto] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('face')
  const [status, setStatus] = useState('')
  const [angles, setAngles] = useState<number[] | null>(null)
  const [results, setResults] = useState<Result[]>([])
  const imgRef = useRef<HTMLImageElement>(null)
  const runRef = useRef(0)

  useEffect(() => {
    fetch('/index/index.json')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setIndex)
      .catch(() => setStatus('Não deu para carregar o índice de imagens.'))
  }, [])

  async function search() {
    const img = imgRef.current
    if (!index || !img?.complete || !img.naturalWidth) return
    const run = ++runRef.current // ignora respostas de buscas antigas
    setStatus('Analisando a foto no seu aparelho…')
    setResults([])
    setAngles(null)
    try {
      // O MediaPipe só carrega quando há foto, para a página abrir leve.
      const { detect } = await import('./lib/detect')
      const query = await detect(mode, img)
      if (run !== runRef.current) return
      if (!query) return setStatus(NOT_FOUND[mode])
      const found = rank(index, mode, query)
      setAngles(mode === 'face' ? query : null)
      setResults(found)
      setStatus(found.length ? '' : 'Ainda não há referências desse tipo no índice.')
    } catch {
      if (run === runRef.current) setStatus('Não deu para carregar a IA. Confira a conexão e tente de novo.')
    }
  }

  // Busca de novo quando o filtro muda ou o índice chega; a foto nova dispara pelo onLoad.
  useEffect(() => {
    search()
  }, [mode, index]) // eslint-disable-line react-hooks/exhaustive-deps

  function pick(file: File | undefined) {
    if (!file?.type.startsWith('image/')) return setStatus('Escolha um arquivo de imagem.')
    if (photo) URL.revokeObjectURL(photo)
    setPhoto(URL.createObjectURL(file))
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    pick(e.dataTransfer.files[0])
  }

  return (
    <div className="app">
      <header className="top">
        <h1 className="logo" aria-label="BiRefs">
          <img src="/favicon.svg" alt="" width="36" height="36" />
          {/* i sem pingo de propósito: é o desenho da marca */}
          <span aria-hidden="true">BıRefs</span>
        </h1>
        <p className="tagline">Referências de desenho com o mesmo ângulo de rosto, pose ou mão.</p>
      </header>

      <main>
        <section className="query">
          <label className="drop" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
            <input type="file" accept="image/*" onChange={(e) => pick(e.target.files?.[0])} />
            {photo ? (
              <img ref={imgRef} src={photo} alt="Sua foto de referência" onLoad={search} />
            ) : (
              <span>
                <strong>Escolha uma foto</strong> ou arraste aqui
              </span>
            )}
          </label>

          <div className="filters" role="radiogroup" aria-label="O que comparar">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={mode === m.id}
                className={mode === m.id ? 'chip active' : 'chip'}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>

          {angles && (
            <p className="angles">
              Virado {angles[0]}°, inclinado {angles[1]}°, girado {angles[2]}°
            </p>
          )}
          <p className="status" role="status">
            {status}
          </p>
        </section>

        <ul className="results">
          {results.map(({ entry }) => (
            <li key={entry.id} className="card">
              <a href={entry.url} target="_blank" rel="noopener noreferrer">
                <img src={entry.image} alt={entry.title} loading="lazy" referrerPolicy="no-referrer" />
              </a>
              <div className="credit">
                <span className="title">{entry.title}</span>
                <span>
                  por {entry.creator} ·{' '}
                  <a href={entry.licenseUrl} target="_blank" rel="noopener noreferrer license">
                    {entry.license}
                  </a>{' '}
                  ·{' '}
                  <a href={entry.url} target="_blank" rel="noopener noreferrer">
                    ver original
                  </a>
                </span>
              </div>
            </li>
          ))}
        </ul>
      </main>

      <footer className="foot">
        A busca roda no seu navegador e a foto não sai do aparelho. Imagens CC0 e CC BY via Openverse, sempre com
        crédito e link para a fonte.
      </footer>
    </div>
  )
}
