import { describe, expect, it } from 'vitest'
import fixture from './fixtures/features.json'
import { bodyVector, distance, faceAngles, handVector, interleave, rank, type IndexEntry, type Point } from '../src/lib/features'

const points = (sparse: Record<string, number[]>, n: number): Point[] =>
  Array.from({ length: n }, (_, i) => {
    const [x, y, z] = sparse[i] ?? [0, 0, 0]
    return { x, y, z, visibility: 1 }
  })

describe('características (mesma fixture do selftest do Python)', () => {
  it('ângulos do rosto', () => {
    for (const c of fixture.face) {
      expect(faceAngles(points(c.points, 478), c.width, c.height).map((v) => v + 0)).toEqual(c.expected)
    }
  })
  it('vetor do corpo e descarte sem tronco visível', () => {
    const world = points(fixture.body.points, 33)
    expect(bodyVector(world)!.map((v) => v + 0)).toEqual(fixture.body.expected)
    world[23].visibility = 0.1
    expect(bodyVector(world)).toBeUndefined()
  })
  it('vetor da mão normalizado pelo punho', () => {
    expect(handVector(points(fixture.hand.points, 21)).slice(27, 30).map((v) => v + 0)).toEqual(fixture.hand.expectedPoint9)
  })
})

describe('similaridade', () => {
  it('ângulo do rosto dá a volta em ±180°', () => {
    expect(distance('face', [179, 0, 0], [-179, 0, 0])).toBeCloseTo(2)
  })
  it('ordena do mais parecido e ignora quem não tem o tipo pedido', () => {
    const e = (id: string, face?: number[]) => ({ id, face }) as IndexEntry
    const index = [e('longe', [60, 0, 0]), e('perto', [12, 0, 0]), e('sem-rosto'), e('igual', [10, 0, 0])]
    expect(rank(index, 'face', [10, 0, 0]).map((r) => r.entry.id)).toEqual(['igual', 'perto', 'longe'])
  })
  it('junta rosto, corpo e mão intercalando, sem repetir imagem', () => {
    const e = (id: string) => ({ id }) as IndexEntry
    const lists = [[e('r1'), e('r2'), e('r3')], [e('c1'), e('r1')], [], [e('m1')]]
    expect(interleave(lists).map((x) => x.id)).toEqual(['r1', 'c1', 'm1', 'r2', 'r3'])
  })
})
