import { open, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pool } from './db.js';
import { classifyPermanentFailure, recordEvent, type DeliveryEvent } from './events.js';
import { parsePostfixLine, type PostfixLogEvent } from './postfix-log.js';

// Follows Postfix's log file and turns delivery lines into message events.
//
// 1. ingest(): read new complete lines; in ONE transaction store queue-id mappings and delivery
//    lines, and advance the saved offset. A crash before commit re-reads the same lines; the
//    unique source_key makes that harmless.
// 2. applyPending(): apply stored lines whose message is known and past 'sending'.

const STATE = 'postfix-log';
const MAX_READ = 4 * 1024 * 1024;
const ORPHAN_AFTER = '1 hour';

export async function ingest(file: string): Promise<number> {
  let info;
  try {
    info = await stat(file);
  } catch {
    return 0; // Postfix hasn't written anything yet
  }
  const fileId = `${info.dev}:${info.ino}`;
  const saved = await pool.query('SELECT file_id, file_offset FROM tracker_state WHERE name = $1', [STATE]);
  const prev = saved.rows[0];
  if (prev && prev.file_id !== fileId) {
    // The log was rotated (postfix logrotate renames it). Finish the old file first, so lines
    // written just before the rotation are not lost.
    const old = await findByFileId(file, prev.file_id);
    if (old && Number(prev.file_offset) < old.size) {
      return readFrom(old.path, prev.file_id, Number(prev.file_offset), old.size);
    }
  }
  let offset = 0;
  if (prev?.file_id === fileId && Number(prev.file_offset) <= info.size) {
    offset = Number(prev.file_offset);
  } // else: new file (or truncated), start at its beginning
  if (offset >= info.size) {
    if (prev?.file_id !== fileId) await saveOffset(fileId, offset);
    return 0;
  }
  return readFrom(file, fileId, offset, info.size);
}

async function findByFileId(file: string, fileId: string) {
  const dir = dirname(file);
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith(basename(file))) continue;
    const s = await stat(join(dir, name)).catch(() => null);
    if (s && `${s.dev}:${s.ino}` === fileId) return { path: join(dir, name), size: s.size };
  }
  return null;
}

async function saveOffset(fileId: string, offset: number) {
  await pool.query(
    `INSERT INTO tracker_state (name, file_id, file_offset) VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET file_id = $2, file_offset = $3, updated_at = now()`,
    [STATE, fileId, offset],
  );
}

async function readFrom(file: string, fileId: string, offset: number, size: number): Promise<number> {

  const fh = await open(file, 'r');
  let chunk: Buffer;
  try {
    const length = Math.min(size - offset, MAX_READ);
    chunk = Buffer.alloc(length);
    await fh.read(chunk, 0, length, offset);
  } finally {
    await fh.close();
  }
  // Only complete lines; a partly written last line is read next time.
  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline < 0) return 0;

  const client = await pool.connect();
  let lines = 0;
  try {
    await client.query('BEGIN');
    let pos = 0;
    while (pos <= lastNewline) {
      const end = chunk.indexOf(0x0a, pos);
      const line = chunk.subarray(pos, end).toString('utf8');
      const lineOffset = offset + pos;
      pos = end + 1;
      lines++;
      const ev = parsePostfixLine(line);
      if (!ev) continue;
      if (ev.kind === 'message-id') {
        await client.query(
          `INSERT INTO mta_queue_map (queue_id, message_id)
           SELECT $1, id FROM messages WHERE id = $2
           ON CONFLICT (queue_id) DO NOTHING`,
          [ev.queueId, ev.messageId],
        );
      } else {
        // Only lines about our messages. Postfix logs its "cleanup: message-id" line before any
        // delivery line, so the mapping exists by now; other mail (e.g. Postfix's own bounce notices
        // to the bounce receiver) is skipped instead of piling up as orphans.
        await client.query(
          `INSERT INTO mta_log_events (source_key, queue_id, event)
           SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM mta_queue_map WHERE queue_id = $2)
           ON CONFLICT (source_key) DO NOTHING`,
          [`${fileId}@${lineOffset}`, ev.queueId, JSON.stringify(ev)],
        );
      }
    }
    await client.query(
      `INSERT INTO tracker_state (name, file_id, file_offset) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET file_id = $2, file_offset = $3, updated_at = now()`,
      [STATE, fileId, offset + lastNewline + 1],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return lines;
}

export async function applyPending(limit = 500): Promise<Record<string, number>> {
  const { rows } = await pool.query(
    `SELECT e.id, e.source_key, e.event, e.created_at, q.message_id,
            e.created_at < now() - interval '${ORPHAN_AFTER}' AS stale
       FROM mta_log_events e LEFT JOIN mta_queue_map q ON q.queue_id = e.queue_id
      WHERE e.processed_at IS NULL
      ORDER BY e.id
      LIMIT $1`,
    [limit],
  );
  const counts: Record<string, number> = {};
  for (const row of rows) {
    let result: string;
    if (!row.message_id) {
      // Not one of ours (e.g. a bounce notice Postfix generated), or its mapping line was lost.
      if (!row.stale) continue;
      result = 'orphan';
    } else {
      result = await recordEvent(logEventToDeliveryEvent(row.event, row.message_id, row.source_key));
      if (result === 'not_ready') {
        counts[result] = (counts[result] ?? 0) + 1;
        continue;
      }
    }
    await pool.query('UPDATE mta_log_events SET processed_at = now(), result = $2 WHERE id = $1', [row.id, result]);
    counts[result] = (counts[result] ?? 0) + 1;
  }
  return counts;
}

export function logEventToDeliveryEvent(ev: PostfixLogEvent, messageId: string, sourceKey: string): DeliveryEvent {
  const base = { messageId, source: 'postfix-log' as const, sourceEventId: sourceKey, detail: ev };
  if (ev.kind === 'expired') {
    return { ...base, type: 'expired', status: 'failed', error: 'expired in the Postfix queue (retries exhausted)' };
  }
  if (ev.kind !== 'delivery') return { ...base, type: ev.kind };
  const summary = `${ev.dsn} ${ev.response}`;
  switch (ev.status) {
    case 'sent':
      // The recipient's server accepted the message. Not proof that it reached the inbox.
      return { ...base, type: 'remote_accepted', status: 'accepted_remote' };
    case 'deferred':
      return { ...base, type: 'deferred', status: 'mta_deferred', error: summary };
    case 'bounced': {
      const policy = classifyPermanentFailure(ev.dsn);
      return {
        ...base,
        type: policy.status === 'rejected' ? 'rejected' : 'bounced',
        status: policy.status,
        error: summary,
        suppress: policy.suppressAddress ? { scope: 'all', reason: 'hard_bounce', detail: summary } : undefined,
      };
    }
  }
}
