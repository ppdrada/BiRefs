// Transforma a saída do MediaPipe em números comparáveis.
// Precisa bater com scripts/build_index.py: mudou aqui, mude lá e rode o índice de novo.

export type Point = { x: number; y: number; z: number; visibility?: number }
export type Mode = 'face' | 'body' | 'hand'
export type Features = { face?: number[]; body?: number[]; hand?: number[] }

export type IndexEntry = Features & {
  id: string
  title: string
  creator: string
  license: string
  licenseUrl: string
  source: string
  url: string // página original, para o crédito
  image: string // imagem no servidor original
  tags?: string[] // tags do Openverse, em inglês
}

const deg = (rad: number) => (rad * 180) / Math.PI
const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places

// Pontos do Face Landmarker: 234/454 = laterais do rosto, 10 = topo da testa, 152 = queixo.
export function faceAngles(lm: Point[], width: number, height: number): number[] {
  const p = (i: number) => ({ x: lm[i].x * width, y: lm[i].y * height, z: lm[i].z * width })
  const [l, r, top, chin] = [p(234), p(454), p(10), p(152)]
  const right = { x: r.x - l.x, y: r.y - l.y, z: r.z - l.z }
  const up = { x: top.x - chin.x, y: top.y - chin.y, z: top.z - chin.z }
  const fwd = {
    x: right.y * up.z - right.z * up.y,
    y: right.z * up.x - right.x * up.z,
    z: right.x * up.y - right.y * up.x,
  }
  const yaw = Math.atan2(fwd.x, -fwd.z)
  const pitch = Math.atan2(fwd.y, Math.hypot(fwd.x, fwd.z))
  const roll = Math.atan2(right.y, right.x)
  return [yaw, pitch, roll].map((a) => round(deg(a), 1))
}

// Ombros, cotovelos, punhos, quadris, joelhos e tornozelos do Pose Landmarker.
const BODY = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
const TORSO = [11, 12, 23, 24]

// Usa os worldLandmarks (3D, com a origem no quadril), normalizados pelo tamanho do tronco.
// Sem ombros e quadris visíveis (num retrato só do rosto, por exemplo), não há corpo.
export function bodyVector(world: Point[]): number[] | undefined {
  if (TORSO.some((i) => (world[i].visibility ?? 1) < 0.5)) return undefined
  const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 })
  const sh = mid(world[11], world[12])
  const hip = mid(world[23], world[24])
  const scale = Math.hypot(sh.x - hip.x, sh.y - hip.y, sh.z - hip.z) || 1
  return BODY.flatMap((i) => [world[i].x - hip.x, world[i].y - hip.y, world[i].z - hip.z].map((v) => round(v / scale, 3)))
}

// Os 21 pontos da mão, centrados no punho (0) e normalizados pela distância do punho até a base do dedo médio (9).
export function handVector(world: Point[]): number[] {
  const w = world[0]
  const scale = Math.hypot(world[9].x - w.x, world[9].y - w.y, world[9].z - w.z) || 1
  return world.flatMap((p) => [p.x - w.x, p.y - w.y, p.z - w.z].map((v) => round(v / scale, 3)))
}

const angleDiff = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180

// Rosto: distância em graus entre os ângulos. Corpo e mão: raiz da média dos quadrados (RMS) das diferenças.
export function distance(mode: Mode, a: number[], b: number[]): number {
  if (mode === 'face') return Math.hypot(...a.map((v, i) => angleDiff(v, b[i])))
  return Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0) / a.length)
}

// Junta as listas de rosto, corpo e mão intercalando por posição (1º de cada, depois 2º...), sem repetir imagem.
// As distâncias de cada tipo têm unidades diferentes, então não dá para ordenar tudo junto por distância.
export function interleave(lists: IndexEntry[][]): IndexEntry[] {
  const seen = new Set<string>()
  const out: IndexEntry[] = []
  for (let i = 0; i < Math.max(0, ...lists.map((l) => l.length)); i++) {
    for (const list of lists) {
      const e = list[i]
      if (e && !seen.has(e.id)) {
        seen.add(e.id)
        out.push(e)
      }
    }
  }
  return out
}

export function rank(index: IndexEntry[], mode: Mode, query: number[], limit = 24) {
  return index
    .filter((e) => e[mode]?.length === query.length)
    .map((entry) => ({ entry, distance: distance(mode, query, entry[mode]!) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
}
