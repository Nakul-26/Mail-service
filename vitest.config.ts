import { defineConfig } from 'vitest/config';

// Unit tests need no database, AWS or SMTP server; these placeholders satisfy config parsing.
// Integration tests (test/integration, `npm run test:integration`) use a real database.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**', 'node_modules/**'],
    env: {
      DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
      UNSUBSCRIBE_SECRET: 'unit-test-unsubscribe-secret-0123456789',
      BOUNCE_SECRET: 'unit-test-bounce-secret-0123456789abcdef',
      SMTP_ROUTES: 'postfix',
      SMTP_POSTFIX_KIND: 'postfix',
      SMTP_POSTFIX_HOST: 'postfix',
      SMTP_POSTFIX_PORT: '25',
      SMTP_POSTFIX_REQUIRE_TLS: 'false',
      SMTP_POSTFIX_VERP_DOMAIN: 'bounces.example.com',
      DEFAULT_ROUTE: 'postfix',
    },
  },
});
