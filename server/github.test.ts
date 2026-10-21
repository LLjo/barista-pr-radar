import { describe, expect, test } from "bun:test";
import { AuthError, graphql, RETRY_BACKOFF_MS, type GitHubDeps } from "./github.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

/** A mocked fetch: answers the queued responses (or throws the queued errors) in order. */
function fake(...answers: (Response | Error)[]) {
  let calls = 0;
  const slept: number[] = [];
  const deps: GitHubDeps = {
    post: async () => {
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
