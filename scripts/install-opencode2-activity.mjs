import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const [packageArg, backupArg] = process.argv.slice(2);
if (!packageArg || !backupArg) {
  throw new Error("Usage: node scripts/install-opencode2-activity.mjs <registered-package-dir> <backup-dir>");
}
const target = resolve(packageArg);
const backup = resolve(backupArg);
const sources = new URL("../crates/neige-server/src/activity/", import.meta.url);
// Install the TUI entry before changing index.js, whose watcher reloads the
// package. The shared server entry must stop reporting once the TUI takes over.
const entries = [
  ["tui.js", "opencode_tui.js"],
  ["index.js", "opencode_plugin.js"],
];
if (!existsSync(join(target, "index.js"))) {
  throw new Error(`Expected an existing registered neige-activity package: ${target}`);
}
for (const [name] of entries) {
  const path = join(target, name);
  if (!existsSync(path)) continue;
  const previous = readFileSync(path, "utf8");
  if (!previous.includes('id: "neige-activity"')) {
    throw new Error(`Refusing to overwrite an unrelated plugin: ${path}`);
  }
  if (existsSync(join(backup, name))) {
    throw new Error(`Backup already exists: ${join(backup, name)}`);
  }
}
mkdirSync(backup, { recursive: true });
for (const [name] of entries) {
  const path = join(target, name);
  if (existsSync(path)) copyFileSync(path, join(backup, name));
}
const attempted = [];
try {
  for (const [name, source] of entries) {
    attempted.push(name);
    copyFileSync(fileURLToPath(new URL(source, sources)), join(target, name));
  }
} catch (error) {
  const errors = [error];
  for (const name of attempted.reverse()) {
    const path = join(target, name);
    const saved = join(backup, name);
    try {
      if (existsSync(saved)) {
        // A failed write can leave the old file intact and read-only.
        if (!existsSync(path) || !readFileSync(path).equals(readFileSync(saved))) {
          copyFileSync(saved, path);
        }
      } else if (existsSync(path)) {
        unlinkSync(path);
      }
    } catch (rollbackError) {
      errors.push(rollbackError);
    }
  }
  throw new AggregateError(errors, `Installation failed; originals are saved at ${backup}`);
}
console.log(`Installed OpenCode 2 activity client at ${target}; previous entries saved to ${backup}`);
