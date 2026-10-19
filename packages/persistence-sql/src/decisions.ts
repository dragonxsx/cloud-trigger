import { randomUUID } from 'node:crypto';

import { type DecisionLog, type JobId, ScheduleDecision } from '@cloud-trigger/core';
import { sql } from 'drizzle-orm';

import { docParser } from './codec.js';
import { insertInto } from './rows.js';
import type { SqlSession } from './session.js';

const decisionFromRow = docParser(ScheduleDecision);

export class SqlDecisionLog implements DecisionLog {
  constructor(private readonly session: SqlSession) {}

  async record(decision: ScheduleDecision): Promise<void> {
    await this.session.run(
      insertInto(this.session, 'schedule_decisions', {
        id: randomUUID(),
        job_id: decision.jobId,
        at: decision.at,
        doc: decision,
      }),
    );
  }

  async listRecent(jobId: JobId, p: { before: Date; limit: number }) {
    const rows = await this.session.all(sql`
      SELECT doc FROM schedule_decisions WHERE job_id = ${jobId} AND at <= ${p.before.getTime()}
      ORDER BY at DESC LIMIT ${p.limit}`);

    return rows.map(decisionFromRow);
  }
}
