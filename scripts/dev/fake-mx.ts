// TEST ONLY. Stands in for recipients' mail servers (Gmail, Outlook, ...) in the self-hosted test
// stack (deploy/docker-compose.test.yml): Postfix relays everything here instead of to real MX hosts.
//
// Behaviour by recipient local part:
//   bounce-me*     550 5.1.1 at RCPT        -> Postfix status=bounced, address suppressed
//   reject-me*     550 5.7.1 after DATA     -> policy rejection, not suppressed
//   defer-me*      451 4.2.0 at RCPT        -> Postfix keeps retrying (mta_deferred)
//   async-bounce*  250, then a DSN is mailed to the return path a few seconds later (late bounce)
//   anything else  250
// GET http://<host>:8090/messages lists what was accepted (with raw source, for DKIM checks).
import { createServer } from 'node:http';
import nodemailer from 'nodemailer';
import { SMTPServer } from 'smtp-server';

const SMTP_PORT = Number(process.env.FAKE_MX_PORT ?? 2526);
const HTTP_PORT = Number(process.env.FAKE_MX_HTTP_PORT ?? 8090);
const RETURN_HOST = process.env.FAKE_MX_RETURN_HOST ?? 'postfix';

interface Received {
  at: string;
  mailFrom: string;
  to: string[];
  raw: string;
}
const inbox: Received[] = [];
const fail = (code: number, msg: string) => Object.assign(new Error(msg), { responseCode: code });

const server = new SMTPServer({
  authOptional: true,
  disabledCommands: ['AUTH', 'STARTTLS'],
  banner: 'fake-mx (test only)',
  onRcptTo(addr, _s, cb) {
    const local = addr.address.toLowerCase();
    if (local.startsWith('bounce-me')) return cb(fail(550, '5.1.1 The email account that you tried to reach does not exist'));
    if (local.startsWith('defer-me')) return cb(fail(451, '4.2.0 Temporarily rate limited, try again later'));
    cb();
  },
  onData(stream, session, cb) {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => {
      const to = session.envelope.rcptTo.map((r) => r.address.toLowerCase());
      const mailFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address : '';
      if (to.some((t) => t.startsWith('reject-me'))) return cb(fail(550, '5.7.1 Message rejected due to local policy'));
      inbox.push({ at: new Date().toISOString(), mailFrom, to, raw: Buffer.concat(chunks).toString('utf8') });
      for (const t of to.filter((x) => x.startsWith('async-bounce'))) setTimeout(() => lateBounce(mailFrom, t), 3000);
      cb(null, `2.0.0 OK queued as FAKE${inbox.length}`);
    });
  },
});
server.on('error', (err) => console.error('fake-mx smtp error', err.message));

// A bounce generated after the recipient's server had accepted the message, as some servers do.
async function lateBounce(returnPath: string, recipient: string) {
  if (!returnPath) return;
  const boundary = 'fakemx-dsn';
  const raw = [
    'From: MAILER-DAEMON@fake-mx.test (Mail Delivery System)',
    `To: ${returnPath}`,
    'Subject: Undelivered Mail Returned to Sender',
    'Auto-Submitted: auto-replied',
    'MIME-Version: 1.0',
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain',
    '',
    `Your message to ${recipient} could not be delivered: the mailbox was deleted.`,
    `--${boundary}`,
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; fake-mx.test',
    '',
    `Final-Recipient: rfc822; ${recipient}`,
    'Action: failed',
    'Status: 5.1.1',
    'Diagnostic-Code: smtp; 550 5.1.1 mailbox no longer exists',
    `--${boundary}--`,
    '',
  ].join('\r\n');
  try {
    await nodemailer
      .createTransport({ host: RETURN_HOST, port: 25, secure: false, ignoreTLS: true, name: 'fake-mx.test' })
      .sendMail({ envelope: { from: '', to: returnPath }, raw });
    console.log(`fake-mx: sent late bounce for ${recipient} to ${returnPath}`);
  } catch (err) {
    console.error(`fake-mx: late bounce failed: ${(err as Error).message}`);
  }
}

server.listen(SMTP_PORT, '0.0.0.0', () => console.log(`fake-mx: SMTP on :${SMTP_PORT}, inbox on :${HTTP_PORT}/messages`));
createServer((req, res) => {
  if (req.url === '/messages') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(inbox));
  }
  res.statusCode = 404;
  res.end();
}).listen(HTTP_PORT, '0.0.0.0');
