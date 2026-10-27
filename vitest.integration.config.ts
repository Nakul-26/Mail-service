import { defineConfig } from 'vitest/config';

// Integration tests: real PostgreSQL (TEST_DATABASE_URL, default: the dev compose database on :5440,
// in a separate "mail_test" database that is wiped on every run). No AWS, SES or internet access.
//   docker compose up -d --wait postgres && npm run test:integration
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://mail:mail@localhost:5440/mail_test';

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      TEST_DATABASE_URL,
      DATABASE_URL: TEST_DATABASE_URL,
      UNSUBSCRIBE_SECRET: 'integration-unsubscribe-secret-0123456789',
      BOUNCE_SECRET: 'integration-bounce-secret-0123456789abcdef',
      // A relay route pointing at the SMTP stub the worker tests start; no external servers.
      SMTP_ROUTES: 'stub',
      SMTP_STUB_KIND: 'relay',
      SMTP_STUB_HOST: '127.0.0.1',
      SMTP_STUB_PORT: '2599',
      SMTP_STUB_REQUIRE_TLS: 'false',
      SMTP_STUB_VERP_DOMAIN: 'bounces.test.example',
      DEFAULT_ROUTE: 'stub',
      ALLOW_UNVERIFIED_SENDER_DOMAINS: 'false',
      DKIM_KEYS_DIR: './test/integration/.dkim',
      BULK_RATE_PER_SECOND: '1000',
      WORKER_POLL_MS: '200',
    },
  },
});
