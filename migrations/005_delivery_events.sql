-- What happened after the relay accepted a message (SES delivery / bounce / complaint events).
ALTER TABLE messages ADD COLUMN delivered_at timestamptz;

CREATE TABLE message_events (
  id                 bigserial PRIMARY KEY,
  message_id         uuid NOT NULL REFERENCES messages(id),
  provider           text NOT NULL,            -- ses
  provider_event_id  text NOT NULL,            -- SNS MessageId; makes redelivered notifications no-ops
  event_type         text NOT NULL,            -- Delivery | Bounce | Complaint | DeliveryDelay | Reject | ...
  detail             jsonb NOT NULL,
  occurred_at        timestamptz,
  received_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX message_events_message_idx ON message_events (message_id);
CREATE INDEX messages_provider_message_idx ON messages (provider_message_id);
