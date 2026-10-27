-- Finer delivery states for self-hosted delivery.
--   accepted_local   the first SMTP hop (our Postfix, or a configured relay) accepted the message
--   mta_deferred     Postfix is retrying; our worker must NOT resend it
--   accepted_remote  the recipient's mail server accepted it (Postfix status=sent, or SES Delivery)
--   delivered        only with real evidence: a DSN with Action: delivered
--   rejected         the recipient's server refused it for policy/spam reasons (5.7.x)
--   cancelled        a pending batch message was cancelled
ALTER TYPE message_status RENAME VALUE 'sent' TO 'accepted_local';
ALTER TYPE message_status ADD VALUE 'mta_deferred';
ALTER TYPE message_status ADD VALUE 'accepted_remote';
ALTER TYPE message_status ADD VALUE 'rejected';
ALTER TYPE message_status ADD VALUE 'cancelled';

ALTER TABLE messages ADD COLUMN accepted_remote_at timestamptz;

-- Status only moves forward. Events can arrive late, twice, or out of order (a log line before the
-- worker has recorded the hand-off); updates use status_rank() so they never undo progress.
-- Compared as text because new enum values can't be used in the transaction that adds them.
CREATE FUNCTION status_rank(s message_status) RETURNS int
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE s::text
    WHEN 'queued' THEN 0
    WHEN 'deferred' THEN 1
    WHEN 'sending' THEN 1
    WHEN 'accepted_local' THEN 2
    WHEN 'mta_deferred' THEN 3
    WHEN 'accepted_remote' THEN 4
    WHEN 'delivered' THEN 5
    ELSE 6 -- bounced, rejected, failed, suppressed, cancelled: final
  END
$$;
