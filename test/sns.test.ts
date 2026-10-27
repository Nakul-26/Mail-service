import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isSnsUrl, stringToSign, verifySnsMessage, type SnsMessage } from '../src/sns.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const getCert = async () => publicPem; // verify() accepts a public key as well as a certificate

const TOPIC = 'arn:aws:sns:ap-south-1:123456789012:eclipse-mail-ses-events';

function signed(overrides: Partial<SnsMessage> = {}, version = '2'): SnsMessage {
  const msg: SnsMessage = {
    Type: 'Notification',
    MessageId: 'sns-1',
    TopicArn: TOPIC,
    Message: JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'ses-1' } }),
    Timestamp: '2026-10-27T10:00:00.000Z',
    SignatureVersion: version,
    SigningCertURL: 'https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-abc.pem',
    Signature: '',
    ...overrides,
  };
  msg.Signature = createSign(version === '1' ? 'RSA-SHA1' : 'RSA-SHA256')
    .update(stringToSign(msg))
    .sign(privateKey, 'base64');
  return msg;
}

describe('verifySnsMessage', () => {
  it('accepts correctly signed messages (SignatureVersion 1 and 2)', async () => {
    await expect(verifySnsMessage(signed({}, '1'), [TOPIC], getCert)).resolves.toMatchObject({ MessageId: 'sns-1' });
    await expect(verifySnsMessage(signed({ Subject: 'hi' }), [TOPIC], getCert)).resolves.toBeTruthy();
  });

  it('accepts subscription confirmations', async () => {
    const msg = signed({
      Type: 'SubscriptionConfirmation',
      Token: 'tok',
      SubscribeURL: 'https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription&Token=tok',
    });
    await expect(verifySnsMessage(msg, [TOPIC], getCert)).resolves.toBeTruthy();
  });

  it('rejects a modified message', async () => {
    const msg = signed();
    msg.Message = msg.Message.replace('Delivery', 'Bounce');
    await expect(verifySnsMessage(msg, [TOPIC], getCert)).rejects.toThrow('invalid SNS signature');
  });

  it('rejects other topics and untrusted certificate URLs', async () => {
    await expect(verifySnsMessage(signed(), ['arn:other'], getCert)).rejects.toThrow('topic not allowed');
    for (const url of [
      'http://sns.ap-south-1.amazonaws.com/x.pem',
      'https://sns.ap-south-1.amazonaws.com.evil.com/x.pem',
      'https://evil.com/sns.ap-south-1.amazonaws.com/x.pem',
      'https://sns.ap-south-1.amazonaws.com/x.txt',
    ]) {
      await expect(verifySnsMessage(signed({ SigningCertURL: url }), [TOPIC], getCert)).rejects.toThrow(
        'untrusted SigningCertURL',
      );
    }
  });

  it('rejects unknown signature versions and non-SNS bodies', async () => {
    const msg = signed();
    msg.SignatureVersion = '3';
    await expect(verifySnsMessage(msg, [TOPIC], getCert)).rejects.toThrow('unsupported SignatureVersion');
    await expect(verifySnsMessage({ hello: 1 }, [TOPIC], getCert)).rejects.toThrow('not an SNS message');
  });
});

describe('isSnsUrl', () => {
  it('only allows HTTPS SNS hosts', () => {
    expect(isSnsUrl('https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription')).toBe(true);
    expect(isSnsUrl('https://sns.cn-north-1.amazonaws.com.cn/x')).toBe(true);
    expect(isSnsUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isSnsUrl(undefined)).toBe(false);
  });
});
