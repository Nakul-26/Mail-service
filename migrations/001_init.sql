-- Tenants are institutions/customers; apps are products within a tenant.
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE apps (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  name             text NOT NULL,
  product          text NOT NULL,              -- exam | placement | alumni; gates template access
  default_from     text NOT NULL,
  allowed_senders  text[] NOT NULL,
  rate_per_minute  integer NOT NULL DEFAULT 120,
  daily_quota      integer NOT NULL DEFAULT 5000,
  disabled_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- Only a SHA-256 hash of each key is stored; the prefix is used for lookup.
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        uuid NOT NULL REFERENCES apps(id),
  prefix        text NOT NULL UNIQUE,
  key_hash      text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

CREATE TYPE message_status AS ENUM (
  'queued',      -- waiting for first attempt
  'sending',     -- claimed by a worker (lease in locked_until)
  'deferred',    -- temporary failure, will retry at next_attempt_at
  'sent',        -- accepted by the SMTP relay (not proof of inbox delivery)
  'delivered',   -- confirmed by relay webhook (M3)
  'bounced',     -- bounce reported after acceptance (M3)
  'failed',      -- permanent failure or retries exhausted
  'suppressed'   -- recipient on suppression list; never attempted
);

-- The message row is also the job: no separate broker, no dual write.
CREATE TABLE messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id               uuid NOT NULL REFERENCES apps(id),
  idempotency_key      text,
  template_id          text NOT NULL,
  from_addr            text NOT NULL,
  to_addr              text NOT NULL,
  variables            jsonb NOT NULL,
  sensitive_keys       text[] NOT NULL DEFAULT '{}',
  priority             smallint NOT NULL,       -- 0 critical, 1 transactional, 2 bulk
  status               message_status NOT NULL DEFAULT 'queued',
  attempts             integer NOT NULL DEFAULT 0,
  max_attempts         integer NOT NULL,
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  locked_until         timestamptz,
  last_error           text,
  last_smtp_code       integer,
  provider_message_id  text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  UNIQUE (app_id, idempotency_key)
);

CREATE INDEX messages_ready_idx ON messages (priority, next_attempt_at)
  WHERE status IN ('queued', 'deferred');
CREATE INDEX messages_stale_lease_idx ON messages (locked_until)
  WHERE status = 'sending';
CREATE INDEX messages_app_created_idx ON messages (app_id, created_at);

CREATE TABLE delivery_attempts (
  id             bigserial PRIMARY KEY,
  message_id     uuid NOT NULL REFERENCES messages(id),
  attempt        integer NOT NULL,
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz NOT NULL DEFAULT now(),
  outcome        text NOT NULL,               -- sent | temporary | permanent
  smtp_code      integer,
  smtp_response  text
);
CREATE INDEX delivery_attempts_message_idx ON delivery_attempts (message_id);

CREATE TABLE suppressions (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  email       text NOT NULL,                  -- always stored lowercased
  reason      text NOT NULL,                  -- hard_bounce | complaint | unsubscribe | manual
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, email)
);

CREATE TABLE rate_counters (
  app_id        uuid NOT NULL REFERENCES apps(id),
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL,
  PRIMARY KEY (app_id, window_start)
);
