import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
mkdirSync(target, { recursive: true });
mkdirSync(backup, { recursive: true });
for (const [name] of entries) {
  const path = join(target, name);
  if (existsSync(path)) copyFileSync(path, join(backup, name));
}
for (const [name, source] of entries) {
  copyFileSync(fileURLToPath(new URL(source, sources)), join(target, name));
}
console.log(`Installed OpenCode 2 activity client at ${target}; previous entries saved to ${backup}`);
