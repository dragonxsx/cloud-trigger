import {
  NotificationDelivery,
  type NotificationOutbox,
  type RunId,
  failedDeliveryFields,
} from '@cloud-trigger/core';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { decodeDoc, epochOrNull } from './codec.js';
import { type RowValues, assignments, insertInto, rowParser } from './rows.js';
import type { Row, SqlSession } from './session.js';

const parseDeliveryRow = rowParser('notifications_outbox');

const deliveryFromRow = (row: Row): NotificationDelivery => {
  const parsed = parseDeliveryRow(row);
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

const deliveryColumns = (entry: NotificationDelivery): RowValues<'notifications_outbox'> => ({
  id: entry.id,
  key: entry.key,
  run_id: entry.runId,
  status: entry.status,
  available_at: entry.availableAt,
  lease_worker: entry.lease?.workerId ?? null,
  lease_until: entry.lease?.until ?? null,
  attempts: entry.attempts,
  last_error: entry.lastError,
  delivered_at: entry.deliveredAt,
  rule_index: entry.ruleIndex,
  created_at: entry.createdAt,
  updated_at: entry.updatedAt,
  doc: entry,
});

const heldBy = (claimed: NotificationDelivery) =>
  sql`id = ${claimed.id} AND status = 'sending' AND lease_worker = ${claimed.lease?.workerId ?? null}
    AND lease_until = ${epochOrNull(claimed.lease?.until)}`;

export class SqlNotificationOutbox implements NotificationOutbox {
  constructor(private readonly session: SqlSession) {}

  async enqueue(entries: readonly NotificationDelivery[]): Promise<number> {
    let inserted = 0;
    for (const entry of entries) {
      inserted += await this.session.run(
        sql`${insertInto(this.session, 'notifications_outbox', deliveryColumns(entry))}
          ON CONFLICT DO NOTHING`,
      );
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
    const failed = failedDeliveryFields(claimed, p);
    const changed = await this.session.run(sql`
      UPDATE notifications_outbox SET ${assignments(this.session, 'notifications_outbox', {
        status: failed.status,
        available_at: failed.availableAt,
        lease_worker: null,
        lease_until: null,
        last_error: failed.lastError,
        updated_at: failed.updatedAt,
      })}
      WHERE ${heldBy(claimed)}`);

    return changed === 1;
  }

  async listByRun(runId: RunId): Promise<readonly NotificationDelivery[]> {
    const rows = await this.session.all(sql`
      SELECT * FROM notifications_outbox WHERE run_id = ${runId} ORDER BY created_at, rule_index`);

    return rows.map(deliveryFromRow);
  }
}
