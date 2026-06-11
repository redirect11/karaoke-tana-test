ALTER TABLE impostazioni_pubbliche
  ADD COLUMN IF NOT EXISTS email_campo_abilitato BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_gate_abilitato  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS email_gate_modalita   TEXT    NOT NULL DEFAULT 'entrambi'
    CONSTRAINT email_gate_modalita_check CHECK (email_gate_modalita IN ('video', 'link', 'entrambi'));
