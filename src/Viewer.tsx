import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { IndexEntry } from './lib/features'

type Effect = 'none' | 'rabisco' | 'valores'
type Rect = { x: number; y: number; w: number; h: number } // em % da imagem

const EFFECTS: { id: Effect; label: string }[] = [
  { id: 'none', label: 'Original' },
  { id: 'rabisco', label: 'Rabisco' },
  { id: 'valores', label: 'Valores' },
]

// Os efeitos usam filtros SVG aplicados por CSS: funcionam em imagens de outros sites sem precisar copiá-las.
const FILTERS = (
  <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}>
    <filter id="fx-rabisco" colorInterpolationFilters="sRGB">
      <feColorMatrix type="saturate" values="0" />
      <feConvolveMatrix order="3" kernelMatrix="-1 -1 -1 -1 8 -1 -1 -1 -1" preserveAlpha="true" />
      <feComponentTransfer>
        <feFuncR type="linear" slope="-4" intercept="1" />
        <feFuncG type="linear" slope="-4" intercept="1" />
        <feFuncB type="linear" slope="-4" intercept="1" />
      </feComponentTransfer>
    </filter>
    <filter id="fx-valores" colorInterpolationFilters="sRGB">
      <feColorMatrix type="saturate" values="0" />
      <feComponentTransfer>
        <feFuncR type="discrete" tableValues="0.12 0.5 0.92" />
        <feFuncG type="discrete" tableValues="0.12 0.5 0.92" />
        <feFuncB type="discrete" tableValues="0.12 0.5 0.92" />
      </feComponentTransfer>
    </filter>
  </svg>
)

export default function Viewer({ entry, onClose }: { entry: IndexEntry; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [effect, setEffect] = useState<Effect>('none')
  const [flip, setFlip] = useState(false)
  const [turns, setTurns] = useState(0)
  const [cropping, setCropping] = useState(false)
  const [crop, setCrop] = useState<Rect | null>(null)
  const [drag, setDrag] = useState<{ x0: number; y0: number; rect: Rect } | null>(null)
  const [size, setSize] = useState({ w: 1, h: 1 })

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  // Posição do ponteiro em % da imagem inteira (antes do recorte).
  function at(e: PointerEvent<HTMLDivElement>) {
    const box = e.currentTarget.getBoundingClientRect()
    const clamp = (v: number) => Math.min(100, Math.max(0, v))
    return { x: clamp(((e.clientX - box.left) / box.width) * 100), y: clamp(((e.clientY - box.top) / box.height) * 100) }
  }

  function onDown(e: PointerEvent<HTMLDivElement>) {
    if (!cropping) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = at(e)
    setDrag({ x0: p.x, y0: p.y, rect: { x: p.x, y: p.y, w: 0, h: 0 } })
  }
  function onMove(e: PointerEvent<HTMLDivElement>) {
    if (!drag) return
    const p = at(e)
    setDrag({ ...drag, rect: { x: Math.min(p.x, drag.x0), y: Math.min(p.y, drag.y0), w: Math.abs(p.x - drag.x0), h: Math.abs(p.y - drag.y0) } })
  }
  function onUp() {
    if (drag && drag.rect.w > 3 && drag.rect.h > 3) {
      setCrop(drag.rect)
      setCropping(false)
    }
    setDrag(null)
  }

  const transform = `rotate(${turns * 90}deg) scaleX(${flip ? -1 : 1})`
  const filter = effect === 'none' ? undefined : `url(#fx-${effect})`
  const img = (
    <img
      src={entry.image}
      alt={entry.title}
      referrerPolicy="no-referrer"
      draggable={false}
      style={{ filter }}
      onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
    />
  )

  return (
    <dialog ref={dialogRef} className="viewer" onClose={onClose} aria-label={`Estudar: ${entry.title}`}>
      {FILTERS}
      <div className="viewer-tools" role="toolbar" aria-label="Ferramentas da referência">
        {EFFECTS.map((f) => (
          <button key={f.id} type="button" aria-pressed={effect === f.id} className={effect === f.id ? 'chip active' : 'chip'} onClick={() => setEffect(f.id)}>
            {f.label}
          </button>
        ))}
        <span className="sep" />
        <button type="button" className={flip ? 'chip active' : 'chip'} aria-pressed={flip} onClick={() => setFlip((f) => !f)}>
          Espelhar
        </button>
        <button type="button" className="chip" onClick={() => setTurns((t) => (t + 1) % 4)}>
          Girar 90°
        </button>
        {crop ? (
          <button type="button" className="chip" onClick={() => setCrop(null)}>
            Desfazer recorte
          </button>
        ) : (
          <button type="button" className={cropping ? 'chip active' : 'chip'} aria-pressed={cropping} onClick={() => setCropping(!cropping)}>
            Recortar
          </button>
        )}
        <button type="button" className="chip close" onClick={() => dialogRef.current?.close()} aria-label="Fechar">
          ✕
        </button>
      </div>

      {cropping && <p className="viewer-hint">Arraste sobre a imagem para escolher a parte que quer estudar.</p>}

      <div className="viewer-stage">
        <div style={{ transform }}>
          {crop ? (
            // Recorte: a moldura tem a proporção da área escolhida e a imagem é deslocada dentro dela.
            <div className="crop" style={{
                aspectRatio: `${crop.w * size.w} / ${crop.h * size.h}`,
                width: `min(900px, 80vw, calc(62vh * ${(crop.w * size.w) / (crop.h * size.h)}))`,
              }}>
              <div style={{ left: `${(-crop.x / crop.w) * 100}%`, top: `${(-crop.y / crop.h) * 100}%`, width: `${(100 / crop.w) * 100}%` }}>{img}</div>
            </div>
          ) : (
            <div className={cropping ? 'pick cropping' : 'pick'} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
              {img}
              {drag && <span className="sel" style={{ left: `${drag.rect.x}%`, top: `${drag.rect.y}%`, width: `${drag.rect.w}%`, height: `${drag.rect.h}%` }} />}
            </div>
          )}
        </div>
      </div>

      <p className="credit">
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
      </p>
    </dialog>
  )
}
