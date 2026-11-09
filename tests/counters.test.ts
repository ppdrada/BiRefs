import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { take, used, type CounterDb } from '../server/counters'

// A D1 é SQLite: usamos o SQLite do Node com a mesma migração para testar a trava de verdade.
function sqliteDb(): CounterDb {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(new URL('../migrations/0001_counters.sql', import.meta.url), 'utf8'))
  return {
    prepare: (sql) => ({
      bind: (...values) => ({
        run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(values as never[])).changes) } }),
        first: async <T,>() => (db.prepare(sql).get(...(values as never[])) as T) ?? null,
      }),
    }),
  }
}

describe('trava de cota no D1', () => {
  it('libera exatamente até o limite, mesmo com pedidos simultâneos', async () => {
    const db = sqliteDb()
    const results = await Promise.all(Array.from({ length: 15 }, () => take(db, 'web:2026-11', 10)))
    expect(results.filter(Boolean)).toHaveLength(10)
    expect(await used(db, 'web:2026-11')).toBe(10)
    expect(await take(db, 'web:2026-11', 10)).toBe(false)
  })
  it('meses diferentes têm contadores separados', async () => {
    const db = sqliteDb()
    expect(await take(db, 'web:2026-11', 1)).toBe(true)
    expect(await take(db, 'web:2026-11', 1)).toBe(false)
    expect(await take(db, 'web:2026-12', 1)).toBe(true)
  })
  it('limite inválido ou zero nunca libera', async () => {
    const db = sqliteDb()
    expect(await take(db, 'web:x', 0)).toBe(false)
    expect(await take(db, 'web:x', Number('abc'))).toBe(false)
  })
})
