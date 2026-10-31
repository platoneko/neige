//! Installing neige's activity reporters into the user's agent configs.
//!
//! Two installs, one command:
//!
//! * Claude Code / grok: merge into `~/.claude/settings.json`. User-global
//!   rather than a per-spawn `--settings` file, because the interesting case
//!   is the `claude` a user types by hand at a shell prompt inside a neige
//!   terminal — no command line of ours ever touches that one. Claude Code
//!   merges hooks across settings sources, so a global install also covers
//!   the sessions neige spawns itself.
//! * OpenCode: drop `neige-activity.js` into `~/.config/opencode/plugins/`,
//!   which OpenCode auto-loads. Same reason: an `opencode` typed at the
//!   prompt has to report too.
//!
//! Every Claude write is a merge keyed on the shim's path: installing twice
//! is a no-op, and uninstalling removes only the entries pointing at our
//! shim, leaving hooks the user configured themselves alone. The OpenCode
//! plugin is our file; uninstall deletes it only when it still carries our
//! marker, so a user-written file of the same name is left alone.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::{HOOK_BINDINGS, settings_hooks_json};

pub fn settings_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(Path::new(&home).join(".claude").join("settings.json"))
}

/// Default location of the shim: alongside the running server binary, which
/// is where a `cargo build` or an install script puts both.
pub fn default_shim_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("locating neige-server: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "neige-server has no parent directory".to_string())?;
    Ok(dir.join("neige-hook"))
}

/// Marker that must appear in [`OPENCODE_PLUGIN_SOURCE`]. Uninstall uses it
/// to refuse deleting a file we didn't write.
pub const OPENCODE_PLUGIN_MARKER: &str =
    "neige-activity — managed by `neige-server hooks install`";

const OPENCODE_PLUGIN_SOURCE: &str = include_str!("opencode_plugin.js");

/// `~/.config/opencode/plugins/neige-activity.js`, honouring `XDG_CONFIG_HOME`.
pub fn opencode_plugin_path() -> Result<PathBuf, String> {
    let config = match std::env::var("XDG_CONFIG_HOME") {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => {
            let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
            Path::new(&home).join(".config")
        }
    };
    Ok(config
        .join("opencode")
        .join("plugins")
        .join("neige-activity.js"))
}

/// Write the OpenCode activity plugin, replacing any previous neige copy.
pub fn install_opencode_plugin(path: &Path) -> Result<(), String> {
    if !OPENCODE_PLUGIN_SOURCE.contains(OPENCODE_PLUGIN_MARKER) {
        return Err(
            "opencode_plugin.js is missing its install marker; refusing to install".to_string(),
        );
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    }
    std::fs::write(path, OPENCODE_PLUGIN_SOURCE)
        .map_err(|e| format!("writing {}: {e}", path.display()))
}

/// Remove the plugin if — and only if — it still carries our marker.
pub fn uninstall_opencode_plugin(path: &Path) -> Result<(), String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(());
    };
    if !text.contains(OPENCODE_PLUGIN_MARKER) {
        return Ok(());
    }
    std::fs::remove_file(path).map_err(|e| format!("removing {}: {e}", path.display()))
}

/// Point every bound hook at `shim`, replacing any previous neige install.
pub fn install(settings: &Path, shim: &Path) -> Result<(), String> {
    if !shim.is_file() {
        return Err(format!(
            "hook shim not found at {}; build it with `cargo build -p neige-hook`",
            shim.display()
        ));
    }
    let command = shim.to_str().ok_or("shim path is not valid UTF-8")?;
    let mut root = read_settings(settings)?;
    let hooks = hooks_map(&mut root);

    let generated = settings_hooks_json(command);
    for binding in HOOK_BINDINGS {
        let ours = generated["hooks"][binding.event][0].clone();
        let entries = hooks
            .entry(binding.event.to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        let Some(arr) = entries.as_array_mut() else {
            return Err(format!(
                "{}: hooks.{} is not an array; refusing to overwrite",
                settings.display(),
                binding.event
            ));
        };
        arr.retain(|group| !targets_shim(group, command));
        arr.push(ours);
    }
    write_settings(settings, &root)
}

/// Remove every hook entry pointing at `shim`, and prune the containers that
/// removal leaves empty so an uninstall restores the file to its prior shape.
pub fn uninstall(settings: &Path, shim: &Path) -> Result<(), String> {
    let command = shim.to_str().ok_or("shim path is not valid UTF-8")?;
    if !settings.exists() {
        return Ok(());
    }
    let mut root = read_settings(settings)?;
    let hooks = hooks_map(&mut root);
    for binding in HOOK_BINDINGS {
        let Some(arr) = hooks.get_mut(binding.event).and_then(Value::as_array_mut) else {
            continue;
        };
        arr.retain(|group| !targets_shim(group, command));
        if arr.is_empty() {
            hooks.remove(binding.event);
        }
    }
    if hooks.is_empty() {
        root.remove("hooks");
    }
    write_settings(settings, &root)
}

/// Whether a settings hook group dispatches to `command`. Groups the user
/// wrote themselves name a different command and are left alone.
fn targets_shim(group: &Value, command: &str) -> bool {
    group["hooks"]
        .as_array()
        .is_some_and(|hooks| hooks.iter().any(|h| h["command"] == command))
}

fn read_settings(path: &Path) -> Result<Map<String, Value>, String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(Map::new());
    };
    if text.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str(&text) {
        Ok(Value::Object(map)) => Ok(map),
        // Refuse rather than clobber: this is the user's own config, and a
        // parse failure here means we'd be discarding settings we can't read.
        Ok(_) => Err(format!("{} is not a JSON object", path.display())),
        Err(e) => Err(format!("{} is not valid JSON: {e}", path.display())),
    }
}

fn hooks_map(root: &mut Map<String, Value>) -> &mut Map<String, Value> {
    root.entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .expect("hooks entry was just created as an object if absent")
}

/// Write through a temp file in the same directory so an interrupted write
/// can't truncate the user's settings.
fn write_settings(path: &Path, root: &Map<String, Value>) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(&Value::Object(root.clone()))
        .map_err(|e| format!("serializing settings: {e}"))?;
    let tmp = path.with_extension("json.neige-tmp");
    std::fs::write(&tmp, text + "\n").map_err(|e| format!("writing {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("replacing {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `install` needs a shim that exists on disk; the settings file it edits
    /// is separate and may not.
    fn fixture() -> (tempdir::Dir, PathBuf, PathBuf) {
        let dir = tempdir::Dir::new();
        let shim = dir.path().join("neige-hook");
        std::fs::write(&shim, b"#!/bin/true\n").unwrap();
        let settings = dir.path().join("settings.json");
        (dir, settings, shim)
    }

    fn read(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn install_creates_settings_with_every_bound_hook() {
        let (_d, settings, shim) = fixture();
        install(&settings, &shim).unwrap();
        let v = read(&settings);
        assert_eq!(v["hooks"].as_object().unwrap().len(), HOOK_BINDINGS.len());
        assert_eq!(
            v["hooks"]["Stop"][0]["hooks"][0]["command"],
            shim.to_str().unwrap()
        );
    }

    #[test]
    fn install_is_idempotent() {
        let (_d, settings, shim) = fixture();
        install(&settings, &shim).unwrap();
        install(&settings, &shim).unwrap();
        assert_eq!(read(&settings)["hooks"]["Stop"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn install_preserves_unrelated_settings_and_foreign_hooks() {
        let (_d, settings, shim) = fixture();
        std::fs::write(
            &settings,
            r#"{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"/usr/bin/mine"}]}]}}"#,
        )
        .unwrap();
        install(&settings, &shim).unwrap();
        let v = read(&settings);
        assert_eq!(v["model"], "opus");
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "user's own Stop hook must survive");
        assert_eq!(stop[0]["hooks"][0]["command"], "/usr/bin/mine");
    }

    #[test]
    fn uninstall_removes_only_our_entries_and_prunes_empties() {
        let (_d, settings, shim) = fixture();
        std::fs::write(
            &settings,
            r#"{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"/usr/bin/mine"}]}]}}"#,
        )
        .unwrap();
        install(&settings, &shim).unwrap();
        uninstall(&settings, &shim).unwrap();
        let v = read(&settings);
        assert_eq!(v["model"], "opus");
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 1);
        assert_eq!(stop[0]["hooks"][0]["command"], "/usr/bin/mine");
        // SessionStart had no user entry, so it should be gone entirely.
        assert!(v["hooks"].get("SessionStart").is_none());
    }

    #[test]
    fn uninstall_from_a_settings_file_we_never_touched_leaves_no_hooks_key() {
        let (_d, settings, shim) = fixture();
        std::fs::write(&settings, r#"{"model":"opus"}"#).unwrap();
        uninstall(&settings, &shim).unwrap();
        let v = read(&settings);
        assert_eq!(v["model"], "opus");
        assert!(v.get("hooks").is_none());
    }

    #[test]
    fn install_refuses_a_missing_shim() {
        let (_d, settings, _) = fixture();
        let err = install(&settings, Path::new("/nonexistent/neige-hook")).unwrap_err();
        assert!(err.contains("not found"), "{err}");
    }

    #[test]
    fn install_refuses_to_clobber_unparseable_settings() {
        let (_d, settings, shim) = fixture();
        std::fs::write(&settings, "{ not json").unwrap();
        assert!(install(&settings, &shim).is_err());
        assert_eq!(std::fs::read_to_string(&settings).unwrap(), "{ not json");
    }

    #[test]
    fn opencode_plugin_install_writes_the_reporter_and_is_idempotent() {
        let dir = tempdir::Dir::new();
        let path = dir.path().join("plugins").join("neige-activity.js");
        install_opencode_plugin(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains(OPENCODE_PLUGIN_MARKER));
        assert!(text.contains("export const NeigeActivityPlugin"));
        install_opencode_plugin(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn opencode_plugin_uninstall_removes_ours_and_leaves_a_foreign_file() {
        let dir = tempdir::Dir::new();
        let ours = dir.path().join("neige-activity.js");
        let foreign = dir.path().join("foreign.js");
        install_opencode_plugin(&ours).unwrap();
        std::fs::write(&foreign, "export const Mine = async () => ({})\n").unwrap();
        uninstall_opencode_plugin(&ours).unwrap();
        uninstall_opencode_plugin(&foreign).unwrap();
        assert!(!ours.exists());
        assert!(foreign.exists());
    }

    #[test]
    fn opencode_plugin_source_still_carries_the_uninstall_marker() {
        assert!(OPENCODE_PLUGIN_SOURCE.contains(OPENCODE_PLUGIN_MARKER));
    }

    /// Minimal self-cleaning temp directory — the workspace has no dev-dep for
    /// this and one test module doesn't justify adding one.
    mod tempdir {
        use std::path::{Path, PathBuf};
        use std::sync::atomic::{AtomicU32, Ordering};

        static COUNTER: AtomicU32 = AtomicU32::new(0);

        pub struct Dir(PathBuf);

        impl Dir {
            pub fn new() -> Self {
                let n = COUNTER.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "neige-hook-install-{}-{n}",
                    std::process::id()
                ));
                std::fs::create_dir_all(&path).unwrap();
                Self(path)
            }

            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }
}
