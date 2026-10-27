import { describe, expect, it } from 'vitest';
import { classifySmtpError, retryDelayMs } from '../src/delivery.js';

describe('classifySmtpError', () => {
  it('treats a rejected recipient as permanent and suppresses it', () => {
    expect(classifySmtpError({ responseCode: 550, command: 'RCPT TO', response: '550 5.1.1 no such user' }))
      .toMatchObject({ kind: 'permanent', code: 550, suppressRecipient: true });
  });

  it('treats rejected content as permanent without suppressing the recipient', () => {
    expect(classifySmtpError({ responseCode: 554, command: 'DATA', response: '554 spam' }))
      .toMatchObject({ kind: 'permanent', suppressRecipient: false });
  });

  it('keeps retrying when our relay credentials are rejected', () => {
    expect(classifySmtpError({ responseCode: 535, command: 'AUTH PLAIN' }).kind).toBe('temporary');
  });

  it('treats 4xx and network errors as temporary', () => {
    expect(classifySmtpError({ responseCode: 421, command: 'RCPT TO' }).kind).toBe('temporary');
    expect(classifySmtpError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION' })).kind)
      .toBe('temporary');
  });
});

describe('retryDelayMs', () => {
  it('grows exponentially, stays within jitter bounds, and caps at one hour', () => {
    expect(retryDelayMs(1, () => 0)).toBe(15_000);
    expect(retryDelayMs(1, () => 1)).toBe(30_000);
    expect(retryDelayMs(3, () => 1)).toBe(120_000);
    expect(retryDelayMs(20, () => 1)).toBe(3_600_000);
  });
});
