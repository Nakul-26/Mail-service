-- Sender domains we operate. Apps may only send from addresses on a verified domain.
CREATE TABLE sender_domains (
  domain        text PRIMARY KEY,               -- lowercase, e.g. notify.example.com
  dkim_selector text NOT NULL,
  dkim_public   text NOT NULL,                  -- base64 SPKI, as published in DNS
  verified_at   timestamptz,                    -- set by `npm run domain -- verify` after DNS checks pass
  last_check    jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Who changed what: apps, keys, routes, domains, allowlists.
CREATE TABLE admin_audit_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  actor     text NOT NULL,
  action    text NOT NULL,
  target    text NOT NULL,
  details   jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX admin_audit_log_at_idx ON admin_audit_log (at);

-- Batches: one row per announcement; every recipient is a normal message row with batch_id set,
-- so batch mail goes through the same queue, retries, suppression and tracking as single emails.
CREATE TABLE batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id           uuid NOT NULL REFERENCES apps(id),
  idempotency_key  text,
  template_id      text NOT NULL,
  from_addr        text NOT NULL,
  recipient_count  integer NOT NULL,
  duplicates_removed integer NOT NULL DEFAULT 0,
  cancelled_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, idempotency_key)
);

ALTER TABLE messages ADD COLUMN batch_id uuid REFERENCES batches(id);
CREATE UNIQUE INDEX messages_batch_recipient_idx ON messages (batch_id, to_addr) WHERE batch_id IS NOT NULL;
CREATE INDEX messages_batch_status_idx ON messages (batch_id, status) WHERE batch_id IS NOT NULL;

ALTER TABLE apps ADD COLUMN max_batch_size integer NOT NULL DEFAULT 10000;

-- Liveness of the worker and tracker, checked by the monitor.
CREATE TABLE service_heartbeats (
  name  text PRIMARY KEY,
  at    timestamptz NOT NULL DEFAULT now(),
  info  jsonb NOT NULL DEFAULT '{}'
);

-- Monitor alert de-duplication.
CREATE TABLE alert_state (
  key         text PRIMARY KEY,
  last_sent   timestamptz NOT NULL,
  last_value  text
);
