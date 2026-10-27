import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// DKIM keys live outside the repo, in <DKIM_KEYS_DIR>/<domain>/<selector>.private (created by
// `npm run domain -- add`). The worker signs with nodemailer; Postfix only relays signed mail.
// If a domain has several keys (during rotation), the newest file is used.

export interface DkimKey {
  domainName: string;
  keySelector: string;
  privateKey: string;
}

const cache = new Map<string, { key: DkimKey | null; loadedAt: number }>();
const TTL_MS = 60_000;

export function dkimKeyFor(domain: string, dir: string): DkimKey | null {
  const d = domain.toLowerCase();
  const cacheKey = `${dir}\0${d}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.loadedAt < TTL_MS) return hit.key;
  const key = load(d, dir);
  cache.set(cacheKey, { key, loadedAt: Date.now() });
  return key;
}

function load(domain: string, dir: string): DkimKey | null {
  if (!/^[a-z0-9.-]+$/.test(domain) || domain.includes('..')) return null;
  const base = join(dir, domain);
  let files: string[];
  try {
    files = readdirSync(base).filter((f) => /^[a-z0-9-]+\.private$/i.test(f));
  } catch {
    return null;
  }
  const newest = files
    .map((f) => ({ f, mtime: statSync(join(base, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) return null;
  return {
    domainName: domain,
    keySelector: newest.f.replace(/\.private$/i, ''),
    privateKey: readFileSync(join(base, newest.f), 'utf8'),
  };
}
