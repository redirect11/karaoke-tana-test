-- Tabella premi da estrarre
CREATE TABLE IF NOT EXISTS gadget_premi (
  id        BIGSERIAL PRIMARY KEY,
  nome      TEXT    NOT NULL,
  foto_url  TEXT,
  ordine    INTEGER NOT NULL DEFAULT 0,
  creato_il TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tabella estrazioni (un solo vincitore per premio)
CREATE TABLE IF NOT EXISTS gadget_estrazioni (
  id              BIGSERIAL PRIMARY KEY,
  premio_id       BIGINT NOT NULL REFERENCES gadget_premi(id) ON DELETE CASCADE,
  prenotazione_id BIGINT NOT NULL REFERENCES prenotazioni(id),
  serata_id       BIGINT NOT NULL,
  estratto_il     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS gadget_estrazioni_premio_unique
  ON gadget_estrazioni(premio_id);

-- RLS
ALTER TABLE gadget_premi     ENABLE ROW LEVEL SECURITY;
ALTER TABLE gadget_estrazioni ENABLE ROW LEVEL SECURITY;

-- Solo service role (edge function) può accedere — nessuna policy pubblica necessaria

-- Nuovi campi in impostazioni_pubbliche
ALTER TABLE impostazioni_pubbliche
  ADD COLUMN IF NOT EXISTS gadget_estrazione_abilitata BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS gadget_reveal_payload       JSONB;
