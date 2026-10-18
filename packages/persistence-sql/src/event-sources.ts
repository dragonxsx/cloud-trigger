import type { EventSourceLeaseRequest, EventSourceLeases } from '@cloud-trigger/core';
import { sql } from 'drizzle-orm';

import type { SqlSession } from './session.js';

export class SqlEventSourceLeases implements EventSourceLeases {
  constructor(private readonly session: SqlSession) {}

  async claim({ key, ownerId, now, leaseMs }: EventSourceLeaseRequest): Promise<boolean> {
    const rows = await this.session.all(sql`
      INSERT INTO event_sources (key, owner, until) VALUES (${key}, ${ownerId}, ${now.getTime() + leaseMs})
      ON CONFLICT (key) DO UPDATE SET owner = excluded.owner, until = excluded.until
      WHERE event_sources.owner = excluded.owner OR event_sources.until <= ${now.getTime()}
      RETURNING key`);

    return rows.length === 1;
  }

  async release({ key, ownerId }: { key: string; ownerId: string }): Promise<void> {
    await this.session.run(
      sql`DELETE FROM event_sources WHERE key = ${key} AND owner = ${ownerId}`,
    );
  }
}
