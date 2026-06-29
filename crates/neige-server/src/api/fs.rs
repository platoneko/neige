use axum::{
    Json,
    body::Body,
    extract::State,
    http::StatusCode,
    response::IntoResponse,
};
use serde::Deserialize;

use super::AppState;
use super::util::expand_and_canonicalize;

#[derive(Deserialize)]
pub(super) struct BrowseQuery {
    path: Option<String>,
}

#[derive(serde::Serialize)]
pub(super) struct BrowseResponse {
    path: String,
    entries: Vec<DirEntryInfo>,
    is_git_repo: bool,
}

#[derive(serde::Serialize)]
pub(super) struct DirEntryInfo {
    name: String,
    is_dir: bool,
}

#[derive(serde::Serialize)]
pub(super) struct IsGitRepoResponse {
    path: String,
    is_git_repo: bool,
}

#[derive(Deserialize)]
pub(super) struct FileQuery {
    path: String,
}

#[derive(serde::Serialize)]
pub(super) struct FileResponse {
    path: String,
    content: String,
    language: String,
}

#[derive(Deserialize)]
pub(super) struct SearchFilesQuery {
    path: String,
    query: Option<String>,
}

#[derive(serde::Serialize)]
pub(super) struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
}

pub(super) async fn check_is_git_repo(
    State(state): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<BrowseQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let raw = q.path.unwrap_or_default();
    let canonical_str = if raw.is_empty() {
        let mgr = state.manager.lock().await;
        mgr.project_cwd().to_string()
    } else {
        expand_and_canonicalize(&raw)?
            .to_string_lossy()
            .to_string()
    };

    let is_git_repo = crate::conversation::is_git_repo(&canonical_str);
    Ok(Json(IsGitRepoResponse {
        path: canonical_str,
        is_git_repo,
    }))
}

pub(super) async fn browse_dir(
    axum::extract::Query(q): axum::extract::Query<BrowseQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let raw = q.path.unwrap_or_else(|| "~".to_string());
    let canonical = expand_and_canonicalize(&raw)?;

    let mut entries = Vec::new();
    let read = std::fs::read_dir(&canonical)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("cannot read dir: {e}")))?;

    for entry in read.flatten() {
        let meta = entry.metadata();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        entries.push(DirEntryInfo { name, is_dir });
    }

    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));

    let canonical_str = canonical.to_string_lossy().to_string();
    let is_git_repo = crate::conversation::is_git_repo(&canonical_str);

    Ok(Json(BrowseResponse {
        path: canonical_str,
        entries,
        is_git_repo,
    }))
}

fn image_mime(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        "apng" => Some("image/apng"),
        _ => None,
    }
}

fn resolve_file(raw: &str) -> Result<(std::path::PathBuf, std::fs::Metadata), (StatusCode, String)> {
    let canonical = expand_and_canonicalize(raw)?;
    let meta = std::fs::metadata(&canonical)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("cannot stat: {e}")))?;
    if !meta.is_file() {
        return Err((StatusCode::BAD_REQUEST, "not a file".to_string()));
    }
    Ok((canonical, meta))
}

// Opaque identity for the file's current state — mtime + size. Used by the
// frontend to cheaply check (via HEAD) whether a cached preview is stale.
fn file_etag(meta: &std::fs::Metadata) -> String {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| format!("{}.{:09}", d.as_secs(), d.subsec_nanos()))
        .unwrap_or_else(|| "0".to_string());
    format!("\"{}-{}\"", mtime, meta.len())
}

pub(super) async fn head_file(
    axum::extract::Query(q): axum::extract::Query<FileQuery>,
) -> Result<axum::response::Response, (StatusCode, String)> {
    let (canonical, meta) = resolve_file(&q.path)?;
    let ext = canonical.extension().and_then(|e| e.to_str()).unwrap_or("");
    let ct = image_mime(ext).unwrap_or("application/json");
    axum::response::Response::builder()
        .header(axum::http::header::CONTENT_TYPE, ct)
        .header(axum::http::header::CONTENT_LENGTH, meta.len())
        .header(axum::http::header::ETAG, file_etag(&meta))
        .body(Body::empty())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("build response: {e}")))
}

pub(super) async fn read_file(
    axum::extract::Query(q): axum::extract::Query<FileQuery>,
) -> Result<axum::response::Response, (StatusCode, String)> {
    let (canonical, meta) = resolve_file(&q.path)?;
    let etag = file_etag(&meta);
    let ext = canonical.extension().and_then(|e| e.to_str()).unwrap_or("");

    // Image path: serve raw bytes with image/* Content-Type (10MB cap).
    if let Some(mime) = image_mime(ext) {
        if meta.len() > 10 * 1024 * 1024 {
            return Err((StatusCode::BAD_REQUEST, "image too large (>10MB)".to_string()));
        }
        let bytes = std::fs::read(&canonical)
            .map_err(|e| (StatusCode::BAD_REQUEST, format!("cannot read: {e}")))?;
        return axum::response::Response::builder()
            .header(axum::http::header::CONTENT_TYPE, mime)
            .header(axum::http::header::ETAG, etag)
            .body(Body::from(bytes))
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("build response: {e}")));
    }

    // Text path: 2MB cap, return JSON with decoded content + language tag.
    if meta.len() > 2 * 1024 * 1024 {
        return Err((StatusCode::BAD_REQUEST, "file too large (>2MB)".to_string()));
    }

    let content = std::fs::read_to_string(&canonical)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("cannot read: {e}")))?;

    let language = match ext {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" => "javascript",
        "py" => "python",
        "md" | "markdown" => "markdown",
        "json" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "css" => "css",
        "html" => "html",
        "sh" | "bash" | "zsh" => "shell",
        "sql" => "sql",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "hpp" | "cc" => "cpp",
        "rb" => "ruby",
        "swift" => "swift",
        "kt" => "kotlin",
        "lua" => "lua",
        "r" => "r",
        "xml" => "xml",
        "csv" => "csv",
        "txt" | "" => "text",
        other => other,
    }
    .to_string();

    Ok((
        [(axum::http::header::ETAG, etag)],
        Json(FileResponse {
            path: canonical.to_string_lossy().to_string(),
            content,
            language,
        }),
    )
        .into_response())
}

pub(super) async fn search_files(
    axum::extract::Query(q): axum::extract::Query<SearchFilesQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let root = expand_and_canonicalize(&q.path)?;

    let query = q.query.unwrap_or_default().to_lowercase();
    let mut results: Vec<FileEntry> = Vec::new();
    let max_results = 50;
    let mut visited: std::collections::HashSet<std::path::PathBuf> = std::collections::HashSet::new();
    visited.insert(root.clone());

    fn walk(
        dir: &std::path::Path,
        root: &std::path::Path,
        query: &str,
        results: &mut Vec<FileEntry>,
        visited: &mut std::collections::HashSet<std::path::PathBuf>,
        max: usize,
        depth: usize,
    ) {
        if depth > 6 || results.len() >= max {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            if results.len() >= max {
                return;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // Skip .git and common large dirs. Other dotdirs (.claude, .github,
            // .vscode, .cargo, …) are useful to navigate into, so don't blanket-
            // exclude `.`-prefixed names.
            if name == ".git"
                || name == "node_modules"
                || name == "target"
                || name == "__pycache__"
                || name == "dist"
                || name == "build"
            {
                continue;
            }
            // DirEntry::metadata does not follow symlinks on Unix, so a symlinked
            // directory would report neither is_dir nor is_file. Use fs::metadata
            // (which follows symlinks) to get the real target type.
            let meta = match std::fs::metadata(entry.path()) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let path = entry.path();
            let rel_path = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();

            if meta.is_file() {
                if query.is_empty()
                    || name.to_lowercase().contains(query)
                    || rel_path.to_lowercase().contains(query)
                {
                    results.push(FileEntry {
                        name,
                        path: rel_path,
                        is_dir: false,
                    });
                }
            } else if meta.is_dir() {
                // Canonicalize to dedupe symlink cycles (A -> B -> A) and
                // multiple symlinks pointing at the same real dir.
                let canonical = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
                if visited.insert(canonical) {
                    walk(&path, root, query, results, visited, max, depth + 1);
                }
            }
        }
    }

    walk(&root, &root, &query, &mut results, &mut visited, max_results, 0);
    // Sort: prioritize exact filename matches, then by path length
    results.sort_by(|a, b| {
        let a_exact = a.name.to_lowercase().contains(&query);
        let b_exact = b.name.to_lowercase().contains(&query);
        b_exact.cmp(&a_exact).then(a.path.len().cmp(&b.path.len()))
    });

    Ok(Json(results))
}
