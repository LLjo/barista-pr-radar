import { invalidateGitHubToken, resolveGitHubToken } from "@barista/types/github-auth";

const ENDPOINT = "https://api.github.com/graphql";

/** No usable GitHub login on the host: no env token, no `gh` login, or GitHub rejected it twice. */
export class AuthError extends Error {
  constructor(message = "GitHub is not signed in on the Barista host") {
    super(message);
    this.name = "AuthError";
  }
}

async function post(token: string, query: string, variables: Record<string, unknown>): Promise<Response> {
  return fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "barista-pr-radar",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
}

/** POST one GraphQL query. A 401 drops the cached token and retries once with a fresh one. */
export async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  let token = resolveGitHubToken();
  if (!token) throw new AuthError();
  let res = await post(token, query, variables);
  if (res.status === 401) {
    invalidateGitHubToken();
    token = resolveGitHubToken();
    if (!token) throw new AuthError();
    res = await post(token, query, variables);
    if (res.status === 401) throw new AuthError("GitHub rejected the host's token (401)");
  }
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${body?.errors?.[0]?.message ?? res.statusText}`);
  if (body?.errors?.length && !body.data) throw new Error(`GitHub: ${body.errors.map((e) => e.message).join("; ")}`);
  if (!body?.data) throw new Error("GitHub returned no data");
  return body.data;
}
