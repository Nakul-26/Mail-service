import { describe, expect, it } from 'vitest';
import { isRecipientAllowed } from '../src/recipients.js';

describe('isRecipientAllowed', () => {
  it('allows anyone without a list', () => {
    expect(isRecipientAllowed('a@b.com', null)).toBe(true);
  });

  it('matches exact addresses and whole domains, case-insensitively', () => {
    const list = ['demo1@gmail.com', '@demo.example.com'];
    expect(isRecipientAllowed('Demo1@Gmail.com', list)).toBe(true);
    expect(isRecipientAllowed('anyone@demo.example.com', list)).toBe(true);
    expect(isRecipientAllowed('demo2@gmail.com', list)).toBe(false);
    expect(isRecipientAllowed('x@sub.demo.example.com', list)).toBe(false);
  });

  it('blocks everything with an empty list', () => {
    expect(isRecipientAllowed('a@b.com', [])).toBe(false);
  });
});
