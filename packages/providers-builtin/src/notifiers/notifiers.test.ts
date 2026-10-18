import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import { type RunLifecycleEvent, mapSecretResolver, newJobId, newRunId } from '@cloud-trigger/core';
import { createTransport } from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createEmailNotifier, type SmtpSettings } from './email.js';
import { slackNotifier } from './slack.js';
import { webhookNotifier } from './webhook.js';

let server: Server;
let base = '';
const seen: { headers: IncomingMessage['headers']; body: string; url: string | undefined }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString();
    });
    req.on('end', () => {
      seen.push({ headers: req.headers, body, url: req.url });
      const path = req.url ?? '/';
      if (path.startsWith('/fail')) {
        res.writeHead(503).end('down');
      } else if (path.startsWith('/reject')) {
        res.writeHead(400).end('bad');
      } else {
        res.writeHead(200).end('ok');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const now = new Date('2026-01-01T00:00:05Z');
const event: RunLifecycleEvent = {
  event: 'permanent_failure',
  idempotencyKey: 'notify:run:permanent_failure:0',
  jobId: newJobId(),
  jobName: 'Nightly export',
  runId: newRunId(),
  status: 'failed',
  attempt: 3,
  scheduledAt: new Date('2026-01-01T00:00:00Z'),
  lateReasons: [],
  result: {
    outcome: 'failure',
    durationMs: 12,
    statusCode: 503,
    error: { code: 'http_assertion', message: 'Status 503', retryable: true },
  },
  occurredAt: now,
};
const ctx = () => ({
  secrets: mapSecretResolver({ HOOK: 'hook-secret', SMTP_PASS: 'pw' }),
  signal: AbortSignal.timeout(2_000),
  now,
});
const lastSeen = () => {
  const last = seen.at(-1);
  if (!last) {
    throw new Error('nothing received');
  }

  return last;
};

const notifyWebhook = (path: string) =>
  webhookNotifier
    .bind({ url: `${base}${path}` })
    ._unsafeUnwrap()
    .notify(event, ctx());

describe('webhook notifier', () => {
  it('posts the event as signed JSON with an idempotency key', async () => {
    const notifier = webhookNotifier
      .bind({ url: `${base}/hook`, signing: { secret: '{{secret:HOOK}}' } })
      ._unsafeUnwrap();
    expect((await notifier.notify(event, ctx())).isOk()).toBe(true);
    const received = lastSeen();
    expect(received.headers['idempotency-key']).toBe(event.idempotencyKey);
    const payload = z
      .object({ event: z.string(), job: z.object({ name: z.string() }) })
      .parse(JSON.parse(received.body));
    expect(payload).toMatchObject({ event: 'permanent_failure', job: { name: 'Nightly export' } });
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const expected = createHmac('sha256', 'hook-secret')
      .update(`${timestamp}.${received.body}`)
      .digest('hex');
    expect(received.headers['x-signature']).toBe(`sha256=${expected}`);
  });

  it('marks 5xx retryable and 4xx permanent', async () => {
    expect((await notifyWebhook('/fail'))._unsafeUnwrapErr()).toEqual({
      message: 'Webhook responded 503',
      retryable: true,
    });
    expect((await notifyWebhook('/reject'))._unsafeUnwrapErr().retryable).toBe(false);
  });
});

describe('slack notifier', () => {
  it('renders the template into the message text', async () => {
    const notifier = slackNotifier
      .bind({
        url: `${base}/slack`,
        template: '{{ job.name }} {{ event }} {{ result.statusCode }}',
      })
      ._unsafeUnwrap();
    expect((await notifier.notify(event, ctx())).isOk()).toBe(true);
    expect(z.object({ text: z.string() }).parse(JSON.parse(lastSeen().body)).text).toBe(
      'Nightly export permanent_failure 503',
    );
  });

  it('renders the default summary for results without an error', async () => {
    const notifier = slackNotifier.bind({ url: `${base}/slack` })._unsafeUnwrap();
    const succeeded: RunLifecycleEvent = {
      ...event,
      event: 'success',
      status: 'succeeded',
      result: { outcome: 'success', durationMs: 5, statusCode: 200 },
    };
    for (const [next, text] of [
      [succeeded, '[success] Nightly export: succeeded'],
      [
        { ...event, event: 'late', status: 'running', result: null },
        '[late] Nightly export: running',
      ],
      [event, '[permanent_failure] Nightly export: failed (Status 503)'],
    ] as const) {
      expect((await notifier.notify(next, ctx())).isOk()).toBe(true);
      expect(z.object({ text: z.string() }).parse(JSON.parse(lastSeen().body)).text).toBe(text);
    }
  });

  it('reports retryable failures', async () => {
    const notifier = slackNotifier.bind({ url: `${base}/fail` })._unsafeUnwrap();
    expect((await notifier.notify(event, ctx()))._unsafeUnwrapErr().retryable).toBe(true);
  });
});

describe('email notifier', () => {
  it('renders subject and body and resolves SMTP secrets', async () => {
    const settings: SmtpSettings[] = [];
    const messages: string[] = [];
    const notifier = createEmailNotifier((s) => {
      settings.push(s);
      const transport = createTransport({ jsonTransport: true });

      return {
        close: () => undefined,
        sendMail: async (mail) => {
          const info = await transport.sendMail(mail);
          messages.push(info.message);

          return info;
        },
      };
    })
      .bind({
        host: 'smtp.example.com',
        user: 'ops',
        password: '{{secret:SMTP_PASS}}',
        from: 'ct@example.com',
        to: ['oncall@example.com'],
        subject: '{{ job.name }} {{ event }}',
      })
      ._unsafeUnwrap();
    expect((await notifier.notify(event, ctx())).isOk()).toBe(true);
    expect(settings[0]?.auth).toEqual({ user: 'ops', pass: 'pw' });
    const mail = z
      .object({
        subject: z.string(),
        text: z.string(),
        to: z.array(z.object({ address: z.string() })),
      })
      .parse(JSON.parse(messages[0] ?? '{}'));
    expect(mail.subject).toBe('Nightly export permanent_failure');
    expect(mail.text).toContain('attempt 3');
    expect(mail.to[0]?.address).toBe('oncall@example.com');
  });
});
