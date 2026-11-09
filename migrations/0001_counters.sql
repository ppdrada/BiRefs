-- Contadores exatos: cota mensal do Google Vision ("web:AAAA-MM") e limite diário por IP ("ip:AAAA-MM-DD:<hash>").
CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  n INTEGER NOT NULL
);
