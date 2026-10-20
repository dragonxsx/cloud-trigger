import type { RunId } from '../domain/ids.js';
import type { NotificationDelivery } from '../domain/notification.js';

export interface NotificationOutbox {
  enqueue(entries: readonly NotificationDelivery[]): Promise<number>;
  claimNext(p: {
    workerId: string;
    now: Date;
    leaseMs: number;
  }): Promise<NotificationDelivery | undefined>;
  complete(claimed: NotificationDelivery, now: Date): Promise<boolean>;
  fail(
    claimed: NotificationDelivery,
    p: { error: string; retryAt: Date | null; now: Date },
  ): Promise<boolean>;
  listByRun(runId: RunId): Promise<readonly NotificationDelivery[]>;
  /** Pending and sending deliveries whose notifier goes over the connection. */
  listOpenByConnection(key: string): Promise<readonly NotificationDelivery[]>;
}
