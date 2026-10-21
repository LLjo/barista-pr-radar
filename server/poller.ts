import { nats } from "@barista/plugin-sdk";
import { resolveToken } from "./auth.js";
import { collect } from "./collect.js";
import { createPoller } from "./poll-loop.js";
import { buildSearchQueries } from "./query.js";
import { getSettings } from "./settings.js";
import { subjects } from "./subjects.js";

const poller = createPoller({
  collect,
  buildQueries: buildSearchQueries,
  resolveToken,
  getSettings,
  changed: () => nats.publish(subjects.changed, undefined),
});

export const { getSnapshot, poll, pollFresh, schedule } = poller;
export const startPoller = poller.start;
export const stopPoller = poller.stop;
