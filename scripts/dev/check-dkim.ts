// TEST ONLY: verifies the DKIM signature of every message fake-mx received, against the public key
// stored by `domain add` (standing in for the DNS record), and checks the VERP return path.
//   npx tsx scripts/dev/check-dkim.ts <fake-mx url> <domain> <selector> <base64 public key>
import { dkimVerify } from 'mailauth/lib/dkim/verify.js';

const [url, domain, selector, publicKey] = process.argv.slice(2);
if (!url || !domain || !selector || !publicKey) throw new Error('usage: check-dkim <url> <domain> <selector> <public key>');

const resolver = async (name: string, type: string) => {
  if (type === 'TXT' && name === `${selector}._domainkey.${domain}`) return [[`v=DKIM1; k=rsa; p=${publicKey}`]];
  throw Object.assign(new Error(`no record for ${name}`), { code: 'ENOTFOUND' });
};

const messages = (await (await fetch(`${url}/messages`)).json()) as { mailFrom: string; to: string[]; raw: string }[];
let pass = 0;
const problems: string[] = [];
for (const m of messages) {
  const result = await dkimVerify(Buffer.from(m.raw), { resolver });
  const r = result.results.find((x: { signingDomain?: string }) => x.signingDomain === domain);
  if (r?.status?.result === 'pass') pass++;
  else problems.push(`${m.to.join(',')}: DKIM ${r?.status?.result ?? 'missing'}`);
  if (!/^bounce\+[0-9a-f]{32}-[0-9a-f]{12}@/.test(m.mailFrom)) problems.push(`${m.to.join(',')}: return path ${m.mailFrom} is not VERP`);
  if (/^X-SES-/im.test(m.raw)) problems.push(`${m.to.join(',')}: SES header present`);
}
console.log(JSON.stringify({ received: messages.length, dkimPass: pass, problems: problems.slice(0, 20) }));
process.exitCode = problems.length ? 1 : 0;
