import { invalidateGitHubToken, resolveGitHubToken } from "@barista/types/github-auth";
import type { AuthSource } from "./types.js";

export interface AuthDeps {
  resolve: () => string | null;
  invalidate: () => void;
  env: () => string | undefined;
}

const realDeps: AuthDeps = {
  resolve: () => resolveGitHubToken(),
  invalidate: invalidateGitHubToken,
  env: () => process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
};

/**
 * The host's GitHub token and where it came from. The SDK helper caches its answer for 30 min,
 * a "no token" answer included, so a `gh auth login` would leave the banner up that long. A
 * null is therefore never trusted from the cache: re-probe, and drop whatever null it leaves
 * behind so the next poll or ↻ asks `gh` again. A real token keeps the 30-minute cache.
 */
export function resolveToken(deps: AuthDeps = realDeps): { token: string | null; source: AuthSource } {
  let token = deps.resolve();
  if (!token) {
    deps.invalidate();
    token = deps.resolve();
    if (!token) deps.invalidate();
  }
  if (!token) return { token: null, source: "none" };
  return { token, source: deps.env() ? "env" : "gh" };
}
