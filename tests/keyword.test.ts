import { describe, expect, it } from 'vitest'
import type { IndexEntry } from '../src/lib/features'
import { refine } from '../src/lib/keyword'

const e = (id: string, title: string, tags: string[] = []) => ({ id, title, tags }) as IndexEntry
const list = [e('a', 'Street scene'), e('b', 'Old man smiling', ['portrait']), e('c', 'Ballet dancer'), e('d', 'Woman', ['smile'])]
const ids = (r: ReturnType<typeof refine>) => r.list.map((x) => x.id)

describe('palavra-chave', () => {
  it('sem palavra, mantém a ordem por ângulo', () => {
    expect(ids(refine(list, '  '))).toEqual(['a', 'b', 'c', 'd'])
  })
  it('traduz do português, ignora acento e sobe quem combina sem perder ninguém', () => {
    const r = refine(list, 'Sorrindo')
    expect(ids(r)).toEqual(['b', 'd', 'a', 'c'])
    expect(r.matched).toBe(2)
  })
  it('todas as palavras precisam combinar, e vale palavra inteira', () => {
    expect(ids(refine(list, 'mulher sorriso'))).toEqual(['d', 'a', 'b', 'c'])
    expect(refine(list, 'man').matched).toBe(1) // "woman" não conta como "man"
  })
  it('nada combina: lista igual e matched 0', () => {
    const r = refine(list, 'cavalo')
    expect(ids(r)).toEqual(['a', 'b', 'c', 'd'])
    expect(r.matched).toBe(0)
  })
})
