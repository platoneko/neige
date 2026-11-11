// neige-activity — managed by `neige-server hooks install`
//
// OpenCode plugin: project session.status / session.idle / permission.asked
// onto neige's activity ingest. Loaded from ~/.config/opencode/plugins/ so a
// `opencode` typed at a neige shell prompt is seen, not just one neige spawned.
//
// Two rules, same as neige-hook:
//   * Never throw. A status dot is never worth stalling the agent.
//   * Stay silent outside neige. No NEIGE_SESSION_ID ⇒ return empty hooks.

const POST_TIMEOUT_MS = 3000;
const OPENCODE2_EXECUTION_STATUS = new Map([
  ["session.execution.started", "busy"],
  ["session.execution.succeeded", "idle"],
  ["session.execution.failed", "idle"],
  ["session.execution.interrupted", "idle"],
]);

function reportError(err) {
  const message = err && err.message ? err.message : err;
  console.error("neige-activity:", message);
}

function statusType(event) {
  return event?.properties?.status?.type ?? null;
}

function sessionIdOf(event) {
  return event?.properties?.sessionID ?? event?.properties?.info?.id ?? null;
}

function normalizeType(type) {
  if (type === "permission.v2.asked") return "permission.asked";
  return type;
}

// Mutates `busy` (a Set of OpenCode session ids currently mid-turn) and
// returns the hook_event_name to POST, or null to leave activity alone.
//
// Child sessions (oh-my-opencode tools, the Task tool) emit their own
// session.status. A child going idle must not mark the neige pane idle
// while another session in the same process is still working — we only
// report idle when the set is empty.
function applyEvent(event, busy) {
  if (!event || typeof event.type !== "string") return null;
  const type = normalizeType(event.type);
  const id = sessionIdOf(event);

  if (type === "session.created") {
    if (event.properties?.info?.parentID) return null;
    return busy.size > 0 ? "session.busy" : "session.created";
  }

  if (type === "session.status") {
    const status = statusType(event);
    if (!id) return null;
    if (status === "busy" || status === "retry") {
      busy.add(id);
      return "session.busy";
    }
    if (status === "idle") {
      busy.delete(id);
      return busy.size > 0 ? "session.busy" : "session.idle";
    }
    return null;
  }

  if (type === "session.idle") {
    if (id) busy.delete(id);
    return busy.size > 0 ? "session.busy" : "session.idle";
  }

  if (type === "permission.asked") return "permission.asked";
  return null;
}

async function post(hookEventName) {
  const sessionId = process.env.NEIGE_SESSION_ID;
  const baseUrl = process.env.NEIGE_SERVER_URL;
  if (!sessionId || !baseUrl) return;
  const url = `${baseUrl.replace(/\/$/, "")}/api/hooks/${sessionId}`;
  const headers = {
    "content-type": "application/json",
    origin: baseUrl,
  };
  const token = process.env.NEIGE_HOOK_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ hook_event_name: hookEventName }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

// Accept the factory argument as an optional opaque parameter instead of
// destructuring. OpenCode can invoke the plugin factory with undefined
// during startup, and a throw there crashes the agent before any event.
export const NeigeActivityPlugin = async (_ctx) => {
  if (!process.env.NEIGE_SESSION_ID || !process.env.NEIGE_SERVER_URL) return {};
  const busy = new Set();
  let last = null;
  return {
    event: async (input) => {
      try {
        const name = applyEvent(input && input.event, busy);
        if (!name || name === last) return;
        await post(name);
        last = name;
      } catch (err) {
        reportError(err);
      }
    },
  };
};

// OpenCode 2 loads default.setup and streams { type, data } execution
// events instead of invoking the v1 event hook with session.status.
async function setupOpenCode2(ctx) {
  const noop = async () => {};
  if (!process.env.NEIGE_SESSION_ID || !process.env.NEIGE_SERVER_URL) return noop;
  if (typeof ctx?.event?.subscribe !== "function") return noop;
  try {
    const hooks = await NeigeActivityPlugin();
    const iterator = ctx.event.subscribe({
      types: ["session.created", ...OPENCODE2_EXECUTION_STATUS.keys(), "permission.asked"],
    })[Symbol.asyncIterator]();
    let stopped = false;
    const consuming = (async () => {
      while (!stopped) {
        const next = await iterator.next();
        if (stopped || next.done) break;
        let { type, data: properties } = next.value;
        const status = OPENCODE2_EXECUTION_STATUS.get(type);
        if (type === "session.created") {
          properties = { info: { ...properties, id: properties?.sessionID } };
        } else if (status) {
          type = "session.status";
          properties = { ...properties, status: { type: status } };
        }
        await hooks.event({ event: { type, properties } });
      }
    })().catch(reportError);
    return async () => {
      stopped = true;
      try {
        await iterator.return?.();
        await consuming;
      } catch (err) {
        reportError(err);
      }
    };
  } catch (err) {
    reportError(err);
    return noop;
  }
}

export default {
  id: "neige-activity",
  server: NeigeActivityPlugin,
  setup: setupOpenCode2,
};
