import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createJobsClient, LaxJobsError } from '../src/index.ts';

interface Call {
  url: string;
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  };
}

interface Reply {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

type Handler = (call: Call, index: number) => Reply;

function reply(status: number, payload: unknown, headers: Record<string, string> = {}): Reply {
  return { status, body: typeof payload === 'string' ? payload : JSON.stringify(payload), headers };
}

function harness(handler: Handler) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fetchImpl = async (url: string, init?: Call['init']) => {
    const call: Call = { url, init };
    calls.push(call);
    const answer = handler(call, calls.length - 1);
    const lower: Record<string, string> = {};
    for (const [key, value] of Object.entries(answer.headers ?? {})) {
      lower[key.toLowerCase()] = value;
    }
    return {
      status: answer.status,
      headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
      text: async () => answer.body,
    };
  };
  const client = createJobsClient({
    baseUrl: 'https://unit.test/registry',
    fetch: fetchImpl,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  return { client, calls, sleeps };
}

const JOB = {
  id: 'job-1',
  title: 'Typed client',
  track: 'godman-protocols',
  summary: 'list, read, submit',
  spec_md: '## Build',
  spec_url: null,
  tests_url: null,
  skills: ['typescript'],
  bounty_usdc: 200,
  currency: 'USDC',
  chain: 'base',
  deadline: '2026-11-09T23:59:00+00:00',
  status: 'open',
  seat: null,
  created_at: '2026-10-20T22:34:57.101+00:00',
  updated_at: null,
  bid_closes: '2026-10-29T20:00:00+00:00',
  selection: null,
};

const VALID_SUBMIT = {
  builder: 'garuda-ops',
  contact: 'ops@example.test',
  repo_or_patch_url: 'https://example.test/repo/commit/abc',
  payout_address: '0x' + '12ab'.repeat(10),
  agent_did: 'did:key:z6Mkexample',
  notes: 'M1 and M2',
};

test('A1 listJobs sends only the given query and unwraps jobs and count', async () => {
  const { client, calls } = harness(() => reply(200, { jobs: [JOB], count: 7 }));
  const result = await client.listJobs({ track: 'godman-protocols', limit: 10, offset: 20 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init?.method, 'GET');
  assert.equal(
    calls[0]?.url,
    'https://unit.test/registry/jobs?track=godman-protocols&limit=10&offset=20',
  );
  assert.deepEqual(result.count, 7);
  assert.equal(result.jobs[0]?.id, 'job-1');

  const bare = harness(() => reply(200, { jobs: [], count: 0 }));
  await bare.client.listJobs();
  assert.equal(bare.calls[0]?.url, 'https://unit.test/registry/jobs');
});

test('A1 getJob encodes the id and returns the job out of job', async () => {
  const { client, calls } = harness(() => reply(200, { job: JOB }));
  const job = await client.getJob('a/b c');

  assert.equal(calls[0]?.url, 'https://unit.test/registry/jobs/a%2Fb%20c');
  assert.equal(job.title, 'Typed client');
  assert.equal(job.bounty_usdc, 200);
});

test('A1 submit posts JSON and returns the submission out of submission', async () => {
  const created = {
    id: 'sub-1',
    job_id: 'job-1',
    status: 'received',
    created_at: '2026-10-22T00:00:00+00:00',
  };
  const { client, calls } = harness(() => reply(201, { submission: created }));
  const submission = await client.submit('job-1', VALID_SUBMIT);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(calls[0]?.url, 'https://unit.test/registry/jobs/job-1/submissions');
  assert.equal(calls[0]?.init?.headers?.['content-type'], 'application/json');
  const body = JSON.parse(calls[0]?.init?.body ?? '{}');
  assert.equal(body.agent_did, VALID_SUBMIT.agent_did);
  assert.equal(body.repo_or_patch_url, VALID_SUBMIT.repo_or_patch_url);
  assert.equal(submission.id, 'sub-1');
  assert.equal(submission.status, 'received');
});

test('A2 400 and 404 and 409 throw typed errors after a single request', async () => {
  for (const [status, code] of [
    [400, 'bad_request'],
    [404, 'not_found'],
    [409, 'conflict'],
  ] as const) {
    const { client, calls, sleeps } = harness(() =>
      reply(status, { error: `registry says ${status}` }),
    );
    await assert.rejects(
      () => client.getJob('job-1'),
      (error: unknown) => {
        assert.ok(error instanceof LaxJobsError);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        assert.equal(error.message, `registry says ${status}`);
        return true;
      },
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  }
});

test('A3 429 honours Retry-After and then succeeds', async () => {
  const { client, calls, sleeps } = harness((_call, index) =>
    index === 0
      ? reply(429, { error: 'slow down' }, { 'Retry-After': '2' })
      : reply(200, { jobs: [JOB], count: 1 }),
  );
  const result = await client.listJobs({ limit: 1 });

  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(result.count, 1);
});

test('A3 a 429 that never ends throws rate_limited after the last retry', async () => {
  const { client, calls, sleeps } = harness(() => reply(429, { error: 'quota' }));
  await assert.rejects(
    () => client.getJob('job-1'),
    (error: unknown) => {
      assert.ok(error instanceof LaxJobsError);
      assert.equal(error.code, 'rate_limited');
      assert.equal(error.status, 429);
      assert.equal(error.message, 'quota');
      return true;
    },
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test('A3 Retry-After above 30 seconds is capped at 30 seconds', async () => {
  const { client, sleeps } = harness((_call, index) =>
    index === 0
      ? reply(429, { error: 'later' }, { 'Retry-After': '600' })
      : reply(200, { jobs: [], count: 0 }),
  );
  await client.listJobs();
  assert.deepEqual(sleeps, [30_000]);
});

test('A4 a read is retried on 5xx and then throws server', async () => {
  const { client, calls, sleeps } = harness(() => reply(503, { error: 'down' }));
  await assert.rejects(
    () => client.getJob('job-1'),
    (error: unknown) => {
      assert.ok(error instanceof LaxJobsError);
      assert.equal(error.code, 'server');
      assert.equal(error.status, 503);
      return true;
    },
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test('A4 a read is retried on network errors and then throws network', async () => {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const client = createJobsClient({
    baseUrl: 'https://unit.test/registry',
    fetch: async (url: string, init?: Call['init']) => {
      calls.push({ url, init });
      throw new Error('socket closed');
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  await assert.rejects(
    () => client.listJobs({ limit: 5 }),
    (error: unknown) => {
      assert.ok(error instanceof LaxJobsError);
      assert.equal(error.code, 'network');
      assert.equal(error.status, 0);
      assert.equal(error.message, 'socket closed');
      return true;
    },
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test('A4 submit is not retried on 5xx or on a network error', async () => {
  const server = harness(() => reply(500, { error: 'boom' }));
  await assert.rejects(
    () => server.client.submit('job-1', VALID_SUBMIT),
    (error: unknown) => {
      assert.ok(error instanceof LaxJobsError);
      assert.equal(error.code, 'server');
      assert.equal(error.status, 500);
      return true;
    },
  );
  assert.equal(server.calls.length, 1);
  assert.deepEqual(server.sleeps, []);

  let networkCalls = 0;
  const network = createJobsClient({
    baseUrl: 'https://unit.test/registry',
    fetch: async () => {
      networkCalls += 1;
      throw new Error('reset');
    },
    sleep: async () => {},
  });
  await assert.rejects(
    () => network.submit('job-1', VALID_SUBMIT),
    (error: unknown) => {
      assert.ok(error instanceof LaxJobsError);
      assert.equal(error.code, 'network');
      return true;
    },
  );
  assert.equal(networkCalls, 1);
});

test('A4 submit is retried on 429 only', async () => {
  const { client, calls } = harness((_call, index) =>
    index === 0
      ? reply(429, { error: 'quota' }, { 'Retry-After': '1' })
      : reply(201, { submission: { id: 'sub-2', job_id: 'job-1', status: 'received', created_at: 'x' } }),
  );
  const submission = await client.submit('job-1', VALID_SUBMIT);
  assert.equal(calls.length, 2);
  assert.equal(submission.id, 'sub-2');
});

test('A5 submit refuses bad input before any request', async () => {
  const cases: Array<Record<string, unknown>> = [
    { ...VALID_SUBMIT, agent_did: undefined },
    { ...VALID_SUBMIT, agent_did: 'not-a-did' },
    { ...VALID_SUBMIT, payout_address: '0x123' },
    { ...VALID_SUBMIT, payout_address: '11ab'.repeat(10) },
    { ...VALID_SUBMIT, repo_or_patch_url: 'http://example.test/repo' },
    { ...VALID_SUBMIT, repo_or_patch_url: 'ftp://example.test/repo' },
    { ...VALID_SUBMIT, builder: '' },
  ];
  for (const input of cases) {
    const { client, calls, sleeps } = harness(() => reply(201, { submission: {} }));
    await assert.rejects(
      () => client.submit('job-1', input as unknown as typeof VALID_SUBMIT),
      (error: unknown) => {
        assert.ok(error instanceof LaxJobsError);
        assert.equal(error.code, 'invalid_input');
        assert.equal(error.status, 0);
        return true;
      },
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(sleeps, []);
  }
});

test('A5 listJobs rejects a limit outside 1 to 100', async () => {
  for (const limit of [0, 101, 1.5]) {
    const { client, calls } = harness(() => reply(200, { jobs: [], count: 0 }));
    await assert.rejects(() => client.listJobs({ limit }), (error: unknown) => {
      assert.ok(error instanceof LaxJobsError);
      assert.equal(error.code, 'invalid_input');
      return true;
    });
    assert.equal(calls.length, 0);
  }
});

test('A6 the client writes nothing to the console', async () => {
  const seen: unknown[][] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...items: unknown[]) => {
    seen.push(items);
  };
  console.error = (...items: unknown[]) => {
    seen.push(items);
  };
  console.warn = (...items: unknown[]) => {
    seen.push(items);
  };
  try {
    const ok = harness(() => reply(200, { jobs: [], count: 0 }));
    await ok.client.listJobs();
    const bad = harness(() => reply(404, { error: 'missing' }));
    await assert.rejects(() => bad.client.getJob('nope'));
  } finally {
    console.log = saved.log;
    console.error = saved.error;
    console.warn = saved.warn;
  }
  assert.deepEqual(seen, []);
});

test('A6 the package declares no runtime dependency', () => {
  const path = fileURLToPath(new URL('../package.json', import.meta.url));
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const runtime = Object.keys(manifest.dependencies ?? {});
  assert.deepEqual(runtime, []);
  assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}), []);
});

test('invalid_response is raised when the answer is not the expected JSON', async () => {
  const broken = harness(() => ({ status: 200, body: 'not json' }));
  await assert.rejects(
    () => broken.client.listJobs(),
    (error: unknown) => {
      assert.ok(error instanceof LaxJobsError);
      assert.equal(error.code, 'invalid_response');
      assert.equal(error.status, 200);
      return true;
    },
  );

  const shaped = harness(() => reply(200, { other: true }));
  await assert.rejects(
    () => shaped.client.getJob('job-1'),
    (error: unknown) => {
      assert.ok(error instanceof LaxJobsError);
      assert.equal(error.code, 'invalid_response');
      return true;
    },
  );
  assert.equal(shaped.calls.length, 1);
});
