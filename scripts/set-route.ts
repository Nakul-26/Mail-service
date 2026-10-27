// Usage: npm run set-route -- <tenant> <app-name> <route|default>
// Points an app at one of the SMTP routes in SMTP_ROUTES. "default" clears it back to DEFAULT_ROUTE.
// Takes effect on the next send attempt, including messages already queued.
import { pool } from '../src/db.js';
import { closeRoutes, defaultRoute, routes } from '../src/smtp.js';

const [tenantName, appName, route] = process.argv.slice(2);
try {
  if (!tenantName || !appName || !route) {
    throw new Error('usage: npm run set-route -- <tenant> <app-name> <route|default>');
  }
  if (route !== 'default' && !routes.has(route)) {
    throw new Error(`unknown route "${route}"; configured: ${[...routes.keys()].join(', ')}`);
  }
  const { rowCount } = await pool.query(
    `UPDATE apps SET route = $3
      WHERE name = $2 AND tenant_id = (SELECT id FROM tenants WHERE name = $1)`,
    [tenantName, appName, route === 'default' ? null : route],
  );
  if (!rowCount) throw new Error(`no app "${appName}" in tenant "${tenantName}"`);
  console.log(`${tenantName}/${appName} now sends via ${route === 'default' ? `${defaultRoute} (default)` : route}`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  closeRoutes();
  await pool.end();
}
