// Ícones de traço simples (24×24, cor do texto).
const PATHS = {
  rabisco: (
    <>
      <path d="M4 20l4-1L19 8l-3-3L5 16z" />
      <path d="M14 7l3 3" />
    </>
  ),
  valores: (
    <>
      <rect x="3" y="7" width="6" height="10" fill="currentColor" fillOpacity="0.15" />
      <rect x="9" y="7" width="6" height="10" fill="currentColor" fillOpacity="0.55" />
      <rect x="15" y="7" width="6" height="10" fill="currentColor" />
    </>
  ),
  brilho: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  contraste: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
    </>
  ),
  espelhar: (
    <>
      <path d="M12 3v18" strokeDasharray="2 2" />
      <path d="M9 7L4 17h5zM15 7l5 10h-5z" />
    </>
  ),
  girar: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 4v6h-6" />
    </>
  ),
  recortar: (
    <>
      <path d="M6 2v16h16" />
      <path d="M2 6h16v16" />
    </>
  ),
  original: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.8" />
      <path d="M3 17l5-5 4 4 3-3 6 6" />
    </>
  ),
  baixar: <path d="M12 4v12M7 11l5 5 5-5M4 20h16" />,
  voltar: <path d="M19 12H5M11 6l-6 6 6 6" />,
  buscar: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>
  ),
  trocar: (
    <>
      <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />
    </>
  ),
  fechar: <path d="M6 6l12 12M18 6L6 18" />,
}

export type IconName = keyof typeof PATHS

export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  )
}
