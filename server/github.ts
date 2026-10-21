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
}

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
      signal: AbortSignal.timeout(30_000),
    }),
  token: () => resolveToken().token,
  invalidate: invalidateGitHubToken,
};

/** GitHub's gateway giving up on a slow query: worth one more try. */
const TRANSIENT = new Set([502, 503, 504]);

type Body<T> = { data?: T | null; errors?: { message: string }[] } | null;

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

/**
 * POST one GraphQL query. A 502/503/504, or a 200 without data (GitHub's timeout answer), is
 * retried once; a second failure is reported.
 */
export async function graphql<T>(query: string, variables: Record<string, unknown>, deps: GitHubDeps = realDeps): Promise<T> {
  let { res, body } = await send<T>(deps, query, variables);
  if (TRANSIENT.has(res.status) || (res.ok && !body?.data)) ({ res, body } = await send<T>(deps, query, variables));
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${body?.errors?.[0]?.message ?? res.statusText}`);
  if (!body?.data) {
    const why = body?.errors?.map((e) => e.message).join("; ");
    throw new Error(why ? `GitHub: ${why}` : "GitHub returned no data");
  }
  return body.data;
}
