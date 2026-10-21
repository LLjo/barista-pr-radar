import { describe, expect, test } from "bun:test";
import { AuthError, graphql, RATE_LIMIT_DEFAULT_MS, RateLimitError, RETRY_BACKOFF_MS, searchIssues, type GitHubDeps } from "./github.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

/** A mocked fetch: answers the queued responses (or throws the queued errors) in order. */
function fake(...answers: (Response | Error)[]) {
  let calls = 0;
  const slept: number[] = [];
  const deps: GitHubDeps = {
    fetch: async () => {
      calls++;
      const r = answers.shift();
      if (!r) throw new Error("unexpected extra request");
      if (r instanceof Error) throw r;
      return r;
    },
    token: () => "gho_x",
    invalidate: () => {},
    sleep: async (ms) => { slept.push(ms); },
  };
  return { deps, calls: () => calls, slept };
}

const timeout = () => Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });

describe("graphql retry", () => {
  for (const status of [502, 503, 504]) {
    test(`a ${status} is retried once and the retry's data returned`, async () => {
      const f = fake(json(status, { message: "Bad Gateway" }), json(200, { data: { ok: 1 } }));
      expect(await graphql<{ ok: number }>("q", {}, f.deps)).toEqual({ ok: 1 });
      expect(f.calls()).toBe(2);
    });
  }

  test("a 200 without data (GitHub's timeout answer) is retried once", async () => {
    const f = fake(json(200, { data: null, errors: [{ message: "timeout" }] }), json(200, { data: { ok: 1 } }));
    expect(await graphql<{ ok: number }>("q", {}, f.deps)).toEqual({ ok: 1 });
    expect(f.calls()).toBe(2);
  });

  test("the retry waits a short backoff first", async () => {
    const f = fake(json(502, {}), json(200, { data: { ok: 1 } }));
    await graphql("q", {}, f.deps);
    expect(f.slept).toEqual([RETRY_BACKOFF_MS]);
  });

  test("our own timeout is retried once", async () => {
    const f = fake(timeout(), json(200, { data: { ok: 1 } }));
    expect(await graphql<{ ok: number }>("q", {}, f.deps)).toEqual({ ok: 1 });
    expect(f.calls()).toBe(2);
  });

  test("a network error is retried once", async () => {
    const f = fake(new TypeError("fetch failed"), json(200, { data: { ok: 1 } }));
    expect(await graphql<{ ok: number }>("q", {}, f.deps)).toEqual({ ok: 1 });
  });

  test("two timeouts: a readable error", async () => {
    const f = fake(timeout(), timeout());
    await expect(graphql("q", {}, f.deps)).rejects.toThrow("GitHub did not answer within 20 s");
    expect(f.calls()).toBe(2);
  });

  test("two failures in a row: one retry only, then the error", async () => {
    const f = fake(json(502, {}), json(502, {}));
    await expect(graphql("q", {}, f.deps)).rejects.toThrow(/^GitHub 502/);
    expect(f.calls()).toBe(2);
  });

  test("a 200 with data is not retried", async () => {
    const f = fake(json(200, { data: { ok: 1 } }));
    await graphql("q", {}, f.deps);
    expect(f.calls()).toBe(1);
    expect(f.slept).toEqual([]);
  });

  test("a 400 is not retried", async () => {
    const f = fake(json(400, { errors: [{ message: "bad query" }] }));
    await expect(graphql("q", {}, f.deps)).rejects.toThrow("GitHub 400: bad query");
    expect(f.calls()).toBe(1);
  });

  test("401 twice is an AuthError", async () => {
    const f = fake(json(401, {}), json(401, {}));
    await expect(graphql("q", {}, f.deps)).rejects.toBeInstanceOf(AuthError);
  });
});

test("an error without a status text still reads as a sentence", async () => {
  const f = fake(json(502, {}), json(502, {}));
  await expect(graphql("q", {}, f.deps)).rejects.toThrow(/^GitHub 502: error$/);
});

describe("searchIssues", () => {
  const rest = (total: number, n: number, incomplete: boolean) =>
    json(200, { total_count: total, incomplete_results: incomplete, items: Array.from({ length: n }, (_, i) => ({ node_id: `PR_${i}` })) });

  test("a complete answer", async () => {
    expect(await searchIssues("q", fake(rest(3, 3, false)).deps)).toEqual({ ids: ["PR_0", "PR_1", "PR_2"], total: 3, incomplete: false });
  });

  test("GitHub's incomplete_results flag is passed on", async () => {
    expect((await searchIssues("q", fake(rest(23, 23, true)).deps)).incomplete).toBe(true);
  });

  test("fewer items than total_count (under the 50 page) counts as incomplete too", async () => {
    expect((await searchIssues("q", fake(rest(35, 27, false)).deps)).incomplete).toBe(true);
    expect((await searchIssues("q", fake(rest(80, 50, false)).deps)).incomplete).toBe(false); // just the page size
  });

  test("a 502 on the search is retried once", async () => {
    const f = fake(json(502, {}), rest(1, 1, false));
    expect((await searchIssues("q", f.deps)).ids).toEqual(["PR_0"]);
    expect(f.calls()).toBe(2);
  });
});

describe("rate limits back off instead of retrying", () => {
  const NOW = 1_800_000_000_000;
  const limited = (headers: Record<string, string> = {}, message = "You have exceeded a secondary rate limit. Please wait a few minutes…") =>
    new Response(JSON.stringify({ message }), { status: 403, headers });
  const at = (f: ReturnType<typeof fake>) => {
    f.deps.now = () => NOW;
    return graphql("q", {}, f.deps).then(() => { throw new Error("expected a RateLimitError"); }, (e) => e);
  };

  test("a secondary-rate-limit 403 without Retry-After: a 3 min pause, one request, no backoff sleep", async () => {
    const f = fake(limited());
    const err = await at(f);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAt).toBe(NOW + RATE_LIMIT_DEFAULT_MS);
    expect(f.calls()).toBe(1);
    expect(f.slept).toEqual([]);
  });

  test("Retry-After is honoured", async () => {
    expect((await at(fake(limited({ "retry-after": "120" })))).retryAt).toBe(NOW + 120_000);
  });

  test("a Retry-After 429 counts even without the words", async () => {
    const f = fake(new Response("{}", { status: 429, headers: { "retry-after": "30" } }));
    expect((await at(f)).retryAt).toBe(NOW + 30_000);
  });

  test("an exhausted primary limit waits for x-ratelimit-reset", async () => {
    const reset = (NOW + 600_000) / 1000;
    const err = await at(fake(limited({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }, "API rate limit exceeded")));
    expect(err.retryAt).toBe(NOW + 600_000);
  });

  test("a plain 403 is an ordinary error", async () => {
    const f = fake(json(403, { message: "Resource not accessible by integration" }));
    await expect(graphql("q", {}, f.deps)).rejects.toThrow("GitHub 403: Resource not accessible by integration");
  });
});
