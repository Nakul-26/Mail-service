import type { SendMailOptions } from 'nodemailer';
import type { DkimKey } from './dkim.js';
import type { Route } from './smtp.js';
import { render, UNSUBSCRIBE_VAR, type Template } from './templates.js';
import { signUnsubscribe } from './unsubscribe.js';
import { verpAddress } from './verp.js';

export interface ComposeJob {
  id: string;
  tenant_id: string;
  from_addr: string;
  to_addr: string;
  variables: Record<string, unknown>;
  category: 'transactional' | 'marketing';
  topic: string | null;
}

export interface ComposeOptions {
  publicBaseUrl: string;
  unsubscribeSecret: string;
  bounceSecret?: string;
  dkim: DkimKey | null;
}

export type Composed = { ok: true; mail: SendMailOptions } | { ok: false; error: string };

/** Builds the exact message the worker hands to the route. Pure, so it is unit-tested directly. */
export function composeMail(
  job: ComposeJob,
  route: Pick<Route, 'kind' | 'verpDomain' | 'requireDkim' | 'sesConfigurationSet'>,
  template: Template,
  opts: ComposeOptions,
): Composed {
  const fromDomain = job.from_addr.split('@')[1]!.toLowerCase();
  if (route.requireDkim && !opts.dkim) {
    return { ok: false, error: `no DKIM key for ${fromDomain}; add one with: npm run domain -- add ${fromDomain}` };
  }

  const headers: Record<string, string> = { 'X-Eclipse-Message-Id': job.id };
  let variables = job.variables;
  if (job.category === 'marketing' && job.topic) {
    const token = signUnsubscribe({ tenantId: job.tenant_id, email: job.to_addr, topic: job.topic }, opts.unsubscribeSecret);
    const unsubscribeUrl = `${opts.publicBaseUrl.replace(/\/$/, '')}/u/${token}`;
    variables = { ...variables, [UNSUBSCRIBE_VAR]: unsubscribeUrl };
    // RFC 8058 one-click unsubscribe, required by Gmail and Yahoo for bulk senders.
    headers['List-Unsubscribe'] = `<${unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  if (route.sesConfigurationSet) {
    // SES strips these before delivery. The tag lets /webhooks/ses match events to this message.
    headers['X-SES-CONFIGURATION-SET'] = route.sesConfigurationSet;
    headers['X-SES-MESSAGE-TAGS'] = `eclipse_id=${job.id}`;
  }

  const content = render(template, variables);
  const mail: SendMailOptions = {
    from: job.from_addr,
    to: job.to_addr,
    ...content,
    // Our id in the Message-ID lets Postfix's log (cleanup: message-id=<...>) be matched to this row.
    messageId: `<${job.id}@${fromDomain}>`,
    headers,
  };
  if (route.verpDomain && opts.bounceSecret) {
    mail.envelope = { from: verpAddress(job.id, route.verpDomain, opts.bounceSecret), to: job.to_addr };
  }
  if (opts.dkim) {
    mail.dkim = { ...opts.dkim, headerFieldNames: 'from:to:subject:date:message-id:list-unsubscribe:list-unsubscribe-post' };
  }
  return { ok: true, mail };
}
