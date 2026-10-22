import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createJobsClient } from '../src/index.ts';

const LIVE = process.env.LAX_LIVE === '1';

test('A7 the live registry lists open jobs', { skip: LIVE ? false : 'set LAX_LIVE=1 to run' }, async () => {
  const client = createJobsClient({ retries: 1, timeoutMs: 20000 });
  const result = await client.listJobs({ limit: 5 });
  assert.ok(Array.isArray(result.jobs));
  assert.equal(typeof result.count, 'number');
  assert.ok(result.jobs.length <= 5);
  for (const job of result.jobs) {
    assert.equal(typeof job.id, 'string');
    assert.ok(job.id.length > 0);
  }
});
