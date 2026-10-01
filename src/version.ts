/**
 * Identity of the running process.
 *
 * The boot banner and the control channel report these so a log line taken
 * from pm2 can be traced back to a build without opening the repository.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** The short commit the relay was started from, cached per directory. */
const commitCache = new Map<string, string>();

/** package.json's version, or "unknown" when the file cannot be read. */
export function relayVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };

    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * `git rev-parse --short HEAD` in `cwd`.
 *
 * Runs once per process: an operator who restarts the relay ten times should
 * not need ten git invocations to find out what is running.
 */
export function relayCommit(cwd: string = process.cwd()): string {
  const cached = commitCache.get(cwd);
  if (cached !== undefined) return cached;

  let commit = "unknown";

  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const value = out.toString("utf8").trim();
    if (value !== "") commit = value;
  } catch {
    // Not a git checkout (a packaged copy, a test sandbox): report "unknown"
    // rather than failing to boot because a log line is unavailable.
  }

  commitCache.set(cwd, commit);

  return commit;
}
