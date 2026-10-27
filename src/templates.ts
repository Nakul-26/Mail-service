import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Handlebars from 'handlebars';
import { z } from 'zod';

/** Filled in by the worker for marketing mail; callers may not supply it. */
export const UNSUBSCRIBE_VAR = 'unsubscribeUrl';

export const metaSchema = z
  .object({
    description: z.string(),
    products: z.array(z.string()).min(1),
    // transactional: triggered by a user action or needed for the service (OTP, exam instructions).
    // marketing: newsletters and announcements a recipient can unsubscribe from, per topic.
    category: z.enum(['transactional', 'marketing']).default('transactional'),
    topic: z.string().regex(/^[a-z0-9-]+$/).optional(),
    priority: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    required: z.array(z.string()).default([]),
    optional: z.array(z.string()).default([]),
    sensitive: z.array(z.string()).default([]),
  })
  .superRefine((m, ctx) => {
    if (m.category === 'marketing') {
      if (!m.topic) ctx.addIssue({ code: 'custom', message: 'marketing templates need a "topic"' });
      if (m.priority !== 2) ctx.addIssue({ code: 'custom', message: 'marketing templates must use priority 2' });
    } else if (m.topic) {
      ctx.addIssue({ code: 'custom', message: '"topic" is only for marketing templates' });
    }
    if ([...m.required, ...m.optional].includes(UNSUBSCRIBE_VAR)) {
      ctx.addIssue({ code: 'custom', message: `"${UNSUBSCRIBE_VAR}" is reserved` });
    }
  });

export interface Template {
  id: string;
  meta: z.infer<typeof metaSchema>;
  subject: Handlebars.TemplateDelegate;
  html: Handlebars.TemplateDelegate;
  text: Handlebars.TemplateDelegate;
}

const dir = join(import.meta.dirname, '..', 'templates');

function load(): Map<string, Template> {
  const templates = new Map<string, Template>();
  for (const id of readdirSync(dir)) {
    const base = join(dir, id);
    if (!existsSync(join(base, 'meta.json'))) continue;
    const parsed = metaSchema.safeParse(JSON.parse(readFileSync(join(base, 'meta.json'), 'utf8')));
    if (!parsed.success) {
      throw new Error(`template "${id}": ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    const meta = parsed.data;
    const read = (f: string) => readFileSync(join(base, f), 'utf8');
    const html = read('html.hbs');
    const text = read('text.hbs');
    if (meta.category === 'marketing' && !(html.includes(UNSUBSCRIBE_VAR) && text.includes(UNSUBSCRIBE_VAR))) {
      throw new Error(`template "${id}": marketing templates must show {{${UNSUBSCRIBE_VAR}}} in html and text`);
    }
    templates.set(id, {
      id,
      meta,
      // Subject and text are plain text, so no HTML escaping; HTML escapes by default.
      subject: Handlebars.compile(read('subject.hbs').trim(), { strict: true, noEscape: true }),
      html: Handlebars.compile(html, { strict: true }),
      text: Handlebars.compile(text, { strict: true, noEscape: true }),
    });
  }
  return templates;
}

export const templates = load();

/** Returns a list of problems with the supplied variables, or [] if valid. */
export function validateVariables(t: Template, vars: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const known = new Set([...t.meta.required, ...t.meta.optional]);
  for (const name of t.meta.required) {
    if (vars[name] === undefined || vars[name] === null || vars[name] === '') problems.push(`missing variable "${name}"`);
  }
  for (const name of Object.keys(vars)) {
    if (!known.has(name)) problems.push(`unknown variable "${name}"`);
  }
  return problems;
}

export function render(t: Template, vars: Record<string, unknown>) {
  // strict mode throws on missing optionals, so default them to empty.
  const data = { ...Object.fromEntries(t.meta.optional.map((k) => [k, ''])), ...vars };
  // A variable containing CR/LF must not be able to start a new header line via the subject.
  const subject = t.subject(data).replace(/[\r\n]+/g, ' ').trim().slice(0, 998);
  return { subject, html: t.html(data), text: t.text(data) };
}
