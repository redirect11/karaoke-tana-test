-- Add optional email column to prenotazioni for ad gate bypass and marketing list
ALTER TABLE prenotazioni ADD COLUMN IF NOT EXISTS email TEXT;
