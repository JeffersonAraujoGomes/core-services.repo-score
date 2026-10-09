import { execFileSync } from "node:child_process";

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr = "",
  ) {
    super(message);
  }
}

export function git(root: string, args: string[], env: Record<string, string> = {}): string {
  try {
    return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; stdout?: Buffer | string; message: string };
    const stderr = `${err.stderr ?? ""}${err.stdout ?? ""}`.toString().trim();
    throw new GitError(`git ${args[0]} falhou: ${stderr || err.message}`, stderr);
  }
}

export const tryGit = (root: string, args: string[]): string | null => {
  try {
    return git(root, args);
  } catch {
    return null;
  }
};

export const isRepo = (root: string) => tryGit(root, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
export const repoTop = (root: string) => tryGit(root, ["rev-parse", "--show-toplevel"])?.trim() ?? root;
export const headSha = (root: string) => tryGit(root, ["rev-parse", "HEAD"])?.trim() ?? null;
/** Nome da branch atual, ou null em HEAD destacado. */
export const currentBranch = (root: string) => tryGit(root, ["symbolic-ref", "--short", "-q", "HEAD"])?.trim() || null;
export const isClean = (root: string) => (tryGit(root, ["status", "--porcelain"]) ?? "").trim() === "";
export const branchExists = (root: string, name: string) => tryGit(root, ["rev-parse", "--verify", "-q", `refs/heads/${name}`]) !== null;

export function uniqueBranchName(root: string, base: string): string {
  if (!branchExists(root, base)) return base;
  for (let i = 2; i < 100; i++) if (!branchExists(root, `${base}-${i}`)) return `${base}-${i}`;
  throw new GitError(`não achei um nome livre para a branch ${base}`);
}
