// Edições que se somam: recorte, giro, espelho, brilho, contraste, rabisco e valores.

export type Rect = { x: number; y: number; w: number; h: number } // em % da imagem original

export type Edits = {
  crop: Rect | null
  turns: number // giros de 90°
  flip: boolean
  brightness: number // %
  contrast: number // %
  rabisco: number // 0 = desligado, 1 a 100 = força do traço
  valores: number // 0 = desligado, 2 a 6 = quantidade de tons
}

export const NO_EDITS: Edits = { crop: null, turns: 0, flip: false, brightness: 100, contrast: 100, rabisco: 0, valores: 0 }

export const sameEdits = (a: Edits, b: Edits) => JSON.stringify(a) === JSON.stringify(b)

// Filtro CSS da pré-visualização; os efeitos apontam para os filtros SVG do editor (ids únicos por editor).
export function cssFilter(e: Edits, id: string): string | undefined {
  const parts = [
    e.brightness !== 100 && `brightness(${e.brightness}%)`,
    e.contrast !== 100 && `contrast(${e.contrast}%)`,
    e.rabisco > 0 && `url(#${id}-rabisco)`,
    e.valores > 0 && `url(#${id}-valores)`,
  ].filter(Boolean)
  return parts.length ? parts.join(' ') : undefined
}

// Tons igualmente espaçados, do quase preto ao quase branco.
export const toneTable = (n: number) =>
  Array.from({ length: n }, (_, i) => (0.08 + (0.84 * i) / (n - 1)).toFixed(2)).join(' ')

// Força do rabisco vira a inclinação da curva que escurece as bordas.
export const rabiscoSlope = (strength: number) => -(1 + strength / 12)

// Desenha a imagem com as edições num canvas.
// Com filterId, inclui rabisco e valores (usa os filtros SVG do editor); sem ele, só brilho e contraste,
// que é o que vai para a busca, porque o traço do rabisco atrapalha a IA a achar rosto, corpo e mão.
export function renderEdited(img: HTMLImageElement, e: Edits, filterId?: string): HTMLCanvasElement {
  const W = img.naturalWidth
  const H = img.naturalHeight
  const c = e.crop ?? { x: 0, y: 0, w: 100, h: 100 }
  const [sx, sy, sw, sh] = [(c.x / 100) * W, (c.y / 100) * H, (c.w / 100) * W, (c.h / 100) * H]
  const sideways = e.turns % 2 === 1
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(sideways ? sh : sw)
  canvas.height = Math.round(sideways ? sw : sh)
  const ctx = canvas.getContext('2d')!
  ctx.filter = (filterId ? cssFilter(e, filterId) : cssFilter({ ...e, rabisco: 0, valores: 0 }, '')) ?? 'none'
  // Mesma ordem do CSS "rotate() scaleX()": espelha primeiro, depois gira.
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate((e.turns * Math.PI) / 2)
  ctx.scale(e.flip ? -1 : 1, 1)
  ctx.drawImage(img, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh)
  return canvas
}
