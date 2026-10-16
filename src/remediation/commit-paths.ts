import { git, tryGit } from "./git.js";

/**
 * TUDO que a skill faz com `git commit`, `git merge` e `git revert` fica neste arquivo. A skill publicada NÃO inclui
 * este código: `scripts/build.mjs` troca este módulo por `commit-paths.stub.ts`, que só recusa. Assim a regra "a skill
 * nunca commita" vale no bundle, e não só no texto. Aqui (desenvolvimento e testes) o caminho opt-in `--commit` existe.
 */
export const COMMIT_PATHS_ENABLED = true;

export interface CommitInfo {
  sha: string;
  subject: string;
}

const HOOKS_NOTE = "\n\nHooks pulados com aprovação explícita do usuário (SDD_SKIP=1).";

/** Commita `paths` (ou tudo, se null). Devolve null quando não há o que commitar. */
export function commitAll(root: string, paths: string[] | null, subject: string, details: string, skipHooks: boolean): CommitInfo | null {
  git(root, paths ? ["add", "-A", "--", ...paths] : ["add", "-A"]);
  if ((tryGit(root, ["diff", "--cached", "--name-only"]) ?? "").trim() === "") return null;
  const message = `${subject}${details ? `\n\n${details}` : ""}${skipHooks ? HOOKS_NOTE : ""}`;
  git(root, ["commit", "-q", "-m", message, ...(skipHooks ? ["--no-verify"] : [])], skipHooks ? { SDD_SKIP: "1" } : {});
  const sha = git(root, ["rev-parse", "--short", "HEAD"]).trim();
  return { sha, subject };
}

/** Merge sem fast-forward da branch da correção na branch atual; em caso de conflito ou bloqueio, desfaz e relança. */
export function mergeBranch(root: string, branch: string, skipHooks: boolean): void {
  try {
    git(root, ["merge", "--no-ff", "-m", `Merge branch '${branch}' (repo-score)`, ...(skipHooks ? ["--no-verify"] : []), branch], skipHooks ? { SDD_SKIP: "1" } : {});
  } catch (e) {
    tryGit(root, ["merge", "--abort"]);
    throw e;
  }
}

/** Desfaz commits com commits de revert (o histórico não é reescrito). */
export function revertCommits(root: string, shas: string[]): void {
  try {
    git(root, ["revert", "--no-edit", ...shas]);
  } catch (e) {
    tryGit(root, ["revert", "--abort"]);
    throw e;
  }
}
