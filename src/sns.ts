import { createVerify } from 'node:crypto';

// Amazon SNS HTTP(S) message verification.
// https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html

export interface SnsMessage {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  Signature: string;
  SignatureVersion: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
}

const NOTIFICATION_FIELDS = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] as const;
const SUBSCRIPTION_FIELDS = ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'] as const;

/** Only SNS's own HTTPS hosts may serve signing certificates or subscription URLs. */
export function isSnsUrl(url: string | undefined, path?: RegExp): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(u.hostname) &&
      (!path || path.test(u.pathname))
    );
  } catch {
    return false;
  }
}

export function stringToSign(msg: SnsMessage): string {
  const fields = msg.Type === 'Notification' ? NOTIFICATION_FIELDS : SUBSCRIPTION_FIELDS;
  let out = '';
  for (const f of fields) {
    const v = msg[f];
    if (v === undefined) continue; // Subject is optional
    out += `${f}\n${v}\n`;
  }
  return out;
}

export type CertFetcher = (url: string) => Promise<string>;

const certCache = new Map<string, string>();

export const fetchCert: CertFetcher = async (url) => {
  const cached = certCache.get(url);
  if (cached) return cached;
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`certificate fetch failed: ${res.status}`);
  const pem = await res.text();
  certCache.set(url, pem);
  return pem;
};

/** Throws unless the message is a well-formed, correctly signed SNS message from an allowed topic. */
export async function verifySnsMessage(
  body: unknown,
  allowedTopics: string[],
  getCert: CertFetcher = fetchCert,
): Promise<SnsMessage> {
  const msg = body as SnsMessage;
  if (!msg || typeof msg !== 'object' || typeof msg.Signature !== 'string' || typeof msg.Message !== 'string') {
    throw new Error('not an SNS message');
  }
  if (!['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation'].includes(msg.Type)) {
    throw new Error(`unexpected SNS message type ${msg.Type}`);
  }
  if (!allowedTopics.includes(msg.TopicArn)) throw new Error(`topic not allowed: ${msg.TopicArn}`);
  if (!isSnsUrl(msg.SigningCertURL, /\.pem$/)) throw new Error('untrusted SigningCertURL');

  const algorithm = { '1': 'RSA-SHA1', '2': 'RSA-SHA256' }[msg.SignatureVersion];
  if (!algorithm) throw new Error(`unsupported SignatureVersion ${msg.SignatureVersion}`);

  const cert = await getCert(msg.SigningCertURL);
  const ok = createVerify(algorithm).update(stringToSign(msg), 'utf8').verify(cert, msg.Signature, 'base64');
  if (!ok) throw new Error('invalid SNS signature');
  return msg;
}
