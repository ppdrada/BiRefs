import { useEffect, useRef, useState } from 'react'
import Credit from './Credit'
import Editor from './Editor'
import { Icon } from './icons'
import { NO_EDITS, type Edits } from './lib/edit'
import type { IndexEntry } from './lib/features'

type Props = { entry: IndexEntry; onClose: () => void; onSearch: (edits: Edits) => void }

export default function Viewer({ entry, onClose, onSearch }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [edits, setEdits] = useState(NO_EDITS)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  return (
    <dialog ref={dialogRef} className="viewer" onClose={onClose} aria-label={`Estudar: ${entry.title}`}>
      <button type="button" className="tool close" aria-label="Fechar" data-tip="Fechar" onClick={() => dialogRef.current?.close()}>
        <Icon name="fechar" />
      </button>
      {/* O nome do arquivo leva o crédito, como a licença CC BY pede. */}
      <Editor
        src={entry.image}
        alt={entry.title}
        edits={edits}
        onChange={setEdits}
        fileName={`${entry.title.slice(0, 60)} - ${entry.creator} (${entry.license}).png`}
      />
      <div className="viewer-foot">
        <Credit entry={entry} />
        <button type="button" className="btn primary" onClick={() => onSearch(edits)}>
          <Icon name="buscar" /> Buscar com esta imagem
        </button>
      </div>
    </dialog>
  )
}
