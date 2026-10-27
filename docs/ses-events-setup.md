# SES delivery events: one-time setup

Gives the mail service real delivery results from SES (delivered / bounced / complained) instead of
only "SES accepted it". Takes about 10 minutes in the AWS account that owns SES.

**It does not change anything else on the account.** Only email that carries the configuration set
below produces events, and only the mail service adds it. No new credentials are shared: the service
keeps using the existing SES SMTP credentials.

Before you start, the mail service must be reachable over HTTPS through the Cloudflare Tunnel, e.g.
`https://mail.<yourdomain>/webhooks/ses`, and `SES_SNS_TOPIC_ARNS` must be set (step 4) so it can
confirm the subscription.

Do every step in **the same region as your SES account**.

## Console steps

1. **SNS → Topics → Create topic**: type *Standard*, name `eclipse-mail-ses-events`. Copy the topic ARN.
2. **SES → Configuration sets → Create set**: name `eclipse-mail`.
3. Open the set → **Event destinations → Add destination**:
   - Event types: *Deliveries, Hard bounces, Complaints, Rejects, Delivery delays, Rendering failures*
   - Destination: *Amazon SNS*, topic `eclipse-mail-ses-events`
4. Send the topic ARN to the mail-service team. They set in `.env` and restart the API:
   ```
   SES_SNS_TOPIC_ARNS=<topic ARN>
   SMTP_SES_SES_CONFIGURATION_SET=eclipse-mail
   ```
5. **SNS → the topic → Create subscription**: protocol *HTTPS*, endpoint
   `https://mail.<yourdomain>/webhooks/ses`. The service confirms it automatically; the
   subscription should show *Confirmed* within a minute.

## Same thing with the AWS CLI

```sh
REGION=<ses-region>
TOPIC=$(aws sns create-topic --name eclipse-mail-ses-events --region $REGION --query TopicArn --output text)
aws sesv2 create-configuration-set --configuration-set-name eclipse-mail --region $REGION
aws sesv2 create-configuration-set-event-destination --region $REGION \
  --configuration-set-name eclipse-mail --event-destination-name to-sns \
  --event-destination "{\"Enabled\":true,\"MatchingEventTypes\":[\"DELIVERY\",\"BOUNCE\",\"COMPLAINT\",\"REJECT\",\"DELIVERY_DELAY\",\"RENDERING_FAILURE\"],\"SnsDestination\":{\"TopicArn\":\"$TOPIC\"}}"
echo "$TOPIC"   # -> SES_SNS_TOPIC_ARNS, then restart the API
aws sns subscribe --region $REGION --topic-arn "$TOPIC" --protocol https \
  --notification-endpoint https://mail.<yourdomain>/webhooks/ses
```

## Checking it works

Send one email through the service, then `GET /v1/emails/<id>`: within a minute `status` should be
`delivered` and `events` should list `Delivery`. The API log shows `confirmed SNS subscription` once
and an `SES event` line per event. Sending to `bounce@simulator.amazonses.com` (SES's mailbox
simulator) should produce `bounced` and a suppression, without hurting your reputation.

## What the service does with events

| Event | Effect |
| --- | --- |
| Delivery | status `delivered`, `deliveredAt` set |
| Bounce (Permanent) | status `bounced`; address suppressed for all mail |
| Bounce (Transient) | status `bounced`; not suppressed (mailbox full etc. can recover) |
| Complaint | newsletter: that topic suppressed; transactional mail: all mail suppressed |
| Reject / Rendering failure | status `failed` |
| Delivery delay | recorded in `events` only |

Requests that are not signed by SNS, or come from another topic, are rejected with 403.
