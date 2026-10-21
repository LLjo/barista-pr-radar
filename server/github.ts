import { invalidateGitHubToken } from "@barista/types/github-auth";
import { resolveToken } from "./auth.js";

const API = "https://api.github.com";

/** No usable GitHub login on the host: no env token, no `gh` login, or GitHub rejected it twice. */
export class AuthError extends Error {
  constructor(message = "GitHub is not signed in on the Barista host") {
    super(message);
    this.name = "AuthError";
  }
}

/** One HTTP call to api.github.com: a GraphQL POST or a REST GET. */
export interface GitHubRequest {
  method: "GET" | "POST";
  /** Path under https://api.github.com, with its query string. */
  path: string;
  body?: unknown;
}

export interface GitHubDeps {
  fetch: (token: string, req: GitHubRequest) => Promise<Response>;
  token: () => string | null;
  invalidate: () => void;
  sleep: (ms: number) => Promise<void>;
}

/** Our own cut-off per request: GitHub answers a slow query at ~10 s, so 20 s means a hang. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** The wait before the one retry. */
export const RETRY_BACKOFF_MS = 1_000;

const realDeps: GitHubDeps = {
  fetch: (token, req) =>
    fetch(`${API}${req.path}`, {
      method: req.method,
      headers: {
        Authorization: `bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "barista-pr-radar",
      },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
  token: () => resolveToken().token,
  invalidate: invalidateGitHubToken,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** GitHub's gateway giving up on a slow query: worth one more try. */
const TRANSIENT = new Set([502, 503, 504]);

type Body = { data?: unknown; errors?: { message: string }[]; message?: string } | null;

/** One request with the 401 handling: drop the cached token and retry once with a fresh one. */
async function send(deps: GitHubDeps, req: GitHubRequest): Promise<{ res: Response; body: Body }> {
  let token = deps.token();
  if (!token) throw new AuthError();
  let res = await deps.fetch(token, req);
  if (res.status === 401) {
    deps.invalidate();
    token = deps.token();
    if (!token) throw new AuthError();
    res = await deps.fetch(token, req);
    if (res.status === 401) throw new AuthError("GitHub rejected the host's token (401)");
  }
  return { res, body: (await res.json().catch(() => null)) as Body };
}

type Attempt = { res: Response; body: Body } | { thrown: Error };

async function attempt(deps: GitHubDeps, req: GitHubRequest): Promise<Attempt> {
  try {
    return await send(deps, req);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    return { thrown: err as Error }; // our timeout, or the network
  }
}

/**
 * Send `req`; `dataOf` picks the payload out of a 2xx body (null = GitHub answered without data).
 * A 502/503/504, a 2xx without data (GitHub's timeout answer), our own timeout or a network
 * error is retried once after a short backoff; a second failure is reported.
 */
async function call<T>(req: GitHubRequest, dataOf: (body: Body) => T | null, deps: GitHubDeps): Promise<T> {
  const transient = (a: Attempt) =>
    "thrown" in a || TRANSIENT.has(a.res.status) || (a.res.ok && dataOf(a.body) == null);
  let a = await attempt(deps, req);
  if (transient(a)) {
    await deps.sleep(RETRY_BACKOFF_MS);
    a = await attempt(deps, req);
  }
  if ("thrown" in a) {
    const timedOut = a.thrown.name === "TimeoutError" || a.thrown.name === "AbortError";
    throw new Error(timedOut ? `GitHub did not answer within ${REQUEST_TIMEOUT_MS / 1000} s` : `GitHub unreachable: ${a.thrown.message}`);
  }
  const { res, body } = a;
  // GitHub's 403/429 rate-limit text is a paragraph; the UI shows one line.
  if ((res.status === 403 || res.status === 429) && /rate limit/i.test(body?.message ?? "")) {
    throw new Error(`GitHub rate limit hit (${res.status}): showing the last good list until it lifts`);
  }
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${body?.errors?.[0]?.message || body?.message || res.statusText || "error"}`);
  const data = dataOf(body);
  if (data == null) {
    const why = body?.errors?.map((e) => e.message).join("; ");
    throw new Error(why ? `GitHub: ${why}` : "GitHub returned no data");
  }
  return data;
}

/** POST one GraphQL query (see {@link call} for the retry). */
export function graphql<T>(query: string, variables: Record<string, unknown>, deps: GitHubDeps = realDeps): Promise<T> {
  return call({ method: "POST", path: "/graphql", body: { query, variables } }, (b) => (b?.data ?? null) as T | null, deps);
}

/** What one search found: PR node ids, GitHub's count, and whether GitHub says it gave up early. */
export interface SearchHit {
  ids: string[];
  total: number;
  /** GitHub's `incomplete_results`: the search timed out inside GitHub and some matches are missing. */
  incomplete: boolean;
}

/**
 * Search through REST, not GraphQL: only REST's `/search/issues` says when GitHub's search engine
 * returned partial results (`incomplete_results`), which it often does for `author:@me` over orgs.
 */
export async function searchIssues(q: string, deps: GitHubDeps = realDeps): Promise<SearchHit> {
  type Rest = { total_count: number; incomplete_results: boolean; items: { node_id?: string }[] };
  const body = await call(
    { method: "GET", path: `/search/issues?q=${encodeURIComponent(q)}&per_page=50` },
    (b) => (b && typeof (b as unknown as Rest).total_count === "number" ? (b as unknown as Rest) : null),
    deps,
  );
  return {
    ids: body.items.map((i) => i.node_id).filter((id): id is string => !!id),
    total: body.total_count,
    incomplete: body.incomplete_results || body.items.length < Math.min(body.total_count, 50),
  };
}
