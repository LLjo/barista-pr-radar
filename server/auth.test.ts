import { describe, expect, test } from "bun:test";
import { resolveToken, type AuthDeps } from "./auth.js";

/** A stand-in for the SDK helper: it caches whatever it probed, null included, until invalidated. */
function fakeHost(initial: string | null) {
  let available = initial;
  let cache: { token: string | null } | null = null;
  let probes = 0;
  const deps: AuthDeps = {
    resolve: () => {
      if (cache) return cache.token;
      probes++;
      cache = { token: available };
      return available;
    },
    invalidate: () => { cache = null; },
    env: () => undefined,
  };
  return { deps, login: (t: string) => { available = t; }, probes: () => probes };
}

describe("resolveToken", () => {
  test("no token, then `gh auth login`: the very next resolve finds the token", () => {
    const host = fakeHost(null);
    expect(resolveToken(host.deps)).toEqual({ token: null, source: "none" });
    host.login("gho_new");
    expect(resolveToken(host.deps)).toEqual({ token: "gho_new", source: "gh" });
  });

  test("a stale cached null is never returned", () => {
    const host = fakeHost(null);
    host.deps.resolve(); // someone else cached the null
    host.login("gho_new");
    expect(resolveToken(host.deps).token).toBe("gho_new");
  });

  test("a real token stays cached: no re-probe", () => {
    const host = fakeHost("gho_a");
    resolveToken(host.deps);
    resolveToken(host.deps);
    expect(host.probes()).toBe(1);
  });

  test("env token reports env", () => {
    const host = fakeHost("ghp_env");
    expect(resolveToken({ ...host.deps, env: () => "ghp_env" }).source).toBe("env");
  });
});
