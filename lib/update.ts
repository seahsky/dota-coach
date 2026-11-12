import { existsSync, realpathSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { SKILL_DIR } from "./watcher.ts";

/**
 * Self-update for a git checkout of the skill. Only fast-forwards (or follows
 * a branch that was rewritten upstream when there are no local commits):
 * never merges, rebases or touches local edits. profile.json, .env and
 * reviews/ are git-ignored, and an update that would replace them is refused.
 */

export interface UpdateStatus {
  state: "up-to-date" | "available" | "blocked" | "unavailable";
  /** One line for the user. */
  message: string;
  branch: string | null;
  upstream: string | null;
  behind: number;
  ahead: number;
  /** Subjects of the commits an update would bring in, newest first. */
  incoming: string[];
  /** "reset" when the branch was rewritten upstream and HEAD has no commits of its own. */
  mode?: "ff" | "reset";
  checkedAt: number;
}

interface GitResult {
  code: number;
  out: string;
  err: string;
}

const NO_GIT = 127;
const TIMED_OUT = 124;

function killTree(pid: number): void {
  try {
    if (platform() === "win32") {
      // TerminateProcess on git.exe leaves git-remote-https.exe holding the pipes; /T takes the whole tree.
      Bun.spawn(["taskkill", "/T", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL"); // the process group created by detached: true
    }
  } catch {}
}

async function git(args: string[], timeoutMs = 30_000): Promise<GitResult> {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(
      [
        "git",
        // Give up on a connection that stalls instead of waiting for the OS TCP timeout.
        "-c", "http.lowSpeedLimit=1000",
        "-c", "http.lowSpeedTime=10",
        ...args,
      ],
      {
        cwd: SKILL_DIR,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // Own process group on POSIX so a timeout can kill git's helpers too (they hold the pipes open).
        detached: platform() !== "win32",
        env: {
          ...process.env,
          // Never stop for input: a prompt would hang the dashboard. The skill repo is public.
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=10",
        },
      },
    );
  } catch {
    return { code: NO_GIT, out: "", err: "git is not installed or not on PATH" };
  }
  const done = Promise.all([
    new Response(p.stdout as ReadableStream).text(),
    new Response(p.stderr as ReadableStream).text(),
    p.exited,
  ]).then(([out, err, code]): GitResult => ({ code, out: out.trim(), err: err.trim() }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<GitResult>((resolve) => {
    timer = setTimeout(() => {
      killTree(p.pid);
      resolve({ code: TIMED_OUT, out: "", err: `git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
  });
  const r = await Promise.race([done, timeout]);
  clearTimeout(timer);
  return r;
}

const base = (s: Partial<UpdateStatus>): UpdateStatus => ({
  state: "unavailable",
  message: "",
  branch: null,
  upstream: null,
  behind: 0,
  ahead: 0,
  incoming: [],
  checkedAt: Date.now(),
  ...s,
});

function samePath(a: string, b: string): boolean {
  try {
    const ra = realpathSync(a);
    const rb = realpathSync(b);
    return platform() === "win32" || platform() === "darwin" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
  } catch {
    return false;
  }
}

/** Fetch the tracked branch and compare. Never changes files. */
export async function checkForUpdate(): Promise<UpdateStatus> {
  const top = await git(["rev-parse", "--show-toplevel"]);
  if (top.code === NO_GIT) return base({ message: "git is not installed or not on PATH, so the skill cannot update itself." });
  // The skill folder must be its own clone. A copied folder inside another repo (e.g. dotfiles in
  // ~/.claude) would otherwise "update" that unrelated repo.
  if (top.code !== 0 || !samePath(top.out, SKILL_DIR)) {
    return base({ message: "This copy of the skill is not its own git clone, so it cannot update itself. Reinstall it with git clone." });
  }
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).out || null;
  if (!branch || branch === "HEAD") {
    return base({ branch, message: "The skill folder is not on a branch (detached HEAD). Check out a branch to get updates." });
  }
  const up = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (up.code !== 0) {
    return base({ branch, message: `Branch ${branch} does not track a remote branch, so there is nothing to update from.` });
  }
  const upstream = up.out;
  const remote = upstream.split("/")[0]!;
  const remoteBranch = upstream.slice(remote.length + 1);

  // Short timeout: this runs before the dashboard opens, and being offline should not stall it.
  const fetched = await git(["fetch", "--quiet", remote, remoteBranch], 15_000);
  if (fetched.code !== 0) {
    if (/couldn't find remote ref|not found/i.test(fetched.err)) {
      const def = (await git(["ls-remote", "--symref", remote, "HEAD"], 15_000)).out.match(/refs\/heads\/(\S+)\s+HEAD/)?.[1];
      // set-branches makes the fetch work in single-branch and shallow clones too.
      const how = def
        ? ` Switch once with: git remote set-branches ${remote} "*" && git fetch ${remote} && git checkout ${def}`
        : " Switch to the repository's main branch.";
      return base({ state: "blocked", branch, upstream, message: `The branch ${remoteBranch} no longer exists on GitHub (it was probably merged).${how}` });
    }
    return base({ branch, upstream, message: `Could not reach GitHub to check for updates: ${fetched.err.split("\n")[0] || `git exited ${fetched.code}`}` });
  }

  const counts = (await git(["rev-list", "--left-right", "--count", `HEAD...${upstream}`])).out.split(/\s+/).map(Number);
  const ahead = counts[0] ?? 0;
  const behind = counts[1] ?? 0;
  if (behind === 0) return base({ state: "up-to-date", branch, upstream, ahead, message: "Up to date." });

  const incoming = (await git(["log", "--format=%s", `HEAD..${upstream}`, "-n", "20"])).out.split("\n").filter(Boolean);
  let mode: "ff" | "reset" = "ff";
  if (ahead > 0) {
    // If HEAD was on the remote branch at some earlier point (its reflog of fetched values), the
    // "extra" commits came from GitHub and the branch was rewritten there (force-push). Follow it;
    // nothing local is lost.
    const seen = (await git(["reflog", "show", "--format=%H", "-n", "30", `refs/remotes/${upstream}`])).out.split("\n").filter(Boolean);
    let rewritten = false;
    for (const sha of seen) {
      if ((await git(["merge-base", "--is-ancestor", "HEAD", sha])).code === 0) {
        rewritten = true;
        break;
      }
    }
    if (!rewritten) {
      return base({
        state: "blocked",
        branch,
        upstream,
        ahead,
        behind,
        incoming,
        message: `An update is available, but this folder has ${ahead} local commit${ahead === 1 ? "" : "s"} that are not on GitHub. Update by hand (git pull) and resolve any conflicts.`,
      });
    }
    mode = "reset";
  }
  // Tracked-file edits only; untracked and ignored files never block an update by themselves.
  const dirty = (await git(["diff", "--name-only", "HEAD"])).out;
  if (dirty) {
    const files = dirty.split("\n").slice(0, 5).join(", ");
    return base({
      state: "blocked",
      branch,
      upstream,
      behind,
      incoming,
      message: `An update is available, but these skill files were edited locally: ${files}. Undo the edits (git checkout -- .) or update by hand.`,
    });
  }
  // git silently overwrites ignored files when an incoming commit starts tracking the same path.
  // Never let that happen to the user's own files (.env, profile.json, reviews/...).
  const added = (await git(["diff", "--name-only", "--diff-filter=A", "HEAD", upstream])).out.split("\n").filter(Boolean);
  const clash = added.filter((f) => existsSync(join(SKILL_DIR, f)));
  if (clash.length) {
    return base({
      state: "blocked",
      branch,
      upstream,
      behind,
      incoming,
      message: `An update is available, but it would replace your own file${clash.length > 1 ? "s" : ""} ${clash.slice(0, 5).join(", ")}. Move ${clash.length > 1 ? "them" : "it"} aside, update, then copy your values back.`,
    });
  }
  return base({ state: "available", branch, upstream, behind, incoming, mode, message: `${behind} update${behind === 1 ? "" : "s"} available.` });
}

/** Install the update. Returns the status after the attempt. */
export async function applyUpdate(): Promise<{ updated: boolean; status: UpdateStatus; error?: string }> {
  const status = await checkForUpdate();
  if (status.state !== "available") return { updated: false, status };
  // --keep refuses to touch local changes, like a fast-forward.
  const cmd = status.mode === "reset" ? ["reset", "--keep", status.upstream!] : ["merge", "--ff-only", status.upstream!];
  const r = await git(cmd, 60_000);
  if (r.code !== 0) return { updated: false, status, error: r.err.split("\n")[0] || `git exited ${r.code}` };
  const deps = await installDependencies();
  return {
    updated: true,
    status: {
      ...status,
      state: "up-to-date",
      behind: 0,
      message: `Updated: ${status.behind} change${status.behind === 1 ? "" : "s"} installed.${deps ? ` ${deps}` : ""}`,
    },
  };
}

/**
 * The review agent needs npm packages (Anthropic SDK, LangGraph), and an update can change them.
 * Returns a note when the install failed, else "".
 */
async function installDependencies(): Promise<string> {
  try {
    const p = Bun.spawn([process.execPath, "install", "--production", "--frozen-lockfile"], {
      cwd: SKILL_DIR,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => p.kill(), 180_000);
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    return code === 0 ? "" : `Installing dependencies failed (${err.trim().split("\n").pop() || `exit ${code}`}); run \`bun install\` in the skill folder.`;
  } catch (err) {
    return `Installing dependencies failed (${err instanceof Error ? err.message : String(err)}); run \`bun install\` in the skill folder.`;
  }
}
