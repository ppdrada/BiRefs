import { useId, useState, type PointerEvent } from 'react'
import { Icon, type IconName } from './icons'
import { cssFilter, NO_EDITS, rabiscoSlope, renderEdited, toneTable, type Edits, type Rect } from './lib/edit'

type Adjust = 'rabisco' | 'valores' | 'brightness' | 'contrast'

// off = valor sem efeito; on = valor ao ligar um efeito que estava desligado.
const ADJUST: Record<Adjust, { label: string; icon: IconName; min: number; max: number; off: number; on: number; unit: string }> = {
  rabisco: { label: 'Rabisco', icon: 'rabisco', min: 1, max: 100, off: 0, on: 40, unit: '' },
  valores: { label: 'Valores', icon: 'valores', min: 2, max: 6, off: 0, on: 3, unit: ' tons' },
  brightness: { label: 'Brilho', icon: 'brilho', min: 40, max: 160, off: 100, on: 100, unit: '%' },
  contrast: { label: 'Contraste', icon: 'contraste', min: 40, max: 200, off: 100, on: 100, unit: '%' },
}

type Props = { src: string; alt: string; edits: Edits; onChange: (e: Edits) => void; fileName: string }

export default function Editor({ src, alt, edits, onChange, fileName }: Props) {
  const id = useId().replace(/:/g, '')
  const [panel, setPanel] = useState<Adjust | null>(null)
  const [cropping, setCropping] = useState(false)
  const [drag, setDrag] = useState<{ x0: number; y0: number; rect: Rect } | null>(null)
  const [size, setSize] = useState({ w: 1, h: 1 })
  const [note, setNote] = useState('')
  const set = (patch: Partial<Edits>) => onChange({ ...edits, ...patch })
  const off = (a: Adjust) => {
    set({ [a]: ADJUST[a].off })
    setPanel(null)
  }

  function openAdjust(a: Adjust) {
    if (panel === a) return setPanel(null)
    if (edits[a] === ADJUST[a].off) set({ [a]: ADJUST[a].on })
    setPanel(a)
  }

  // Ponto do ponteiro em % da imagem original: desfaz o giro e o espelho que estão na tela.
  function at(e: PointerEvent<HTMLDivElement>) {
    const el = e.currentTarget
    const box = el.getBoundingClientRect()
    const dx = e.clientX - (box.left + box.width / 2)
    const dy = e.clientY - (box.top + box.height / 2)
    const a = (-edits.turns * Math.PI) / 2
    const x = (dx * Math.cos(a) - dy * Math.sin(a)) * (edits.flip ? -1 : 1)
    const y = dx * Math.sin(a) + dy * Math.cos(a)
    const clamp = (v: number) => Math.min(100, Math.max(0, v))
    return { x: clamp((x / el.offsetWidth + 0.5) * 100), y: clamp((y / el.offsetHeight + 0.5) * 100) }
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
      set({ crop: drag.rect })
      setCropping(false)
    }
    setDrag(null)
  }

  async function download() {
    setNote('')
    // Cópia com crossOrigin: sem isso o navegador bloqueia exportar imagens de outros sites.
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.referrerPolicy = 'no-referrer'
    img.src = src
    try {
      await img.decode()
      renderEdited(img, edits, id).toBlob((blob) => {
        if (!blob) return setNote('Não deu para gerar a imagem.')
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = fileName
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 1000)
      }, 'image/png')
    } catch {
      setNote('O site de origem não permite baixar esta imagem editada. Use "ver original" para baixar a original.')
    }
  }

  const img = (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      draggable={false}
      style={{ filter: cssFilter(edits, id) }}
      onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
    />
  )
  const crop = edits.crop
  const slope = rabiscoSlope(edits.rabisco)
  const tones = toneTable(Math.max(2, edits.valores))

  const tool = (name: IconName, label: string, onClick: () => void, on = false, onDoubleClick?: () => void) => (
    <button
      type="button"
      className={on ? 'tool on' : 'tool'}
      aria-label={label}
      aria-pressed={on}
      data-tip={label}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <Icon name={name} />
    </button>
  )

  return (
    <div className="editor">
      {/* Filtros SVG aplicados por CSS: funcionam até em imagens de outros sites, sem copiá-las. */}
      <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}>
        <filter id={`${id}-rabisco`} colorInterpolationFilters="sRGB">
          <feColorMatrix type="saturate" values="0" />
          <feConvolveMatrix order="3" kernelMatrix="-1 -1 -1 -1 8 -1 -1 -1 -1" preserveAlpha="true" />
          <feComponentTransfer>
            <feFuncR type="linear" slope={slope} intercept="1" />
            <feFuncG type="linear" slope={slope} intercept="1" />
            <feFuncB type="linear" slope={slope} intercept="1" />
          </feComponentTransfer>
        </filter>
        <filter id={`${id}-valores`} colorInterpolationFilters="sRGB">
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncR type="discrete" tableValues={tones} />
            <feFuncG type="discrete" tableValues={tones} />
            <feFuncB type="discrete" tableValues={tones} />
          </feComponentTransfer>
        </filter>
      </svg>

      <div className="stage">
        <div style={{ transform: `rotate(${edits.turns * 90}deg) scaleX(${edits.flip ? -1 : 1})` }}>
          {crop && !cropping ? (
            // A moldura tem a proporção da área recortada e a imagem é deslocada dentro dela.
            <div
              className="crop"
              style={{
                aspectRatio: `${crop.w * size.w} / ${crop.h * size.h}`,
                width: `min(900px, 80vw, calc(60vh * ${(crop.w * size.w) / (crop.h * size.h)}))`,
              }}
            >
              <div style={{ left: `${(-crop.x / crop.w) * 100}%`, top: `${(-crop.y / crop.h) * 100}%`, width: `${(100 / crop.w) * 100}%` }}>
                {img}
              </div>
            </div>
          ) : (
            <div className={cropping ? 'pick cropping' : 'pick'} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
              {img}
              {drag && <span className="sel" style={{ left: `${drag.rect.x}%`, top: `${drag.rect.y}%`, width: `${drag.rect.w}%`, height: `${drag.rect.h}%` }} />}
            </div>
          )}
        </div>
      </div>

      <div className="tools" role="toolbar" aria-label="Editar imagem">
        {tool('original', 'Voltar ao original', () => {
          onChange(NO_EDITS)
          setPanel(null)
          setCropping(false)
        })}
        <span className="sep" />
        {(Object.keys(ADJUST) as Adjust[]).map((a) =>
          tool(
            ADJUST[a].icon,
            `${ADJUST[a].label} (clique duplo zera)`,
            () => openAdjust(a),
            edits[a] !== ADJUST[a].off || panel === a,
            () => off(a),
          ),
        )}
        <span className="sep" />
        {tool('espelhar', 'Espelhar', () => set({ flip: !edits.flip }), edits.flip)}
        {tool('girar', 'Girar 90°', () => set({ turns: (edits.turns + 1) % 4 }), edits.turns > 0)}
        {tool(
          'recortar',
          crop ? 'Desfazer recorte' : 'Recortar',
          () => (crop ? set({ crop: null }) : setCropping(!cropping)),
          Boolean(crop) || cropping,
        )}
        <span className="sep" />
        {tool('baixar', 'Baixar imagem editada', download)}
      </div>

      {cropping && <p className="hint">Arraste sobre a imagem para escolher a parte que quer usar.</p>}
      {note && <p className="hint">{note}</p>}

      {panel && (
        <div className="adjust">
          <label htmlFor={`${id}-range`}>{ADJUST[panel].label}</label>
          <input
            id={`${id}-range`}
            type="range"
            min={ADJUST[panel].min}
            max={ADJUST[panel].max}
            value={edits[panel]}
            onChange={(e) => set({ [panel]: Number(e.target.value) })}
          />
          <output htmlFor={`${id}-range`}>
            {edits[panel]}
            {ADJUST[panel].unit}
          </output>
          {tool('fechar', ADJUST[panel].off ? 'Voltar a 100%' : 'Desligar', () => off(panel))}
        </div>
      )}
    </div>
  )
}
