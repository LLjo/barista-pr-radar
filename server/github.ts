import { invalidateGitHubToken } from "@barista/types/github-auth";
import { resolveToken } from "./auth.js";

const ENDPOINT = "https://api.github.com/graphql";

/** No usable GitHub login on the host: no env token, no `gh` login, or GitHub rejected it twice. */
export class AuthError extends Error {
  constructor(message = "GitHub is not signed in on the Barista host") {
    super(message);
    this.name = "AuthError";
  }
}

export interface GitHubDeps {
  post: (token: string, query: string, variables: Record<string, unknown>) => Promise<Response>;
  token: () => string | null;
  invalidate: () => void;
  sleep: (ms: number) => Promise<void>;
}

/** Our own cut-off per request: GitHub answers a slow query at ~10 s, so 20 s means a hang. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** The wait before the one retry. */
export const RETRY_BACKOFF_MS = 1_000;

const realDeps: GitHubDeps = {
  post: (token, query, variables) =>
    fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "barista-pr-radar",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
  token: () => resolveToken().token,
  invalidate: invalidateGitHubToken,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** GitHub's gateway giving up on a slow query: worth one more try. */
const TRANSIENT = new Set([502, 503, 504]);

type Body<T> = { data?: T | null; errors?: { message: string }[]; message?: string } | null;

/** One request with the 401 handling: drop the cached token and retry once with a fresh one. */
async function send<T>(deps: GitHubDeps, query: string, variables: Record<string, unknown>): Promise<{ res: Response; body: Body<T> }> {
  let token = deps.token();
  if (!token) throw new AuthError();
  let res = await deps.post(token, query, variables);
  if (res.status === 401) {
    deps.invalidate();
    token = deps.token();
    if (!token) throw new AuthError();
    res = await deps.post(token, query, variables);
    if (res.status === 401) throw new AuthError("GitHub rejected the host's token (401)");
  }
  return { res, body: (await res.json().catch(() => null)) as Body<T> };
}

type Attempt<T> = { res: Response; body: Body<T> } | { thrown: Error };

async function attempt<T>(deps: GitHubDeps, query: string, variables: Record<string, unknown>): Promise<Attempt<T>> {
  try {
    return await send<T>(deps, query, variables);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    return { thrown: err as Error }; // our timeout, or the network
  }
}

/** Worth one more try: GitHub's gateway gave up, it answered without data, or the request hung or dropped. */
function transient<T>(a: Attempt<T>): boolean {
  if ("thrown" in a) return true;
  return TRANSIENT.has(a.res.status) || (a.res.ok && !a.body?.data);
}

/**
 * POST one GraphQL query. A 502/503/504, a 200 without data (GitHub's timeout answer), our own
 * timeout or a network error is retried once after a short backoff; a second failure is reported.
 */
export async function graphql<T>(query: string, variables: Record<string, unknown>, deps: GitHubDeps = realDeps): Promise<T> {
  let a = await attempt<T>(deps, query, variables);
  if (transient(a)) {
    await deps.sleep(RETRY_BACKOFF_MS);
    a = await attempt<T>(deps, query, variables);
  }
  if ("thrown" in a) {
    const timedOut = a.thrown.name === "TimeoutError" || a.thrown.name === "AbortError";
    throw new Error(timedOut ? `GitHub did not answer within ${REQUEST_TIMEOUT_MS / 1000} s` : `GitHub unreachable: ${a.thrown.message}`);
  }
  const { res, body } = a;
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${body?.errors?.[0]?.message || body?.message || res.statusText || "error"}`);
  if (!body?.data) {
    const why = body?.errors?.map((e) => e.message).join("; ");
    throw new Error(why ? `GitHub: ${why}` : "GitHub returned no data");
  }
  return body.data;
}
