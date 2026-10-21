import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { getSnapshot, poll, pollFresh, schedule } from "./poller.js";
import { getSettings, saveSettings } from "./settings.js";
import { REFRESH_CHOICES } from "./types.js";

const ORG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^([A-Za-z0-9-]+\/)?[A-Za-z0-9._-]+$/;

const settingsBody = z.object({
  orgs: z.array(z.string().trim().regex(ORG, "not a GitHub org name")).max(10),
  repos: z.array(z.string().trim().regex(REPO, "not a repo name or owner/name")).max(20),
  refreshSec: z.union(REFRESH_CHOICES.map((n) => z.literal(n)) as [z.ZodLiteral<60>, z.ZodLiteral<300>, z.ZodLiteral<900>]),
});

const app = new Hono()
  .get("/settings", (c) => c.json(getSettings()))
  .put("/settings", zValidator("json", settingsBody), (c) => {
    const saved = saveSettings(c.req.valid("json"));
    // Refetch with the new scope now, then re-arm the timer at the (maybe new) interval.
    void pollFresh().then(() => schedule());
    return c.json(saved);
  })
  .get("/prs", (c) => c.json(getSnapshot()))
  .post("/refresh", async (c) => c.json(await poll()))
  .get("/count", (c) => c.json({ count: getSnapshot().reviewRequested.length }));

export type AppType = typeof app;
export default app;
