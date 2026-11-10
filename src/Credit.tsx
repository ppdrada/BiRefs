import type { IndexEntry } from './lib/features'

// Crédito exigido pelas licenças: título, autor, licença e link para a fonte (sempre em nova aba).
export default function Credit({ entry }: { entry: IndexEntry }) {
  return (
    <div className="credit">
      <span className="title">{entry.title}</span>
      <span>
        por {entry.creator} ·{' '}
        <a href={entry.licenseUrl} target="_blank" rel="noopener noreferrer license">
          {entry.license}
        </a>{' '}
        ·{' '}
        <a href={entry.url} target="_blank" rel="noopener noreferrer">
          ver original
        </a>
      </span>
    </div>
  )
}
