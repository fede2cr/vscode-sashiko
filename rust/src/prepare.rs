//! Turns patch files and uncommitted work into real commits Sashiko can review.
//!
//! Sashiko only understands git revision ranges, so anything else has to become
//! commits first. Everything happens in a throwaway detached worktree: the user's
//! checkout, index and branches are never touched.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{anyhow, bail, Context, Result};
use clap::Args;
use serde::Serialize;

/// Identity used for the scratch commits; the repository's own config may be unset.
const COMMIT_NAME: &str = "Sashiko Review";
const COMMIT_EMAIL: &str = "sashiko@localhost";

#[derive(Debug, Args)]
pub struct PrepareArgs {
    /// Repository the patches apply to.
    #[arg(long)]
    repo: PathBuf,
    /// Revision the scratch worktree starts from.
    #[arg(long, default_value = "HEAD")]
    baseline: String,
    /// Patch or mbox file to apply; repeat to apply a series in order.
    #[arg(long = "patch")]
    patches: Vec<PathBuf>,
    /// Commit the tracked working tree changes instead of applying patch files.
    #[arg(long)]
    working_tree: bool,
    /// Where to create the worktree; defaults to a directory under the temp dir.
    #[arg(long)]
    scratch: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct CleanupArgs {
    /// Repository the worktree belongs to.
    #[arg(long)]
    repo: PathBuf,
    /// Worktree previously returned by `prepare`.
    #[arg(long)]
    worktree: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Prepared {
    worktree: String,
    baseline: String,
    range: String,
    commits: u32,
}

pub fn run(args: &PrepareArgs) -> Result<()> {
    if args.patches.is_empty() && !args.working_tree {
        bail!("nothing to review: pass --patch <file> at least once, or --working-tree");
    }

    let repo = path_arg(&args.repo)?;
    let baseline = git(&[
        "-C",
        repo,
        "rev-parse",
        &format!("{}^{{commit}}", args.baseline),
    ])
    .with_context(|| format!("'{}' is not a commit in {repo}", args.baseline))?;

    let scratch = match &args.scratch {
        Some(path) => path.clone(),
        None => std::env::temp_dir().join(format!("sashiko-review-{}", uuid::Uuid::new_v4())),
    };
    let worktree = path_arg(&scratch)?.to_string();

    git(&[
        "-C", repo, "worktree", "add", "--detach", &worktree, &baseline,
    ])
    .context("failed to create the scratch worktree")?;

    // Past this point the worktree exists, so any failure has to clean up after itself.
    let outcome = if args.working_tree {
        commit_working_tree(repo, &worktree)
    } else {
        apply_patches(&worktree, &args.patches)
    };
    if let Err(err) = outcome {
        let _ = remove_worktree(repo, &worktree);
        return Err(err);
    }

    let commits: u32 = git(&[
        "-C",
        &worktree,
        "rev-list",
        "--count",
        &format!("{baseline}..HEAD"),
    ])?
    .parse()
    .unwrap_or(0);
    if commits == 0 {
        let _ = remove_worktree(repo, &worktree);
        bail!("nothing was committed; the patches may already be applied to the baseline");
    }

    let prepared = Prepared {
        worktree,
        range: format!("{baseline}..HEAD"),
        baseline,
        commits,
    };
    println!("{}", serde_json::to_string(&prepared)?);
    Ok(())
}

pub fn cleanup(args: &CleanupArgs) -> Result<()> {
    remove_worktree(path_arg(&args.repo)?, path_arg(&args.worktree)?)
}

fn remove_worktree(repo: &str, worktree: &str) -> Result<()> {
    git(&["-C", repo, "worktree", "remove", "--force", worktree])?;
    let _ = git(&["-C", repo, "worktree", "prune"]);
    Ok(())
}

fn apply_patches(worktree: &str, patches: &[PathBuf]) -> Result<()> {
    for patch in patches {
        let file = path_arg(patch)?;
        if !Path::new(file).is_file() {
            bail!("patch file not found: {file}");
        }

        // `git am` preserves the author and commit message from the mail headers, which
        // matters because Sashiko reviews the changelog as well as the diff.
        if git(&["-C", worktree, "am", "--3way", "--keep-cr", file]).is_ok() {
            continue;
        }
        let _ = git(&["-C", worktree, "am", "--abort"]);

        // A plain `diff` without mail headers still deserves a review.
        git(&["-C", worktree, "apply", "--3way", "--index", file])
            .with_context(|| format!("could not apply {file}"))?;
        let subject = Path::new(file)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "patch".to_string());
        commit_index(worktree, &format!("Apply {subject}"))?;
    }
    Ok(())
}

fn commit_working_tree(repo: &str, worktree: &str) -> Result<()> {
    // `--binary` keeps binary hunks intact and is still valid UTF-8 (base85).
    let diff = git_raw(&["-C", repo, "diff", "--binary", "HEAD"])?;
    if diff.trim().is_empty() {
        bail!("the working tree has no uncommitted changes to tracked files");
    }

    let patch = Path::new(worktree).join(".sashiko-working-tree.patch");
    std::fs::write(&patch, &diff).context("failed to stage the working tree diff")?;
    let patch_arg = path_arg(&patch)?.to_string();

    let applied = git(&["-C", worktree, "apply", "--index", &patch_arg]);
    let _ = std::fs::remove_file(&patch);
    applied.context("could not replay the working tree changes onto the scratch worktree")?;

    commit_index(worktree, "Uncommitted working tree changes")
}

fn commit_index(worktree: &str, message: &str) -> Result<()> {
    git(&[
        "-c",
        &format!("user.name={COMMIT_NAME}"),
        "-c",
        &format!("user.email={COMMIT_EMAIL}"),
        "-C",
        worktree,
        "commit",
        "--no-verify",
        "--no-gpg-sign",
        "--allow-empty-message",
        "-m",
        message,
    ])
    .map(|_| ())
}

fn path_arg(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or_else(|| anyhow!("path is not valid UTF-8: {}", path.display()))
}

fn git(args: &[&str]) -> Result<String> {
    git_raw(args).map(|output| output.trim().to_string())
}

fn git_raw(args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .context("failed to run git; is it installed and on PATH?")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("git {} failed: {}", args.join(" "), stderr.trim());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
