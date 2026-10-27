// Sender domains: DKIM keys, the DNS records to publish, and verification.
//
//   npm run domain -- add <domain> [--selector s2026] [--ip <server IPv4>] [--bounce-domain <d>] [--mail-host <h>]
//   npm run domain -- records <domain> [--ip ...] [--bounce-domain ...] [--mail-host ...]
//   npm run domain -- verify <domain> [--ip <server IPv4>]
//   npm run domain -- list
//
// Private keys are written to DKIM_KEYS_DIR/<domain>/<selector>.private (mode 0600) and never printed.
import { generateKeyPairSync } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { audit } from '../src/audit.js';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';

const [command, domainArg, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function txtChunks(value: string) {
  // DNS TXT strings are limited to 255 bytes; long DKIM keys are split into several quoted strings.
  return (value.match(/.{1,250}/g) ?? []).map((c) => `"${c}"`).join(' ');
}

function printRecords(domain: string, selector: string, publicKey: string) {
  const ip = flag('ip') ?? '<SERVER_PUBLIC_IPV4>';
  const bounce = flag('bounce-domain') ?? `bounces.${domain}`;
  const mailHost = flag('mail-host') ?? `mail.${domain}`;
  const rows = [
    ['# Signing key (DKIM)', '', ''],
    [`${selector}._domainkey.${domain}.`, 'TXT', txtChunks(`v=DKIM1; k=rsa; p=${publicKey}`)],
    ['# Who may send for the From domain (SPF); "-all" rejects everyone else', '', ''],
    [`${domain}.`, 'TXT', `"v=spf1 ip4:${ip} -all"`],
    ['# Policy for failures (DMARC). Start with p=none, move to quarantine/reject after reviewing reports', '', ''],
    [`_dmarc.${domain}.`, 'TXT', `"v=DMARC1; p=none; adkim=s; aspf=r; rua=mailto:dmarc-reports@${domain}"`],
    ['# Return-path (VERP) domain: SPF is checked against it, and bounces are delivered to it', '', ''],
    [`${bounce}.`, 'TXT', `"v=spf1 ip4:${ip} -all"`],
    [`${bounce}.`, 'MX', `10 ${mailHost}.`],
    ['# The server itself: forward DNS here, reverse DNS (PTR) with whoever owns the IP', '', ''],
    [`${mailHost}.`, 'A', ip],
    [`PTR for ${ip}`, 'PTR', `${mailHost}.   <- ask the IP owner (college network / ISP)`],
  ];
  for (const [name, type, value] of rows) console.log(type ? `${name!.padEnd(44)} ${type!.padEnd(4)} ${value}` : `\n${name}`);
  console.log(`\nSet POSTFIX_HOSTNAME=${mailHost}, SMTP_POSTFIX_VERP_DOMAIN=${bounce}, POSTFIX_BOUNCE_DOMAINS=${bounce}`);
  console.log('Note: if the domain already has an SPF record, merge "ip4:..." into it; never publish two SPF records.');
}

async function add(domain: string) {
  const selector = flag('selector') ?? `s${new Date().toISOString().slice(0, 7).replace('-', '')}`;
  if (!/^[a-z0-9-]{1,63}$/.test(selector)) throw new Error(`invalid selector "${selector}"`);
  const existing = await pool.query('SELECT dkim_selector FROM sender_domains WHERE domain = $1', [domain]);
  if (existing.rows[0]) throw new Error(`${domain} already exists (selector ${existing.rows[0].dkim_selector}); use "records" to show its DNS records`);

  const dir = join(config.DKIM_KEYS_DIR, domain);
  const file = join(dir, `${selector}.private`);
  if (existsSync(file)) throw new Error(`${file} already exists; refusing to overwrite a private key`);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });

  await pool.query('INSERT INTO sender_domains (domain, dkim_selector, dkim_public) VALUES ($1, $2, $3)', [domain, selector, pub]);
  await audit(pool, 'domain.add', domain, { selector });
  console.log(`Created DKIM key ${file} (keep it secret, back it up).\nPublish these DNS records, then run: npm run domain -- verify ${domain}`);
  printRecords(domain, selector, pub);
}

async function records(domain: string) {
  const { rows } = await pool.query('SELECT dkim_selector, dkim_public FROM sender_domains WHERE domain = $1', [domain]);
  if (!rows[0]) throw new Error(`unknown domain ${domain}; add it first`);
  printRecords(domain, rows[0].dkim_selector, rows[0].dkim_public);
}

async function txt(name: string): Promise<string[]> {
  try {
    return (await dns.resolveTxt(name)).map((parts) => parts.join(''));
  } catch {
    return [];
  }
}

async function verify(domain: string) {
  const { rows } = await pool.query('SELECT dkim_selector, dkim_public FROM sender_domains WHERE domain = $1', [domain]);
  if (!rows[0]) throw new Error(`unknown domain ${domain}; add it first`);
  const { dkim_selector: selector, dkim_public: pub } = rows[0];
  const ip = flag('ip');

  const dkimTxt = await txt(`${selector}._domainkey.${domain}`);
  const spf = (await txt(domain)).filter((t) => t.toLowerCase().startsWith('v=spf1'));
  // DMARC applies from the domain itself or a parent (the organizational domain, e.g. college.ac.in).
  let dmarc: string[] = [];
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1 && !dmarc.some((t) => t.startsWith('v=DMARC1')); i++) {
    dmarc = await txt(`_dmarc.${labels.slice(i).join('.')}`);
  }

  const checks = {
    dkim: dkimTxt.some((t) => t.replace(/\s+/g, '').includes(`p=${pub}`)),
    spf_single_record: spf.length === 1,
    spf_includes_server_ip: ip ? spf.some((t) => t.includes(`ip4:${ip}`)) : null,
    dmarc: dmarc.some((t) => t.startsWith('v=DMARC1')),
  };
  for (const [name, ok] of Object.entries(checks)) {
    console.log(`${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${name}${ok === null ? ' (pass --ip to check)' : ''}`);
  }
  const passed = Object.values(checks).every((v) => v !== false);
  await pool.query(
    `UPDATE sender_domains SET last_check = $2, verified_at = CASE WHEN $3 THEN COALESCE(verified_at, now()) ELSE NULL END WHERE domain = $1`,
    [domain, JSON.stringify({ at: new Date().toISOString(), checks }), passed],
  );
  await audit(pool, 'domain.verify', domain, { passed, checks });
  console.log(passed ? `\n${domain} is verified; apps may send from it.` : `\n${domain} is NOT verified; apps cannot send from it yet. DNS changes can take a while to appear.`);
  if (!passed) process.exitCode = 2;
}

async function list() {
  const { rows } = await pool.query('SELECT domain, dkim_selector, verified_at, created_at FROM sender_domains ORDER BY domain');
  for (const r of rows) console.log(`${r.domain.padEnd(36)} selector=${r.dkim_selector}  ${r.verified_at ? `verified ${r.verified_at.toISOString()}` : 'NOT verified'}`);
  if (!rows.length) console.log('no sender domains yet');
}

try {
  const domain = domainArg?.toLowerCase();
  if (command !== 'list' && (!domain || !DOMAIN.test(domain))) throw new Error('usage: npm run domain -- add|records|verify <domain> [options] | list');
  if (command === 'add') await add(domain!);
  else if (command === 'records') await records(domain!);
  else if (command === 'verify') await verify(domain!);
  else if (command === 'list') await list();
  else throw new Error(`unknown command "${command}"`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
