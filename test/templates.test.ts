import { describe, expect, it } from 'vitest';
import { metaSchema, render, templates, validateVariables } from '../src/templates.js';

const otp = templates.get('exam-otp')!;

describe('templates', () => {
  it('loads the sample templates', () => {
    expect(otp.meta.sensitive).toEqual(['otp']);
    expect(templates.get('exam-instructions')?.meta.priority).toBe(1);
  });

  it('rejects missing and unknown variables', () => {
    expect(validateVariables(otp, { name: 'A', extra: 1 })).toEqual([
      'missing variable "otp"',
      'missing variable "expiresInMinutes"',
      'unknown variable "extra"',
    ]);
  });

  it('escapes HTML in the html part only', () => {
    const out = render(otp, { name: '<b>Asha</b>', otp: '123456', expiresInMinutes: 10 });
    expect(out.html).toContain('&lt;b&gt;Asha&lt;/b&gt;');
    expect(out.text).toContain('Hi <b>Asha</b>');
    expect(out.subject).toBe('Your exam login code: 123456');
  });

  it('renders with optional variables omitted', () => {
    const t = templates.get('exam-instructions')!;
    const out = render(t, { name: 'A', examName: 'Maths', startsAt: '10:00', examUrl: 'https://x' });
    expect(out.text).not.toContain('undefined');
  });
});

describe('marketing templates', () => {
  const base = { description: 'x', products: ['alumni'], required: [] };

  it('require a topic and bulk priority', () => {
    expect(metaSchema.safeParse({ ...base, category: 'marketing', priority: 2 }).success).toBe(false);
    expect(metaSchema.safeParse({ ...base, category: 'marketing', topic: 'news', priority: 0 }).success).toBe(false);
    expect(metaSchema.safeParse({ ...base, category: 'marketing', topic: 'news', priority: 2 }).success).toBe(true);
  });

  it('reserve the unsubscribe variable', () => {
    const newsletter = templates.get('alumni-newsletter')!;
    expect(newsletter.meta.topic).toBe('alumni-newsletter');
    expect(validateVariables(newsletter, { name: 'A', title: 'T', message: 'M', unsubscribeUrl: 'x' }))
      .toEqual(['unknown variable "unsubscribeUrl"']);
  });
});
