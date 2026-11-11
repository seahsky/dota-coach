import { SKILL_DIR } from "./watcher.ts";

/**
 * Self-update for a git checkout of the skill. Only fast-forwards: never
 * merges, rebases or touches local edits. profile.json, .env and reviews/ are
 * git-ignored, so an update never changes the user's settings.
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
  checkedAt: number;
}

async function git(args: string[], timeoutMs = 30_000): Promise<{ code: number; out: string; err: string }> {
  let p;
  try {
    p = Bun.spawn(["git", ...args], {
      cwd: SKILL_DIR,
      stdout: "pipe",
      stderr: "pipe",
      // Never stop to ask for credentials: the skill repo is public, and a prompt would hang the dashboard.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch {
    return { code: 127, out: "", err: "git is not installed or not on PATH" };
  }
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, out: out.trim(), err: err.trim() };
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

/** Fetch the tracked branch and compare. Never changes files. */
export async function checkForUpdate(): Promise<UpdateStatus> {
  if ((await git(["rev-parse", "--is-inside-work-tree"])).out !== "true") {
    return base({ message: "This copy of the skill is not a git clone, so it cannot update itself. Reinstall it with git clone." });
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
      const def = (await git(["ls-remote", "--symref", remote, "HEAD"])).out.match(/refs\/heads\/(\S+)\s+HEAD/)?.[1];
      return base({
        state: "blocked",
        branch,
        upstream,
        message:
          `The branch ${remoteBranch} no longer exists on GitHub (it was probably merged).` +
          (def ? ` Switch once with: git fetch origin && git checkout ${def}` : " Switch to the repository's main branch."),
      });
    }
    return base({ branch, upstream, message: `Could not reach GitHub to check for updates: ${fetched.err.split("\n")[0] || `git exited ${fetched.code}`}` });
  }

  const counts = (await git(["rev-list", "--left-right", "--count", `HEAD...${upstream}`])).out.split(/\s+/).map(Number);
  const ahead = counts[0] ?? 0;
  const behind = counts[1] ?? 0;
  if (behind === 0) return base({ state: "up-to-date", branch, upstream, ahead, message: "Up to date." });

  const incoming = (await git(["log", "--format=%s", `HEAD..${upstream}`, "-n", "20"])).out.split("\n").filter(Boolean);
  if (ahead > 0) {
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
  // Tracked-file edits only; untracked and ignored files (profile.json, .env, reviews/) never block an update.
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
  return base({
    state: "available",
    branch,
    upstream,
    behind,
    incoming,
    message: `${behind} update${behind === 1 ? "" : "s"} available.`,
  });
}

/** Fast-forward to the tracked branch. Returns the status after the attempt. */
export async function applyUpdate(): Promise<{ updated: boolean; status: UpdateStatus; error?: string }> {
  const status = await checkForUpdate();
  if (status.state !== "available") return { updated: false, status };
  const pull = await git(["merge", "--ff-only", status.upstream!], 60_000);
  if (pull.code !== 0) return { updated: false, status, error: pull.err.split("\n")[0] || `git exited ${pull.code}` };
  return { updated: true, status: { ...status, state: "up-to-date", behind: 0, message: `Updated: ${status.behind} change${status.behind === 1 ? "" : "s"} installed.` } };
}
