import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";

function loadApplyEvent() {
  const path = join(dirname(fileURLToPath(import.meta.url)), "opencode_plugin.js");
  const src = readFileSync(path, "utf8").replaceAll("export const ", "const ");
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
