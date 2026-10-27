import { setTimeout as sleep } from 'node:timers/promises';
import { createBounceReceiver } from './bounce-receiver.js';
import { config } from './config.js';
import { pool } from './db.js';
import { applyPending, ingest } from './log-tracker.js';

// Delivery tracking for the self-hosted route: follows Postfix's log and receives bounce mail.
// Runs as its own process (`npm run start:tracker`), next to the API and the worker.

let running = true;

async function followLog() {
  while (running) {
    try {
      const lines = await ingest(config.POSTFIX_LOG_FILE);
      const applied = await applyPending();
      if (Object.keys(applied).length) console.log('tracker:', JSON.stringify(applied));
      if (lines === 0) await sleep(1000);
    } catch (err) {
      console.error('tracker error', err);
      await sleep(5000);
    }
  }
}

if (!config.BOUNCE_SECRET) throw new Error('BOUNCE_SECRET is required for the tracker');
const receiver = createBounceReceiver(config.BOUNCE_SECRET);
receiver.on('error', (err) => console.error('bounce receiver error', err));
receiver.listen(config.BOUNCE_RECEIVER_PORT, config.BOUNCE_RECEIVER_HOST, () =>
  console.log(`tracker: following ${config.POSTFIX_LOG_FILE}; bounce receiver on :${config.BOUNCE_RECEIVER_PORT}`),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    running = false;
    receiver.close(() => {});
  });
}

await followLog();
await pool.end();
console.log('tracker stopped');
