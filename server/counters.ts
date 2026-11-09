// Só o que o código usa da D1, para os testes poderem passar um SQLite local.
export interface CounterDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta: { changes: number } }>
      first<T>(): Promise<T | null>
    }
  }
}

// O upsert condicional roda numa única instrução SQLite, então duas requisições ao mesmo tempo nunca passam do limite.
export async function take(db: CounterDb, key: string, limit: number): Promise<boolean> {
  if (!(limit >= 1)) return false
  const r = await db
    .prepare('INSERT INTO counters (key, n) VALUES (?1, 1) ON CONFLICT(key) DO UPDATE SET n = n + 1 WHERE n < ?2')
    .bind(key, limit)
    .run()
  return r.meta.changes === 1
}

export async function used(db: CounterDb, key: string): Promise<number> {
  const row = await db.prepare('SELECT n FROM counters WHERE key = ?1').bind(key).first<{ n: number }>()
  return row?.n ?? 0
}

export const monthKey = (d = new Date()) => `web:${d.toISOString().slice(0, 7)}`
