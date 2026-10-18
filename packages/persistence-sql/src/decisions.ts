import { randomUUID } from 'node:crypto';

import { type DecisionLog, type JobId, ScheduleDecision } from '@cloud-trigger/core';
import { sql } from 'drizzle-orm';

import { DocRow, decodeDoc, encodeDoc } from './codec.js';
import type { SqlSession } from './session.js';

export class SqlDecisionLog implements DecisionLog {
  constructor(private readonly session: SqlSession) {}

  async record(decision: ScheduleDecision): Promise<void> {
    await this.session.run(sql`
      INSERT INTO schedule_decisions (id, job_id, at, doc)
      VALUES (${randomUUID()}, ${decision.jobId}, ${decision.at.getTime()},
        ${this.session.dialect.json(encodeDoc(decision))})`);
  }

  async listRecent(jobId: JobId, p: { before: Date; limit: number }) {
    const rows = await this.session.all(sql`
      SELECT doc FROM schedule_decisions WHERE job_id = ${jobId} AND at <= ${p.before.getTime()}
      ORDER BY at DESC LIMIT ${p.limit}`);

    return rows.map((row) => ScheduleDecision.parse(decodeDoc(DocRow.parse(row).doc)));
  }
}
