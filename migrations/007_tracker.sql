-- Postfix log tracking. The tracker reads Postfix's log file and stores what it found *before*
-- moving its read position, so a restart neither loses nor double-applies events.

CREATE TABLE tracker_state (
  name         text PRIMARY KEY,          -- e.g. 'postfix-log'
  file_id      text NOT NULL,             -- inode/device of the file the offset belongs to
  file_offset  bigint NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Postfix queue id -> our message, from "cleanup: message-id=<uuid@domain>" lines.
CREATE TABLE mta_queue_map (
  queue_id    text PRIMARY KEY,
  message_id  uuid NOT NULL REFERENCES messages(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Delivery lines waiting to be applied (their message may still be mid-hand-off).
CREATE TABLE mta_log_events (
  id            bigserial PRIMARY KEY,
  source_key    text NOT NULL UNIQUE,     -- file id + byte offset of the line
  queue_id      text NOT NULL,
  event         jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  result        text
);
CREATE INDEX mta_log_events_pending_idx ON mta_log_events (created_at) WHERE processed_at IS NULL;
