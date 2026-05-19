use serde::Serialize;
use std::{
    env,
    ffi::OsStr,
    path::Path,
    process::{Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

const GIT_COMMAND_TIMEOUT_MS: u64 = 3000;
const UNTRACKED_DIFF_BUDGET_MS: u64 = 3000;
const UNTRACKED_DIFF_COMMAND_TIMEOUT_MS: u64 = 500;
const SKIPPED_DIFF_PREFIXES: [&str; 4] = [".pi/", ".kiri/", "node_modules/", "dist/"];

#[derive(Debug, Serialize, PartialEq, Eq)]
struct RuntimeDiffArtifact {
    title: String,
    path: String,
    patch: String,
}

fn main() {
    let cwd = match env::args().nth(1) {
        Some(value) => value,
        None => {
            eprintln!("usage: kiri-git-diff-collector <cwd>");
            std::process::exit(2);
        }
    };

    match collect_git_diff_artifacts(&cwd) {
        Ok(artifacts) => {
            println!(
                "{}",
                serde_json::to_string(&artifacts).expect("diff artifacts should serialize")
            );
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

fn collect_git_diff_artifacts(cwd: &str) -> Result<Vec<RuntimeDiffArtifact>, String> {
    if !is_git_work_tree(cwd) {
        return Ok(Vec::new());
    }

    let mut untracked_patches = Vec::new();
    let untracked_deadline = Instant::now() + Duration::from_millis(UNTRACKED_DIFF_BUDGET_MS);
    for path in untracked_files(cwd)? {
        let remaining = untracked_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let timeout = remaining.min(Duration::from_millis(UNTRACKED_DIFF_COMMAND_TIMEOUT_MS));
        let patch = run_git_allow_exit(
            cwd,
            &[
                "diff",
                "--no-ext-diff",
                "--no-index",
                "--binary",
                "--",
                "/dev/null",
                &path,
            ],
            timeout,
        );
        untracked_patches.extend(split_git_patch(&patch));
    }

    let tracked_patch = run_git_allow_exit(
        cwd,
        &[
            "diff",
            "--no-ext-diff",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--binary",
            "HEAD",
            "--",
        ],
        Duration::from_millis(GIT_COMMAND_TIMEOUT_MS),
    );

    let mut artifacts = Vec::new();
    for patch in split_git_patch(&tracked_patch)
        .into_iter()
        .chain(untracked_patches.into_iter())
    {
        let Some(path) = diff_path(&patch) else {
            continue;
        };
        if should_skip_diff_path(&path) {
            continue;
        }
        artifacts.push(RuntimeDiffArtifact {
            title: basename(&path),
            path,
            patch,
        });
    }
    Ok(artifacts)
}

fn is_git_work_tree(cwd: &str) -> bool {
    match run_git(
        cwd,
        &["rev-parse", "--is-inside-work-tree"],
        Duration::from_millis(GIT_COMMAND_TIMEOUT_MS),
    ) {
        Ok(output) => output.trim() == "true",
        Err(_) => false,
    }
}

fn untracked_files(cwd: &str) -> Result<Vec<String>, String> {
    let output = run_git(
        cwd,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        Duration::from_millis(GIT_COMMAND_TIMEOUT_MS),
    )?;
    let records: Vec<&str> = output.split('\0').collect();
    let mut paths = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        if record.is_empty() {
            index += 1;
            continue;
        }
        let status = record.get(0..2).unwrap_or("");
        let path = record.get(3..).unwrap_or("");
        if status == "??" && !path.is_empty() && !should_skip_diff_path(path) {
            paths.push(path.to_string());
        }
        if status.contains('R') || status.contains('C') {
            index += 1;
        }
        index += 1;
    }
    Ok(paths)
}

fn should_skip_diff_path(path: &str) -> bool {
    SKIPPED_DIFF_PREFIXES
        .iter()
        .any(|prefix| path.starts_with(prefix))
}

fn split_git_patch(patch: &str) -> Vec<String> {
    let trimmed = patch.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    trimmed
        .split("\ndiff --git ")
        .filter_map(|section| {
            let next = section.trim();
            if next.starts_with("diff --git ") {
                Some(next.to_string())
            } else if !next.is_empty() {
                Some(format!("diff --git {next}"))
            } else {
                None
            }
        })
        .filter(|section| section.starts_with("diff --git "))
        .collect()
}

fn diff_path(patch: &str) -> Option<String> {
    let line = patch.lines().find(|line| line.starts_with("diff --git "))?;
    let rest = line.strip_prefix("diff --git ")?;
    let mut parts = rest.splitn(2, ' ');
    let left = parts.next().unwrap_or("");
    let right = parts.next().unwrap_or(left);
    Some(clean_diff_path(right))
}

fn clean_diff_path(path: &str) -> String {
    path.trim()
        .trim_matches('"')
        .strip_prefix("b/")
        .unwrap_or_else(|| path.trim().trim_matches('"'))
        .trim()
        .to_string()
}

fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or(path)
        .to_string()
}

fn run_git_allow_exit(cwd: &str, args: &[&str], timeout: Duration) -> String {
    run_git_output(cwd, args, timeout)
        .map(|output| output.stdout)
        .unwrap_or_default()
}

fn run_git(cwd: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    let output = run_git_output(cwd, args, timeout)?;
    if !output.status.success() {
        return Err(format!(
            "git {} exited with {}",
            args.join(" "),
            output.status
        ));
    }
    Ok(output.stdout)
}

struct GitOutput {
    status: ExitStatus,
    stdout: String,
}

fn run_git_output(cwd: &str, args: &[&str], timeout: Duration) -> Result<GitOutput, String> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("failed to spawn git: {error}"))?;

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|error| format!("failed to read git output: {error}"))?;
                return Ok(GitOutput {
                    status,
                    stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                });
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let output = child
                        .wait_with_output()
                        .map_err(|error| format!("failed to read timed out git output: {error}"))?;
                    return Err(format!(
                        "git {} timed out after {}ms{}",
                        args.join(" "),
                        timeout.as_millis(),
                        if output.stdout.is_empty() {
                            ""
                        } else {
                            " with partial output"
                        }
                    ));
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(format!("failed to wait for git: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::{create_dir_all, write},
        path::PathBuf,
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn splits_and_extracts_patch_metadata() {
        let patch = [
            "diff --git a/src/app.ts b/src/app.ts",
            "--- a/src/app.ts",
            "+++ b/src/app.ts",
            "diff --git a/dist/app.js b/dist/app.js",
            "--- a/dist/app.js",
            "+++ b/dist/app.js",
        ]
        .join("\n");

        let artifacts: Vec<_> = split_git_patch(&patch)
            .into_iter()
            .filter_map(|patch| {
                let path = diff_path(&patch)?;
                Some(RuntimeDiffArtifact {
                    title: basename(&path),
                    path,
                    patch,
                })
            })
            .filter(|artifact| !should_skip_diff_path(&artifact.path))
            .collect();

        assert_eq!(
            artifacts,
            vec![RuntimeDiffArtifact {
                title: "app.ts".to_string(),
                path: "src/app.ts".to_string(),
                patch: [
                    "diff --git a/src/app.ts b/src/app.ts",
                    "--- a/src/app.ts",
                    "+++ b/src/app.ts",
                ]
                .join("\n"),
            }]
        );
    }

    #[test]
    fn captures_tracked_and_untracked_files() {
        let repo = init_repo();
        write(repo.join("tracked.ts"), "export const value = 2\n").unwrap();
        write(repo.join("new.ts"), "export const created = true\n").unwrap();

        let artifacts = collect_git_diff_artifacts(repo.to_str().unwrap()).unwrap();
        let paths: Vec<_> = artifacts
            .iter()
            .map(|artifact| artifact.path.as_str())
            .collect();

        assert!(paths.contains(&"tracked.ts"));
        assert!(paths.contains(&"new.ts"));
    }

    #[test]
    fn skips_runtime_paths() {
        let repo = init_repo();
        create_dir_all(repo.join(".pi")).unwrap();
        create_dir_all(repo.join("src")).unwrap();
        write(repo.join(".pi/session.jsonl"), "{}\n").unwrap();
        write(repo.join("src/app.ts"), "export const app = true\n").unwrap();

        let artifacts = collect_git_diff_artifacts(repo.to_str().unwrap()).unwrap();
        let paths: Vec<_> = artifacts
            .iter()
            .map(|artifact| artifact.path.as_str())
            .collect();

        assert!(!paths.contains(&".pi/session.jsonl"));
        assert!(paths.contains(&"src/app.ts"));
    }

    fn init_repo() -> PathBuf {
        let mut dir = env::temp_dir();
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        dir.push(format!("kiri-rust-git-diff-{suffix}"));
        create_dir_all(&dir).unwrap();
        run_git_test(&dir, &["init"]);
        run_git_test(&dir, &["config", "user.email", "test@example.com"]);
        run_git_test(&dir, &["config", "user.name", "Kiri Test"]);
        write(dir.join("tracked.ts"), "export const value = 1\n").unwrap();
        run_git_test(&dir, &["add", "tracked.ts"]);
        run_git_test(&dir, &["commit", "-m", "initial"]);
        dir
    }

    fn run_git_test(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(
            status.success(),
            "git command failed: git {}",
            args.join(" ")
        );
    }
}
