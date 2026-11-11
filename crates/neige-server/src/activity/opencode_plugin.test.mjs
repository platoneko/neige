import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";

const pluginSource = readFileSync(
  new URL("./opencode_plugin.js", import.meta.url),
  "utf8",
);
const pluginModule = await import(
  `data:text/javascript;base64,${Buffer.from(pluginSource).toString("base64")}`
);

function loadApplyEvent() {
  const path = join(dirname(fileURLToPath(import.meta.url)), "opencode_plugin.js");
  const src = readFileSync(path, "utf8")
    .replaceAll("export const ", "const ")
    .replace("export default", "const pluginDefinition =");
  const sandbox = {
    console,
    Set,
    process: { env: {} },
    fetch() {
      throw new Error("fetch should not run in applyEvent tests");
    },
  };
  vm.runInNewContext(`${src}\nthis.applyEvent = applyEvent;`, sandbox);
  return sandbox.applyEvent;
}

const applyEvent = loadApplyEvent();

function status(id, type) {
  return { type: "session.status", properties: { sessionID: id, status: { type } } };
}

test("a finished root turn reports idle", () => {
  const busy = new Set();
  assert.equal(applyEvent(status("root", "busy"), busy), "session.busy");
  assert.equal(applyEvent(status("root", "idle"), busy), "session.idle");
  assert.equal(busy.size, 0);
});

test("a child going idle does not idle the pane while the root is working", () => {
  const busy = new Set();
  assert.equal(applyEvent(status("root", "busy"), busy), "session.busy");
  assert.equal(applyEvent(status("child", "busy"), busy), "session.busy");
  assert.equal(applyEvent(status("child", "idle"), busy), "session.busy");
  assert.equal(applyEvent(status("root", "idle"), busy), "session.idle");
});

test("deprecated session.idle matches canonical status idle", () => {
  const busy = new Set(["root"]);
  assert.equal(
    applyEvent({ type: "session.idle", properties: { sessionID: "root" } }, busy),
    "session.idle",
  );
});

test("session.created is idle until a turn starts, and ignores child sessions", () => {
  const busy = new Set();
  assert.equal(
    applyEvent(
      { type: "session.created", properties: { info: { id: "root" } } },
      busy,
    ),
    "session.created",
  );
  assert.equal(
    applyEvent(
      {
        type: "session.created",
        properties: { info: { id: "child", parentID: "root" } },
      },
      busy,
    ),
    null,
  );
});

test("permission.asked surfaces even mid-turn", () => {
  const busy = new Set(["root"]);
  assert.equal(
    applyEvent({ type: "permission.asked", properties: { sessionID: "root" } }, busy),
    "permission.asked",
  );
  assert.ok(busy.has("root"));
});

test("retry counts as busy", () => {
  const busy = new Set();
  assert.equal(applyEvent(status("root", "retry"), busy), "session.busy");
});

async function withReporter(run) {
  const posts = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(req.url, "/api/hooks/neige-test");
    assert.equal(req.headers.authorization, "Bearer test-token");
    posts.push(JSON.parse(body).hook_event_name);
    res.writeHead(204).end();
  });
  const keys = ["NEIGE_SESSION_ID", "NEIGE_SERVER_URL", "NEIGE_HOOK_TOKEN"];
  const previous = keys.map((key) => process.env[key]);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.NEIGE_SESSION_ID = "neige-test";
  process.env.NEIGE_SERVER_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.NEIGE_HOOK_TOKEN = "test-token";
  try {
    await run(posts);
  } finally {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function reportV2(events, posts) {
  let drained;
  const done = new Promise((resolve) => { drained = resolve; });
  const ctx = {
    event: {
      async *subscribe() {
        try {
          yield* events;
        } finally {
          drained();
        }
      },
    },
  };
  assert.equal(typeof pluginModule.default?.setup, "function");
  const dispose = await pluginModule.default.setup(ctx);
  assert.equal(typeof dispose, "function");
  try {
    await done;
  } finally {
    await dispose();
  }
  return posts;
}

test("the default v1 entry still reports busy and idle", { timeout: 5000 }, async () => {
  await withReporter(async (posts) => {
    assert.equal(typeof pluginModule.default?.server, "function");
    const hooks = await pluginModule.default.server();
    await hooks.event({ event: status("root", "busy") });
    await hooks.event({ event: status("root", "idle") });
    assert.deepEqual(posts, ["session.busy", "session.idle"]);
  });
});

for (const ending of ["succeeded", "failed", "interrupted"]) {
  test(`v2 execution start and ${ending} reach neige`, { timeout: 5000 }, async () => {
    await withReporter(async (posts) => {
      await reportV2([
        { type: "session.created", data: { sessionID: "root" } },
        { type: "session.execution.started", data: { sessionID: "root" } },
        { type: `session.execution.${ending}`, data: { sessionID: "root" } },
      ], posts);
      assert.deepEqual(posts, ["session.created", "session.busy", "session.idle"]);
    });
  });
}

test("v2 child completion preserves a working root", { timeout: 5000 }, async () => {
  await withReporter(async (posts) => {
    await reportV2([
      { type: "session.execution.started", data: { sessionID: "root" } },
      { type: "session.created", data: { sessionID: "child", parentID: "root" } },
      { type: "session.execution.started", data: { sessionID: "child" } },
      { type: "session.execution.succeeded", data: { sessionID: "child" } },
      { type: "session.execution.succeeded", data: { sessionID: "root" } },
    ], posts);
    assert.deepEqual(posts, ["session.busy", "session.idle"]);
  });
});

test("v2 setup is inert outside neige", async () => {
  const previous = process.env.NEIGE_SESSION_ID;
  delete process.env.NEIGE_SESSION_ID;
  try {
    assert.equal(typeof pluginModule.default?.setup, "function");
    const dispose = await pluginModule.default.setup({
      event: { subscribe() { assert.fail("must not subscribe outside neige"); } },
    });
    await dispose();
  } finally {
    if (previous === undefined) delete process.env.NEIGE_SESSION_ID;
    else process.env.NEIGE_SESSION_ID = previous;
  }
});

test("v2 dispose closes a pending iterator and stops late events", { timeout: 5000 }, async () => {
  await withReporter(async (posts) => {
    let pending;
    let closed = false;
    const iterator = {
      next() { return new Promise((resolve) => { pending = resolve; }); },
      async return() {
        closed = true;
        pending({ done: false, value: {
          type: "session.execution.started", data: { sessionID: "root" },
        } });
        return { done: true };
      },
      [Symbol.asyncIterator]() { return this; },
    };
    assert.equal(typeof pluginModule.default?.setup, "function");
    const dispose = await pluginModule.default.setup({ event: { subscribe: () => iterator } });
    await dispose();
    assert.equal(closed, true);
    assert.deepEqual(posts, []);
  });
});
