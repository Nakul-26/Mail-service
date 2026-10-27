// Usage: npm run set-recipients -- <tenant> <app-name> <entry...>|any
// Restricts who an app may email: exact addresses or "@domain" entries. "any" removes the restriction.
// Example: npm run set-recipients -- "Demo College" demo-exams demo1@gmail.com @demo.example.com
import { audit } from '../src/audit.js';
import { pool } from '../src/db.js';

const [tenantName, appName, ...entries] = process.argv.slice(2);
try {
  if (!tenantName || !appName || entries.length === 0) {
    throw new Error('usage: npm run set-recipients -- <tenant> <app-name> <address|@domain ...>|any');
  }
  const list = entries.length === 1 && entries[0] === 'any' ? null : entries.map((e) => e.toLowerCase());
  for (const e of list ?? []) {
    if (!/^([^@\s]+@[^@\s]+\.[^@\s]+|@[^@\s]+\.[^@\s]+)$/.test(e)) throw new Error(`not an address or @domain: "${e}"`);
  }
  const { rowCount } = await pool.query(
    `UPDATE apps SET allowed_recipients = $3
      WHERE name = $2 AND tenant_id = (SELECT id FROM tenants WHERE name = $1)`,
    [tenantName, appName, list],
  );
  if (!rowCount) throw new Error(`no app "${appName}" in tenant "${tenantName}"`);
  await audit(pool, 'app.set_recipients', `${tenantName}/${appName}`, { allowedRecipients: list });
  console.log(`${tenantName}/${appName} may email: ${list ? list.join(', ') : 'anyone'}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
