import { describe, expect, it } from 'vitest'
import { toggleFavorite } from '../src/lib/favorites'

describe('favoritos', () => {
  it('põe o novo na frente e tira quem já estava', () => {
    expect(toggleFavorite(['a', 'b'], 'c')).toEqual(['c', 'a', 'b'])
    expect(toggleFavorite(['a', 'b'], 'a')).toEqual(['b'])
  })
})
