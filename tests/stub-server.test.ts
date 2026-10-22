import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { after, before, test } from 'node:test';

import { createJobsClient, LaxJobsError } from '../src/index.ts';

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

const recorded: Recorded[] = [];
let failuresLeft = 0;
let server: Server;
let baseUrl = '';

const JOB = {
  id: 'job-live',
  title: 'Stub job',
  track: 'godman-protocols',
  summary: 'served by the local stub',
  spec_md: '## Build',
  status: 'open',
  bounty_usdc: 200,
  skills: ['typescript'],
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body);
}

before(async () => {
  server = createServer(async (request, response) => {
    const body = await readBody(request);
    const url = request.url ?? '';
    recorded.push({ method: request.method ?? '', url, headers: request.headers, body });

    const pathname = url.split('?')[0] ?? url;
    if (pathname === '/registry/jobs' && request.method === 'GET') {
      send(response, 200, { jobs: [JOB], count: 1 });
      return;
    }

    const jobMatch = /^\/registry\/jobs\/([^/]+)$/.exec(pathname);
    if (jobMatch && request.method === 'GET') {
      if (decodeURIComponent(jobMatch[1] ?? '') === 'missing-job') {
        send(response, 404, { error: 'job not found' });
        return;
      }
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        send(response, 503, { error: 'temporary outage' });
        return;
      }
      send(response, 200, { job: { ...JOB, id: decodeURIComponent(jobMatch[1] ?? '') } });
      return;
    }

    const submitMatch = /^\/registry\/jobs\/([^/]+)\/submissions$/.exec(pathname);
    if (submitMatch && request.method === 'POST') {
      send(response, 201, {
        submission: {
          id: 'sub-local',
          job_id: decodeURIComponent(submitMatch[1] ?? ''),
          status: 'received',
          created_at: '2026-10-22T00:00:00+00:00',
        },
      });
      return;
    }

    send(response, 404, { error: 'no such route' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}/registry`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test('A1 the client lists jobs over real HTTP', async () => {
  const client = createJobsClient({ baseUrl, timeoutMs: 5000 });
  const result = await client.listJobs({ track: 'godman-protocols', limit: 1 });
  assert.equal(result.count, 1);
  assert.equal(result.jobs[0]?.title, 'Stub job');
  assert.equal(recorded.at(-1)?.url, '/registry/jobs?track=godman-protocols&limit=1');
});

test('A1 the client reads one job over real HTTP', async () => {
  const client = createJobsClient({ baseUrl, timeoutMs: 5000 });
  const job = await client.getJob('job with space');
  assert.equal(job.id, 'job with space');
  assert.equal(recorded.at(-1)?.url, '/registry/jobs/job%20with%20space');
});

test('A1 the client submits over real HTTP with a JSON body', async () => {
  const client = createJobsClient({ baseUrl, timeoutMs: 5000 });
  const submission = await client.submit('job-live', {
    builder: 'garuda-ops',
    contact: 'ops@example.test',
    repo_or_patch_url: 'https://example.test/repo/tree/main',
    payout_address: '0x' + '34cd'.repeat(10),
    agent_did: 'did:key:z6Mkstub',
    notes: 'local stub only',
  });
  assert.equal(submission.id, 'sub-local');
  const last = recorded.at(-1);
  assert.equal(last?.headers['content-type'], 'application/json');
  const body = JSON.parse(last?.body ?? '{}');
  assert.equal(body.agent_did, 'did:key:z6Mkstub');
  assert.equal(body.notes, 'local stub only');
});

test('A2 a 404 from the stub server becomes not_found after one request', async () => {
  const client = createJobsClient({ baseUrl, timeoutMs: 5000 });
  const before = recorded.length;
  await assert.rejects(
    () => client.getJob('missing-job'),
    (error: unknown) => {
      assert.ok(error instanceof LaxJobsError);
      assert.equal(error.status, 404);
      assert.equal(error.code, 'not_found');
      assert.equal(error.message, 'job not found');
      return true;
    },
  );
  assert.equal(recorded.length - before, 1);
});

test('A4 the client retries a real 503 and then reads the job', async () => {
  failuresLeft = 2;
  const waits: number[] = [];
  const client = createJobsClient({
    baseUrl,
    timeoutMs: 5000,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  });
  const job = await client.getJob('job-live');
  assert.equal(job.id, 'job-live');
  assert.deepEqual(waits, [500, 1000]);
  assert.equal(failuresLeft, 0);
});
