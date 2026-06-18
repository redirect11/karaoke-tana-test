-- Bucket storage per le foto dei premi gadget
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'gadget-photos',
  'gadget-photos',
  true,                          -- lettura pubblica (URL diretti funzionano)
  5242880,                       -- 5 MB max per file
  ARRAY['image/jpeg','image/png','image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Policy: solo utenti autenticati (admin) possono caricare
DO $$ BEGIN
  CREATE POLICY "gadget_photos_insert_auth"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (bucket_id = 'gadget-photos');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Policy: lettura pubblica
DO $$ BEGIN
  CREATE POLICY "gadget_photos_select_public"
    ON storage.objects FOR SELECT
    TO anon, authenticated
    USING (bucket_id = 'gadget-photos');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Policy: solo autenticati possono eliminare (cleanup se si elimina un premio)
DO $$ BEGIN
  CREATE POLICY "gadget_photos_delete_auth"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (bucket_id = 'gadget-photos');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
