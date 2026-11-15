// Favoritos ficam só no navegador (localStorage), sem cadastro.
// shortcut: guarda só o id; o favorito some da lista se a imagem sair do índice. Guardar o crédito inteiro se isso virar queixa.

const KEY = 'birefs:favoritos'

export function loadFavorites(): string[] {
  try {
    const ids = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []
  } catch {
    return [] // navegação privada ou dado estragado
  }
}

// O mais novo vem primeiro.
export const toggleFavorite = (ids: string[], id: string) => (ids.includes(id) ? ids.filter((x) => x !== id) : [id, ...ids])

export function saveFavorites(ids: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids))
  } catch {
    // sem espaço ou navegação privada: o favorito vale só até fechar a página
  }
}
