/**
 * Typed client for the LAX jobs registry.
 *
 * Reads: listJobs, getJob. Write: submit. Fetch only, no runtime dependency.
 */

export type LaxJobsErrorCode =
  | 'invalid_input'
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'invalid_response';

/** Error thrown for every failed call. status is 0 when no HTTP answer arrived. */
export class LaxJobsError extends Error {
  readonly status: number;
  readonly code: LaxJobsErrorCode;

  constructor(code: LaxJobsErrorCode, message: string, status: number = 0) {
    super(message);
    this.name = 'LaxJobsError';
    this.code = code;
    this.status = status;
  }
}

/** One job as the registry returns it. Extra registry fields are kept as is. */
export interface Job {
  id: string;
  title: string;
  track: string;
  summary: string;
  spec_md: string;
  spec_url: string | null;
  tests_url: string | null;
  skills: string[];
  bounty_usdc: number;
  currency: string;
  chain: string;
  deadline: string | null;
  status: string;
  seat: unknown;
  created_at: string;
  updated_at: string | null;
  bid_closes: string | null;
  selection: unknown;
  [key: string]: unknown;
}

export interface ListJobsParams {
  track?: string;
  limit?: number;
  offset?: number;
}

export interface ListJobsResult {
  jobs: Job[];
  count: number;
}

export interface SubmitInput {
  builder: string;
  contact: string;
  repo_or_patch_url: string;
  payout_address: string;
  agent_did: string;
  notes?: string;
}

export interface Submission {
  id: string;
  job_id: string;
  status: string;
  created_at: string;
  [key: string]: unknown;
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  ok?: boolean;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface JobsClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface JobsClient {
  listJobs(params?: ListJobsParams): Promise<ListJobsResult>;
  getJob(id: string): Promise<Job>;
  submit(jobId: string, input: SubmitInput): Promise<Submission>;
}

const DEFAULT_BASE_URL = 'https://lax.kognai.ai/registry';
const DID_PATTERN = /^did:[a-z0-9]+:.+$/;
const PAYOUT_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const MAX_RETRY_AFTER_MS = 30_000;
const BASE_BACKOFF_MS = 500;

function fail(code: LaxJobsErrorCode, message: string, status = 0): never {
  throw new LaxJobsError(code, message, status);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function assertJobId(jobId: unknown): string {
  if (!isNonEmptyString(jobId)) {
    fail('invalid_input', 'job id must be a non empty string');
  }
  return jobId as string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Best effort extraction of the registry error text. */
function registryMessage(body: string, status: number): string {
  const parsed = parseJson(body);
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    for (const key of ['error', 'message', 'detail']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim().length > 0) return value;
      if (value && typeof value === 'object') {
        const nested = (value as Record<string, unknown>).message;
        if (typeof nested === 'string' && nested.trim().length > 0) return nested;
      }
    }
  }
  const trimmed = body.trim();
  if (trimmed.length > 0) return trimmed;
  return `registry answered ${status}`;
}

function codeForStatus(status: number): LaxJobsErrorCode {
  if (status === 400 || status === 422) return 'bad_request';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'bad_request';
}

function retryAfterMs(headers: { get(name: string): string | null } | undefined): number | null {
  if (!headers) return null;
  const raw = headers.get('retry-after');
  if (raw === null || raw === undefined) return null;
  const seconds = Number(String(raw).trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS);
}

export function createJobsClient(options: JobsClientOptions = {}): JobsClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (!isNonEmptyString(baseUrl)) fail('invalid_input', 'baseUrl must be a non empty string');

  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (typeof fetchImpl !== 'function') {
    fail('invalid_input', 'no fetch implementation available');
  }

  const retries = options.retries ?? 2;
  if (!Number.isInteger(retries) || retries < 0) {
    fail('invalid_input', 'retries must be a non negative integer');
  }

  const timeoutMs = options.timeoutMs ?? 15_000;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    fail('invalid_input', 'timeoutMs must be a non negative number');
  }

  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const doFetch = fetchImpl;

  async function send(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; body: string; headers?: { get(name: string): string | null } }> {
    const controller = timeoutMs > 0 && typeof AbortController === 'function'
      ? new AbortController()
      : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (controller) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }
    try {
      const response = await doFetch(url, {
        ...init,
        ...(controller ? { signal: controller.signal } : {}),
      });
      const body = await response.text();
      return { status: response.status, body, headers: response.headers };
    } catch (error) {
      if (error instanceof LaxJobsError) throw error;
      const message =
        error instanceof Error && error.message ? error.message : 'network request failed';
      throw new LaxJobsError('network', message, 0);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  interface CallOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    retryServer: boolean;
    retryNetwork: boolean;
    unwrap: (parsed: unknown) => unknown;
  }

  async function call(url: string, callOptions: CallOptions): Promise<unknown> {
    const attempts = retries + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const last = attempt === attempts - 1;
      let response: Awaited<ReturnType<typeof send>>;
      try {
        response = await send(url, {
          method: callOptions.method,
          headers: callOptions.headers,
          body: callOptions.body,
        });
      } catch (error) {
        if (error instanceof LaxJobsError && error.code === 'network' && !last && callOptions.retryNetwork) {
          await sleep(BASE_BACKOFF_MS * 2 ** attempt);
          continue;
        }
        throw error;
      }

      const { status, body, headers } = response;

      if (status >= 200 && status < 300) {
        const parsed = parseJson(body);
        if (parsed === undefined) {
          fail('invalid_response', 'registry answered with invalid JSON', status);
        }
        return callOptions.unwrap(parsed);
      }

      if (status === 429) {
        if (!last) {
          const wait = retryAfterMs(headers);
          await sleep(wait === null ? BASE_BACKOFF_MS * 2 ** attempt : wait);
          continue;
        }
        fail('rate_limited', registryMessage(body, status), status);
      }

      if (status >= 500) {
        if (!last && callOptions.retryServer) {
          await sleep(BASE_BACKOFF_MS * 2 ** attempt);
          continue;
        }
        fail('server', registryMessage(body, status), status);
      }

      fail(codeForStatus(status), registryMessage(body, status), status);
    }
    fail('network', 'request failed without an answer');
  }

  async function listJobs(params: ListJobsParams = {}): Promise<ListJobsResult> {
    if (params === null || typeof params !== 'object') {
      fail('invalid_input', 'listJobs parameters must be an object');
    }
    const search = new URLSearchParams();

    if (params.track !== undefined) {
      if (!isNonEmptyString(params.track)) {
        fail('invalid_input', 'track must be a non empty string');
      }
      search.set('track', params.track);
    }

    if (params.limit !== undefined) {
      if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100) {
        fail('invalid_input', 'limit must be an integer between 1 and 100');
      }
      search.set('limit', String(params.limit));
    }

    if (params.offset !== undefined) {
      if (!Number.isInteger(params.offset) || params.offset < 0) {
        fail('invalid_input', 'offset must be a non negative integer');
      }
      search.set('offset', String(params.offset));
    }

    const query = search.toString();
    const url = query.length > 0 ? `${baseUrl}/jobs?${query}` : `${baseUrl}/jobs`;

    return (await call(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      retryServer: true,
      retryNetwork: true,
      unwrap: (parsed) => {
        if (!parsed || typeof parsed !== 'object') {
          fail('invalid_response', 'registry answer is not an object');
        }
        const record = parsed as Record<string, unknown>;
        if (!Array.isArray(record.jobs)) {
          fail('invalid_response', 'registry answer has no jobs array');
        }
        const count = typeof record.count === 'number' ? record.count : record.jobs.length;
        return { jobs: record.jobs as Job[], count };
      },
    })) as ListJobsResult;
  }

  async function getJob(id: string): Promise<Job> {
    const jobId = assertJobId(id);
    const url = `${baseUrl}/jobs/${encodeURIComponent(jobId)}`;
    return (await call(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      retryServer: true,
      retryNetwork: true,
      unwrap: (parsed) => {
        if (!parsed || typeof parsed !== 'object') {
          fail('invalid_response', 'registry answer is not an object');
        }
        const job = (parsed as Record<string, unknown>).job;
        if (!job || typeof job !== 'object') {
          fail('invalid_response', 'registry answer has no job');
        }
        return job as Job;
      },
    })) as Job;
  }

  async function submit(jobId: string, input: SubmitInput): Promise<Submission> {
    const id = assertJobId(jobId);
    if (!input || typeof input !== 'object') {
      fail('invalid_input', 'submission input must be an object');
    }

    if (!isNonEmptyString(input.builder) || input.builder.trim().length < 2 || input.builder.length > 80) {
      fail('invalid_input', 'builder must be between 2 and 80 characters');
    }
    if (!isNonEmptyString(input.contact)) {
      fail('invalid_input', 'contact must be a non empty string');
    }
    if (!isNonEmptyString(input.agent_did) || !DID_PATTERN.test(input.agent_did)) {
      fail('invalid_input', 'agent_did must look like did:method:identifier');
    }
    if (typeof input.payout_address !== 'string' || !PAYOUT_PATTERN.test(input.payout_address)) {
      fail('invalid_input', 'payout_address must be 0x followed by 40 hex characters');
    }
    if (typeof input.repo_or_patch_url !== 'string' || !isHttpsUrl(input.repo_or_patch_url)) {
      fail('invalid_input', 'repo_or_patch_url must be an https link');
    }
    if (input.notes !== undefined) {
      if (typeof input.notes !== 'string' || input.notes.length > 2000) {
        fail('invalid_input', 'notes must be a string of at most 2000 characters');
      }
    }

    const body: Record<string, string> = {
      builder: input.builder,
      contact: input.contact,
      repo_or_patch_url: input.repo_or_patch_url,
      payout_address: input.payout_address,
      agent_did: input.agent_did,
    };
    if (input.notes !== undefined) body.notes = input.notes;

    const url = `${baseUrl}/jobs/${encodeURIComponent(id)}/submissions`;

    return (await call(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      retryServer: false,
      retryNetwork: false,
      unwrap: (parsed) => {
        if (!parsed || typeof parsed !== 'object') {
          fail('invalid_response', 'registry answer is not an object');
        }
        const submission = (parsed as Record<string, unknown>).submission;
        if (!submission || typeof submission !== 'object') {
          fail('invalid_response', 'registry answer has no submission');
        }
        return submission as Submission;
      },
    })) as Submission;
  }

  return { listJobs, getJob, submit };
}
