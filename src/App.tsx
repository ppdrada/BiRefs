import { useEffect, useRef, useState, type DragEvent } from 'react'
import { rank, type IndexEntry, type Mode } from './lib/features'
import Viewer from './Viewer'

const MODES: { id: Mode; label: string }[] = [
  { id: 'face', label: 'Rosto' },
  { id: 'body', label: 'Corpo' },
  { id: 'hand', label: 'Mão' },
]

type Group = { mode: Mode; label: string; results: ReturnType<typeof rank> }

export default function App() {
  const [index, setIndex] = useState<IndexEntry[] | null>(null)
  const [photo, setPhoto] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [angles, setAngles] = useState<number[] | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [open, setOpen] = useState<IndexEntry | null>(null)
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
    setGroups([])
    setAngles(null)
    try {
      // O MediaPipe só carrega quando há foto, para a página abrir leve.
      const { detect } = await import('./lib/detect')
      // Procura rosto, corpo e mão de uma vez e mostra o que encontrar.
      const queries = await Promise.all(MODES.map((m) => detect(m.id, img)))
      if (run !== runRef.current) return
      const found = MODES.map((m, i) => ({ ...m, mode: m.id, results: queries[i] ? rank(index, m.id, queries[i], 12) : [] }))
      setAngles(queries[0] ?? null)
      setGroups(found.filter((g) => g.results.length))
      if (!queries.some(Boolean)) setStatus('Não encontrei rosto, corpo nem mão nesta foto. Tente outra.')
      else if (!found.some((g) => g.results.length)) setStatus('Ainda não há referências desse tipo no índice.')
      else setStatus('')
    } catch {
      if (run === runRef.current) setStatus('Não deu para carregar a IA. Confira a conexão e tente de novo.')
    }
  }

  // Busca de novo quando o índice chega; a foto nova dispara pelo onLoad.
  useEffect(() => {
    search()
  }, [index]) // eslint-disable-line react-hooks/exhaustive-deps

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

          {angles && (
            <p className="angles">
              Virado {angles[0]}°, inclinado {angles[1]}°, girado {angles[2]}°
            </p>
          )}
          <p className="status" role="status">
            {status}
          </p>
        </section>

        {groups.map((g) => (
          <section key={g.mode} className="group" aria-labelledby={`g-${g.mode}`}>
            <h2 id={`g-${g.mode}`}>{g.label}</h2>
            <ul className="results">
              {g.results.map(({ entry }) => (
                <li key={entry.id} className="card">
                  <button type="button" className="open" onClick={() => setOpen(entry)} aria-label={`Estudar ${entry.title}`}>
                    <img src={entry.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  </button>
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
          </section>
        ))}
      </main>

      {open && <Viewer entry={open} onClose={() => setOpen(null)} />}

      <footer className="foot">
        A busca roda no seu navegador e a foto não sai do aparelho. Imagens CC0 e CC BY via Openverse, sempre com
        crédito e link para a fonte.
      </footer>
    </div>
  )
}
