import { describe, expect, it } from 'vitest';
import { parseVerp, verpAddress } from '../src/verp.js';

const SECRET = 'x'.repeat(40);
const ID = '6f1c2b3a-1111-4222-8333-944445555666';

describe('VERP return paths', () => {
  it('round-trip, including through case changes and angle brackets', () => {
    const addr = verpAddress(ID, 'bounces.example.com', SECRET);
    expect(addr).toMatch(/^bounce\+6f1c2b3a111142228333944445555666-[0-9a-f]{12}@bounces\.example\.com$/);
    expect(addr.split('@')[0]!.length).toBeLessThanOrEqual(64);
    expect(parseVerp(addr, SECRET)).toBe(ID);
    expect(parseVerp(`<${addr.toUpperCase()}>`, SECRET)).toBe(ID);
  });

  it('reject made-up or altered addresses', () => {
    const addr = verpAddress(ID, 'bounces.example.com', SECRET);
    expect(parseVerp(addr.replace('6f1c2b3a', '00000000'), SECRET)).toBeNull();
    expect(parseVerp(addr, 'y'.repeat(40))).toBeNull();
    expect(parseVerp('bounce+abc-def@bounces.example.com', SECRET)).toBeNull();
    expect(parseVerp('postmaster@bounces.example.com', SECRET)).toBeNull();
  });
});
