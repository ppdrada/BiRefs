// Semelhança geral (qualquer imagem: pessoa, animal, objeto, desenho) com a "impressão" do Image Embedder.
// Cada número da impressão vira 1 bit (positivo ou não), então 1.024 números cabem em 128 bytes no índice.
// Precisa bater com embedding_bits() em scripts/build_index.py.
import type { IndexEntry } from './features'

export function embeddingBits(values: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(values.length / 8))
  for (let i = 0; i < values.length; i++) if (values[i] > 0) bytes[i >> 3] |= 0x80 >> (i & 7)
  return bytes
}

export const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
export const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

const POPCOUNT = Uint8Array.from({ length: 256 }, (_, i) => i.toString(2).replace(/0/g, '').length)

// Quantos bits diferem: quanto menor, mais parecidas.
export function hamming(a: Uint8Array, b: Uint8Array): number {
  let d = 0
  for (let i = 0; i < a.length; i++) d += POPCOUNT[a[i] ^ b[i]]
  return d
}

const decoded = new WeakMap<IndexEntry, Uint8Array>()

export function similar(index: IndexEntry[], query: Uint8Array, limit: number): IndexEntry[] {
  return index
    .filter((e) => e.emb)
    .map((e) => {
      let bits = decoded.get(e)
      if (!bits) decoded.set(e, (bits = fromBase64(e.emb!)))
      return { e, d: hamming(query, bits) }
    })
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((r) => r.e)
}
