import { describe, expect, it } from 'vitest'
import fixture from './fixtures/features.json'
import type { IndexEntry } from '../src/lib/features'
import { embeddingBits, hamming, similar, toBase64 } from '../src/lib/similar'

describe('semelhança geral', () => {
  it('guarda o sinal de cada número igual ao Python (mesma fixture do selftest)', () => {
    expect(toBase64(embeddingBits(fixture.embedding.values))).toBe(fixture.embedding.expected)
  })
  it('ordena pela quantidade de bits diferentes e ignora quem não tem impressão', () => {
    const q = embeddingBits([1, 1, 1, 1, 1, 1, 1, 1])
    const e = (id: string, v?: number[]) => ({ id, emb: v && toBase64(embeddingBits(v)) }) as IndexEntry
    const index = [e('longe', [-1, -1, -1, -1, -1, -1, -1, -1]), e('sem'), e('igual', [1, 1, 1, 1, 1, 1, 1, 1]), e('perto', [1, 1, 1, 1, 1, 1, -1, -1])]
    expect(similar(index, q, 10).map((x) => x.id)).toEqual(['igual', 'perto', 'longe'])
    expect(hamming(q, embeddingBits([-1, 1, 1, 1, 1, 1, 1, 1]))).toBe(1)
  })
})
