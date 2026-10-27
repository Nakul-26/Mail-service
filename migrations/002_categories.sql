-- Marketing mail (newsletters) can be unsubscribed per topic without affecting transactional mail.
ALTER TABLE messages
  ADD COLUMN category text NOT NULL DEFAULT 'transactional'
    CHECK (category IN ('transactional', 'marketing')),
  ADD COLUMN topic text;

-- scope 'all' blocks every message (hard bounce, complaint, manual);
-- any other value is a marketing topic the recipient unsubscribed from.
ALTER TABLE suppressions ADD COLUMN scope text NOT NULL DEFAULT 'all';
ALTER TABLE suppressions DROP CONSTRAINT suppressions_pkey;
ALTER TABLE suppressions ADD PRIMARY KEY (tenant_id, email, scope);

-- Sized for ~10k-recipient announcements.
ALTER TABLE apps
  ALTER COLUMN rate_per_minute SET DEFAULT 600,
  ALTER COLUMN daily_quota SET DEFAULT 20000;
