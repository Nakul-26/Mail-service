// Pure delivery policy: error classification and retry timing. No I/O here so it is unit-testable.

export type Outcome =
  | { kind: 'temporary'; code?: number; response: string }
  | { kind: 'permanent'; code?: number; response: string; suppressRecipient: boolean };

interface SmtpError {
  responseCode?: number;
  command?: string;
  response?: string;
  message?: string;
  code?: string;
}

export function classifySmtpError(err: unknown): Outcome {
  const e = (err ?? {}) as SmtpError;
  const response = (e.response || e.message || e.code || String(err)).slice(0, 1000);
  const code = typeof e.responseCode === 'number' ? e.responseCode : undefined;
  const command = (e.command ?? '').toUpperCase();

  // A 5xx is only about *this message* when it rejects the recipient or the content.
  // 5xx on AUTH / MAIL FROM / connect means our relay setup is broken: keep retrying
  // (and alert) rather than permanently failing every queued message.
  if (code !== undefined && code >= 500 && code < 600) {
    if (command.startsWith('RCPT')) return { kind: 'permanent', code, response, suppressRecipient: true };
    if (command === 'DATA') return { kind: 'permanent', code, response, suppressRecipient: false };
  }
  return { kind: 'temporary', code, response };
}

/** Exponential backoff with jitter: ~30s, 1m, 2m, 4m ... capped at 1h. */
export function retryDelayMs(attempt: number, random = Math.random): number {
  const base = 30_000 * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(base, 60 * 60_000);
  return Math.round(capped * (0.5 + random() * 0.5));
}
