-- Which SMTP route (named in SMTP_ROUTES) each app sends through. NULL = DEFAULT_ROUTE.
ALTER TABLE apps ADD COLUMN route text;

-- Recorded per attempt so routes can be compared (e.g. SES vs self-hosted during the demo trial).
ALTER TABLE delivery_attempts ADD COLUMN route text;
ALTER TABLE messages ADD COLUMN route text;
