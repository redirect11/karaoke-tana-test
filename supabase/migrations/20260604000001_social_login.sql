-- Tabella profili utente (creata al primo login social)
CREATE TABLE IF NOT EXISTS profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  TEXT,
  avatar_url    TEXT,
  provider      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_select_public"
  ON profiles FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "profiles_insert_own"
  ON profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);

CREATE POLICY "profiles_update_own"
  ON profiles FOR UPDATE TO authenticated USING (auth.uid() = id);

-- user_id opzionale sulle prenotazioni (NULL = prenotazione anonima)
ALTER TABLE prenotazioni
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Vista classifiche: voti ricevuti aggregati per utente
CREATE OR REPLACE VIEW classifica_utenti AS
SELECT
  p.id                                      AS user_id,
  p.display_name,
  p.avatar_url,
  COUNT(v.id)                               AS total_votes,
  ROUND(AVG(v.voto)::numeric, 2)            AS avg_score,
  COUNT(DISTINCT pr.serata_id)              AS serate_partecipate,
  COUNT(DISTINCT pr.id)                     AS canzoni_cantate
FROM profiles p
JOIN prenotazioni pr ON pr.user_id = p.id
JOIN voti v ON v.prenotazione_id = pr.id
GROUP BY p.id, p.display_name, p.avatar_url;
