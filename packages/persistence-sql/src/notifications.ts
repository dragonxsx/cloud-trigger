import { NotificationDelivery, type NotificationOutbox, type RunId } from '@cloud-trigger/core';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { DateColumn, Epoch, decodeDoc, encodeDoc, epochOrNull } from './codec.js';
import type { Row, SqlSession } from './session.js';

const DeliveryRow = z.looseObject({
  doc: z.unknown(),
  status: z.string(),
  available_at: DateColumn,
  lease_worker: z.string().nullable(),
  lease_until: DateColumn.nullable(),
  attempts: Epoch,
  last_error: z.string().nullable(),
  delivered_at: DateColumn.nullable(),
  updated_at: DateColumn,
});

const deliveryFromRow = (row: Row): NotificationDelivery => {
  const parsed = DeliveryRow.parse(row);
  const doc = z.record(z.string(), z.unknown()).parse(decodeDoc(parsed.doc));

  return NotificationDelivery.parse({
    ...doc,
    status: parsed.status,
    availableAt: parsed.available_at,
    lease:
      parsed.lease_worker !== null && parsed.lease_until !== null
        ? { workerId: parsed.lease_worker, until: parsed.lease_until }
        : null,
    attempts: parsed.attempts,
    lastError: parsed.last_error,
    deliveredAt: parsed.delivered_at,
    updatedAt: parsed.updated_at,
  });
};

const heldBy = (claimed: NotificationDelivery) =>
  sql`id = ${claimed.id} AND status = 'sending' AND lease_worker = ${claimed.lease?.workerId ?? null}
    AND lease_until = ${epochOrNull(claimed.lease?.until)}`;

export class SqlNotificationOutbox implements NotificationOutbox {
  constructor(private readonly session: SqlSession) {}

  async enqueue(entries: readonly NotificationDelivery[]): Promise<number> {
    let inserted = 0;
    for (const entry of entries) {
      inserted += await this.session.run(sql`
        INSERT INTO notifications_outbox (id, key, run_id, status, available_at, lease_worker,
          lease_until, attempts, last_error, delivered_at, rule_index, created_at, updated_at, doc)
        VALUES (${entry.id}, ${entry.key}, ${entry.runId}, ${entry.status},
          ${entry.availableAt.getTime()}, ${entry.lease?.workerId ?? null},
          ${epochOrNull(entry.lease?.until)}, ${entry.attempts}, ${entry.lastError},
          ${epochOrNull(entry.deliveredAt)}, ${entry.ruleIndex}, ${entry.createdAt.getTime()},
          ${entry.updatedAt.getTime()}, ${this.session.dialect.json(encodeDoc(entry))})
        ON CONFLICT DO NOTHING`);
    }

    return inserted;
  }

  async claimNext(p: { workerId: string; now: Date; leaseMs: number }) {
    const now = p.now.getTime();
    const [row] = await this.session.all(sql`
      UPDATE notifications_outbox SET status = 'sending', lease_worker = ${p.workerId},
        lease_until = ${now + p.leaseMs}, attempts = attempts + 1, updated_at = ${now}
      WHERE id = (
        SELECT id FROM notifications_outbox
        WHERE (status = 'pending' AND available_at <= ${now})
          OR (status = 'sending' AND lease_until < ${now})
        ORDER BY available_at, id LIMIT 1 ${this.session.dialect.skipLocked})
      RETURNING *`);

    return row ? deliveryFromRow(row) : undefined;
  }

  async complete(claimed: NotificationDelivery, now: Date): Promise<boolean> {
    const changed = await this.session.run(sql`
      UPDATE notifications_outbox SET status = 'delivered', lease_worker = NULL,
        lease_until = NULL, delivered_at = ${now.getTime()}, updated_at = ${now.getTime()}
      WHERE ${heldBy(claimed)}`);

    return changed === 1;
  }

  async fail(
    claimed: NotificationDelivery,
    p: { error: string; retryAt: Date | null; now: Date },
  ): Promise<boolean> {
    const changed = await this.session.run(sql`
      UPDATE notifications_outbox SET status = ${p.retryAt ? 'pending' : 'failed'},
        available_at = ${(p.retryAt ?? claimed.availableAt).getTime()}, lease_worker = NULL,
        lease_until = NULL, last_error = ${p.error}, updated_at = ${p.now.getTime()}
      WHERE ${heldBy(claimed)}`);

    return changed === 1;
  }

  async listByRun(runId: RunId): Promise<readonly NotificationDelivery[]> {
    const rows = await this.session.all(sql`
      SELECT * FROM notifications_outbox WHERE run_id = ${runId} ORDER BY created_at, rule_index`);

    return rows.map(deliveryFromRow);
  }
}
