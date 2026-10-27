-- Optional per-app recipient allowlist, e.g. for demo/test apps. NULL = any recipient.
-- Entries are exact addresses ("demo1@gmail.com") or whole domains ("@demo.example.com").
ALTER TABLE apps ADD COLUMN allowed_recipients text[];
