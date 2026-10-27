import { describe, expect, it } from 'vitest';
import { loadRoutes, nextHopMessageId } from '../src/smtp.js';
import { TokenBucket } from '../src/token-bucket.js';

describe('route configuration', () => {
  it('works with only a self-hosted Postfix route: no AWS or SES settings', () => {
    const env = {
      SMTP_ROUTES: 'postfix',
      SMTP_POSTFIX_KIND: 'postfix',
      SMTP_POSTFIX_HOST: 'postfix',
      SMTP_POSTFIX_PORT: '25',
      SMTP_POSTFIX_VERP_DOMAIN: 'bounces.example.com',
    };
    const r = loadRoutes(env).get('postfix')!;
    expect(r).toMatchObject({ kind: 'postfix', verpDomain: 'bounces.example.com', requireDkim: true });
    expect(r.sesConfigurationSet).toBeUndefined();
    r.transport.close();
  });

  it('rejects a postfix route without a bounce domain', () => {
    expect(() => loadRoutes({ SMTP_ROUTES: 'postfix', SMTP_POSTFIX_KIND: 'postfix', SMTP_POSTFIX_HOST: 'p' })).toThrow(
      'SMTP_POSTFIX_VERP_DOMAIN: required for KIND=postfix',
    );
  });

  it('reads the next hop id from Postfix and SES replies', () => {
    expect(nextHopMessageId('250 2.0.0 Ok: queued as 4ZqK1x2y3zz1Nk')).toBe('4ZqK1x2y3zz1Nk');
    expect(nextHopMessageId('250 Ok 0109019a2b3c4d5e-000000')).toBe('0109019a2b3c4d5e-000000');
    expect(nextHopMessageId('250 OK')).toBeUndefined();
  });
});

describe('TokenBucket (bulk lane)', () => {
  it('limits the average rate and refunds unused tokens', () => {
    const b = new TokenBucket(10, 10);
    const t0 = Date.now();
    expect(b.take(100, t0)).toBe(10);
    expect(b.take(100, t0)).toBe(0);
    expect(b.take(100, t0 + 500)).toBe(5);
    b.refund(3);
    expect(b.take(100, t0 + 500)).toBe(3);
  });
});
