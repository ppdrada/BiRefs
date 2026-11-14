// Palavra-chave que refina a busca por ângulo: as imagens que combinam sobem, as outras continuam embaixo.
import type { IndexEntry } from './features'

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

// Os títulos e as tags do Openverse estão em inglês; traduz as palavras mais comuns para desenho.
// Palavra fora da lista é buscada como foi digitada (inglês funciona direto).
const PT_EN: Record<string, string[]> = {
  homem: ['man', 'men', 'male', 'guy'],
  mulher: ['woman', 'women', 'female', 'lady'],
  crianca: ['child', 'children', 'kid', 'boy', 'girl'],
  menino: ['boy'],
  menina: ['girl'],
  bebe: ['baby', 'infant'],
  idoso: ['old', 'elderly', 'senior', 'grandfather', 'grandmother'],
  idosa: ['old', 'elderly', 'senior', 'grandmother'],
  velho: ['old', 'elderly'],
  jovem: ['young', 'youth', 'teen'],
  danca: ['dance', 'dancer', 'dancing', 'ballet'],
  dancarina: ['dancer', 'ballerina'],
  bailarina: ['ballerina', 'ballet', 'dancer'],
  luta: ['fight', 'boxing', 'martial', 'wrestling', 'karate'],
  esporte: ['sport', 'athlete'],
  atleta: ['athlete', 'sport'],
  correndo: ['running', 'run', 'runner'],
  corrida: ['running', 'race', 'runner'],
  pulando: ['jump', 'jumping'],
  sentado: ['sitting', 'seated', 'sit'],
  sentada: ['sitting', 'seated', 'sit'],
  deitado: ['lying', 'reclining'],
  deitada: ['lying', 'reclining'],
  perfil: ['profile', 'side'],
  sorriso: ['smile', 'smiling'],
  sorrindo: ['smile', 'smiling'],
  rindo: ['laugh', 'laughing'],
  chorando: ['cry', 'crying', 'tears'],
  mao: ['hand'],
  maos: ['hands', 'hand'],
  rosto: ['face', 'portrait'],
  retrato: ['portrait'],
  corpo: ['body', 'figure'],
  cabelo: ['hair'],
  barba: ['beard'],
  oculos: ['glasses', 'sunglasses'],
  chapeu: ['hat', 'cap'],
  vestido: ['dress'],
  careca: ['bald'],
  musico: ['musician', 'music'],
  guitarra: ['guitar'],
  violao: ['guitar'],
  pintura: ['painting', 'painted'],
  foto: ['photo', 'photograph'],
  caveira: ['skull'],
  esqueleto: ['skeleton'],
  preto: ['black'],
  branco: ['white'],
}

// Cada palavra digitada vira a lista de termos que valem para ela.
export function keywordTerms(keyword: string): string[][] {
  return plain(keyword)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1)
    .map((w) => [w, ...(PT_EN[w] ?? [])])
}

// Tag do DeviantArt: a primeira palavra, traduzida para o inglês quando está na lista.
export function deviantTag(keyword: string): string {
  const [first] = keywordTerms(keyword)
  return first ? (first[1] ?? first[0]) : ''
}

const matches = (e: IndexEntry, terms: string[][]) => {
  const words = new Set(plain([e.title, ...(e.tags ?? [])].join(' ')).split(/[^a-z0-9]+/))
  // Todas as palavras digitadas precisam aparecer (em alguma das traduções) como palavra inteira.
  return terms.every((options) => options.some((t) => words.has(t)))
}

// Mantém a ordem por ângulo dentro de cada parte: primeiro as que combinam, depois o resto.
export function refine(list: IndexEntry[], keyword: string): { list: IndexEntry[]; matched: number } {
  const terms = keywordTerms(keyword)
  if (!terms.length) return { list, matched: 0 }
  const yes = list.filter((e) => matches(e, terms))
  return { list: [...yes, ...list.filter((e) => !yes.includes(e))], matched: yes.length }
}
