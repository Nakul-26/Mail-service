import { describe, expect, it } from 'vitest';
import { signUnsubscribe, verifyUnsubscribe } from '../src/unsubscribe.js';

const secret = 'x'.repeat(32);
const target = { tenantId: 't1', email: 'a@b.com', topic: 'alumni-newsletter' };

describe('unsubscribe tokens', () => {
  it('round-trip', () => {
    expect(verifyUnsubscribe(signUnsubscribe(target, secret), secret)).toEqual(target);
  });

  it('reject tampering and the wrong secret', () => {
    const token = signUnsubscribe(target, secret);
    const forged = Buffer.from(JSON.stringify(['t1', 'victim@b.com', 'alumni-newsletter'])).toString('base64url');
    expect(verifyUnsubscribe(`${forged}.${token.split('.')[1]}`, secret)).toBeNull();
    expect(verifyUnsubscribe(token, 'y'.repeat(32))).toBeNull();
    expect(verifyUnsubscribe('garbage', secret)).toBeNull();
  });
});
