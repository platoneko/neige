import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";

const pluginSource = readFileSync(
  new URL("./opencode_plugin.js", import.meta.url),
  "utf8",
);
const pluginModule = await import(
  `data:text/javascript;base64,${Buffer.from(pluginSource).toString("base64")}`
);

function loadTui() {
  let effect;
  const src = readFileSync(new URL("./opencode_tui.js", import.meta.url), "utf8")
    .replace(/^import .*;$/gm, "")
    .replace("export default", "this.plugin =");
  const sandbox = {
    NeigeActivityPlugin: pluginModule.NeigeActivityPlugin,
    process,
    console,
    createRoot: (run) => run(() => { effect = undefined; }),
    createEffect: (run) => { effect = run; run(); },
  };
  vm.runInNewContext(src, sandbox);
  return { plugin: sandbox.plugin, refresh: () => effect?.() };
}

function tuiContext() {
  const state = { selected: "root", status: {}, children: {}, permissions: {}, forms: {} };
  return {
    state,
    ui: { router: { current: () => state.selected
      ? { type: "session", sessionID: state.selected } : { type: "home" } } },
    data: { session: {
      root: (id) => id,
      family: (id) => [id, ...(state.children[id] ?? [])],
      status: (id) => state.status[id] ?? "idle",
      permission: { list: (id) => state.permissions[id] ?? [] },
      form: { list: (id) => state.forms[id] ?? [] },
    } },
  };
}

async function waitForPosts(posts, count) {
  for (let i = 0; i < 100 && posts.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(posts.length, count);
}

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

test("the default v1 entry still reports busy and idle", { timeout: 5000 }, async () => {
  await withReporter(async (posts) => {
    assert.equal(typeof pluginModule.default?.server, "function");
    const hooks = await pluginModule.default.server();
    await hooks.event({ event: status("root", "busy") });
    await hooks.event({ event: status("root", "idle") });
    assert.deepEqual(posts, ["session.busy", "session.idle"]);
  });
});

test("v2 shared server does not attribute its events to the terminal that started it", { timeout: 5000 }, async () => {
  await withReporter(async (posts) => {
    let subscribed = false;
    const dispose = await pluginModule.default.setup({ event: { async *subscribe() {
      subscribed = true;
      yield { type: "session.execution.started", data: { sessionID: "other-pane" } };
    } } });
    await dispose?.();
    assert.equal(subscribed, false);
    assert.deepEqual(posts, []);
  });
});

test("v2 TUI publishes an already idle selected session without a new execution event", { timeout: 5000 }, async () => {
  await withReporter(async (posts) => {
    const { plugin } = loadTui();
    const dispose = await plugin.setup(tuiContext());
    await waitForPosts(posts, 1);
    await dispose();
    assert.deepEqual(posts, ["session.idle"]);
  });
});

test("v2 TUI tracks the selected session instead of another terminal's work", { timeout: 5000 }, async () => {
  await withReporter(async (posts) => {
    const ctx = tuiContext();
    ctx.state.status.other = "running";
    const { plugin, refresh } = loadTui();
    const dispose = await plugin.setup(ctx);
    await waitForPosts(posts, 1);
    ctx.state.status.root = "running";
    refresh();
    await waitForPosts(posts, 2);
    ctx.state.status.root = "idle";
    refresh();
    await waitForPosts(posts, 3);
    await dispose();
    assert.deepEqual(posts, ["session.idle", "session.busy", "session.idle"]);
  });
});

test("v2 TUI aggregates children and drops the previous session on navigation", { timeout: 5000 }, async () => {
  await withReporter(async (posts) => {
    const ctx = tuiContext();
    ctx.state.children.root = ["child"];
    ctx.state.status.child = "running";
    const { plugin, refresh } = loadTui();
    const dispose = await plugin.setup(ctx);
    await waitForPosts(posts, 1);
    ctx.state.selected = "other";
    refresh();
    await waitForPosts(posts, 2);
    await dispose();
    assert.deepEqual(posts, ["session.busy", "session.idle"]);
  });
});

test("v2 TUI clears busy when navigating home", { timeout: 5000 }, async () => {
  await withReporter(async (posts) => {
    const ctx = tuiContext();
    ctx.state.status.root = "running";
    const { plugin, refresh } = loadTui();
    const dispose = await plugin.setup(ctx);
    await waitForPosts(posts, 1);
    ctx.state.selected = null;
    refresh();
    await waitForPosts(posts, 2);
    await dispose();
    assert.deepEqual(posts, ["session.busy", "session.idle"]);
  });
});

test("v2 TUI reports permission and form waits then resumes busy", { timeout: 5000 }, async () => {
  await withReporter(async (posts) => {
    const ctx = tuiContext();
    ctx.state.status.root = "running";
    ctx.state.permissions.root = [{ id: "permission" }];
    const { plugin, refresh } = loadTui();
    const dispose = await plugin.setup(ctx);
    await waitForPosts(posts, 1);
    ctx.state.permissions.root = [];
    refresh();
    await waitForPosts(posts, 2);
    ctx.state.forms.root = [{ id: "form" }];
    refresh();
    await waitForPosts(posts, 3);
    await dispose();
    assert.deepEqual(posts, ["permission.asked", "session.busy", "permission.asked"]);
  });
});

test("v2 TUI serializes rapid snapshots and leaves the final idle state", { timeout: 5000 }, async () => {
  await withReporter(async (posts) => {
    const ctx = tuiContext();
    ctx.state.status.root = "running";
    const { plugin, refresh } = loadTui();
    const dispose = await plugin.setup(ctx);
    ctx.state.status.root = "idle";
    refresh();
    ctx.state.status.root = "running";
    refresh();
    ctx.state.status.root = "idle";
    refresh();
    await waitForPosts(posts, 2);
    await dispose();
    assert.deepEqual(posts, ["session.busy", "session.idle"]);
  });
});

test("v2 TUI cleanup stops later snapshots", { timeout: 5000 }, async () => {
  await withReporter(async (posts) => {
    const ctx = tuiContext();
    const { plugin, refresh } = loadTui();
    const dispose = await plugin.setup(ctx);
    await waitForPosts(posts, 1);
    await dispose();
    ctx.state.status.root = "running";
    refresh();
    assert.deepEqual(posts, ["session.idle"]);
  });
});

test("v2 TUI is inert outside neige", async () => {
  const previous = process.env.NEIGE_SESSION_ID;
  delete process.env.NEIGE_SESSION_ID;
  try {
    const { plugin } = loadTui();
    const dispose = await plugin.setup({});
    await dispose();
  } finally {
    if (previous === undefined) delete process.env.NEIGE_SESSION_ID;
    else process.env.NEIGE_SESSION_ID = previous;
  }
});

test("v2 installer updates a registered adapter and preserves a backup", async () => {
  const tmp = join(process.cwd(), "_local/tmp");
  mkdirSync(tmp, { recursive: true });
  const dir = mkdtempSync(join(tmp, "opencode-install-"));
  const target = join(dir, "native");
  const backup = join(dir, "backup");
  mkdirSync(target);
  const previous = 'export default { id: "neige-activity", setup() {} };\n';
  writeFileSync(join(target, "index.js"), previous);
  try {
    const script = fileURLToPath(new URL("../../../../scripts/install-opencode2-activity.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, target, backup], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(backup, "index.js"), "utf8"), previous);
    assert.equal(readFileSync(join(target, "index.js"), "utf8"), pluginSource);
    assert.equal(readFileSync(join(target, "tui.js"), "utf8"),
      readFileSync(new URL("./opencode_tui.js", import.meta.url), "utf8"));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("v2 installer refuses an unrelated plugin before writing either entry", () => {
  const tmp = join(process.cwd(), "_local/tmp");
  mkdirSync(tmp, { recursive: true });
  const dir = mkdtempSync(join(tmp, "opencode-install-"));
  const target = join(dir, "native");
  mkdirSync(target);
  const previous = 'export default { id: "other-plugin" };\n';
  writeFileSync(join(target, "index.js"), previous);
  try {
    const script = fileURLToPath(new URL("../../../../scripts/install-opencode2-activity.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, target, join(dir, "backup")], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(target, "index.js"), "utf8"), previous);
    assert.throws(() => readFileSync(join(target, "tui.js")), { code: "ENOENT" });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("v2 installer rejects a missing registered package", () => {
  const tmp = join(process.cwd(), "_local/tmp");
  mkdirSync(tmp, { recursive: true });
  const dir = mkdtempSync(join(tmp, "opencode-install-"));
  const target = join(dir, "missing");
  try {
    const script = fileURLToPath(new URL("../../../../scripts/install-opencode2-activity.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, target, join(dir, "backup")], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("v2 installer restores a partial update when the server entry is read-only", (t) => {
  if (process.getuid?.() === 0) return t.skip("root bypasses file write permissions");
  const tmp = join(process.cwd(), "_local/tmp");
  mkdirSync(tmp, { recursive: true });
  const dir = mkdtempSync(join(tmp, "opencode-install-"));
  const target = join(dir, "native");
  mkdirSync(target);
  const previous = 'export default { id: "neige-activity", setup() {} };\n';
  writeFileSync(join(target, "index.js"), previous);
  chmodSync(join(target, "index.js"), 0o444);
  try {
    const script = fileURLToPath(new URL("../../../../scripts/install-opencode2-activity.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, target, join(dir, "backup")], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(target, "index.js"), "utf8"), previous);
    assert.equal(existsSync(join(target, "tui.js")), false);
    assert.equal(readFileSync(join(dir, "backup/index.js"), "utf8"), previous);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
