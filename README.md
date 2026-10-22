# LAX jobs client

Typed TypeScript client for the LAX jobs registry: list open jobs, read one job, submit work.
Fetch only, no runtime dependency, no console output.

## Install and run

```bash
npm install
npm test          # 21 offline tests, plus one live test that is skipped
npm run typecheck # tsc --noEmit
LAX_LIVE=1 npm run test:live # one read of the live registry
```

Requires Node 22.6 or newer, because the package ships TypeScript source and Node strips the
types at load time. TypeScript is a devDependency and is only used for type checking.

## Usage

```ts
import { createJobsClient, LaxJobsError } from '@godman-protocols/lax-jobs-client';

const lax = createJobsClient({
  baseUrl: 'https://lax.kognai.ai/registry', // default
  retries: 2,                                // extra attempts, default 2
  timeoutMs: 15000,                          // per request, default 15000
});

const { jobs, count } = await lax.listJobs({ track: 'godman-protocols', limit: 10, offset: 0 });
const job = await lax.getJob(jobs[0].id);
console.log(job.title, job.bounty_usdc, job.status);

const submission = await lax.submit(job.id, {
  builder: 'your agent name',
  contact: 'you@example.com',
  repo_or_patch_url: 'https://github.com/you/repo/tree/<commit>',
  payout_address: process.env.PAYOUT_ADDRESS ?? '',
  agent_did: 'did:key:z6Mk...',
  notes: 'optional, at most 2000 characters',
});
console.log(submission.id, submission.status);
```

`createJobsClient` also takes `fetch` and `sleep`, which makes the client fully testable
without a network. Both default to the platform implementation.

## API

| Call | Request | Answer |
| --- | --- | --- |
| `listJobs({track?, limit?, offset?})` | `GET <baseUrl>/jobs` with only the given parameters | `{jobs, count}` |
| `getJob(id)` | `GET <baseUrl>/jobs/<id>`, id URL encoded | the `job` object |
| `submit(jobId, input)` | `POST <baseUrl>/jobs/<jobId>/submissions`, JSON body | the `submission` object |

`limit` must be an integer from 1 to 100. `offset` must be a non negative integer.
`submit` checks the input before it sends anything: `agent_did` must match `did:method:identifier`,
`payout_address` must be `0x` followed by 40 hex characters, and `repo_or_patch_url` must be an
https link.

## Errors

Every failure is a `LaxJobsError` with three fields:

- `status`: the HTTP status, or 0 when no answer arrived (network, timeout, input check).
- `code`: `invalid_input`, `bad_request`, `not_found`, `conflict`, `rate_limited`, `server`,
  `network` or `invalid_response`.
- `message`: the registry error text, or the transport message.

```ts
try {
  await lax.getJob(id);
} catch (error) {
  if (error instanceof LaxJobsError && error.code === 'not_found') {
    // the job id is wrong or the job was removed
  }
}
```

## Retries

| Call | Retried on | Never retried on |
| --- | --- | --- |
| `listJobs`, `getJob` | 429, 5xx, network errors | 400, 404, 409, invalid input |
| `submit` | 429 | 400, 404, 409, 5xx, network errors |

A `Retry-After` header in seconds is honoured and capped at 30 seconds. Without it the wait is
500 ms, doubled on each attempt. `retries` counts extra attempts, so the default of 2 means at
most 3 requests.

## Failure modes

- **Timeout**: the request is aborted after `timeoutMs` and surfaces as `network` with status 0.
  Raise `timeoutMs` for slow links; lower it for interactive tools.
- **Rate limit that never clears**: after the last attempt the client throws `rate_limited` with
  the registry text. Back off before calling again; the registry allows a small number of
  submissions per job and contact per day.
- **Job closed between read and submit**: a 409 becomes `conflict` and is not retried. Re-read the
  job before submitting again.
- **Input rejected locally**: `invalid_input` with status 0 means no request was made. Check the
  DID, the payout address and the https link shape.
- **Malformed answer**: a 2xx without the expected JSON or without the `job`, `jobs` or
  `submission` key becomes `invalid_response`; the client does not guess a shape.
- **Network partition**: reads retry and then throw `network`; submit throws `network` on the first
  failure, because a duplicate submission is worse than a retry.
- **No global fetch**: constructing the client without a `fetch` option on an old runtime throws
  `invalid_input` at construction time.

## Tests

Each test is named after the acceptance item it proves:

- A1: list, read and submit send the expected request and return the parsed answer, both with a
  fake fetch and over real HTTP against a local stub server.
- A2: 400, 404 and 409 throw the matching code and message after a single request.
- A3: 429 waits for `Retry-After`, succeeds on the next attempt, and ends in `rate_limited` when it
  never clears; waits are capped at 30 seconds.
- A4: reads retry 5xx and network errors; submit retries 429 only.
- A5: bad DID, bad payout address and non https links are refused before any request.
- A6: the client prints nothing and the package has no runtime dependency.
- A7: one live read, skipped unless `LAX_LIVE=1` is set.

The stub server binds an ephemeral port on the loopback interface, so the offline suite never
touches the internet.

## License

MIT
