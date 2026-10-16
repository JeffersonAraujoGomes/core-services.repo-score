import { FixError } from "./errors.js";

/**
 * Versão publicada da skill: não existe caminho que commite, mescle ou reverta. O commit é do usuário.
 * (Troca `commit-paths.ts` no bundle; ver scripts/build.mjs.)
 */
export const COMMIT_PATHS_ENABLED = false;

export interface CommitInfo {
  sha: string;
  subject: string;
}

const refuse = (what: string): never => {
  throw new FixError(`${what} não existe nesta versão da skill: ela só cria, altera e remove arquivos, e o commit é seu.`);
};

export function commitAll(_root: string, _paths: string[] | null, _subject: string, _details: string, _skipHooks: boolean): CommitInfo | null {
  return refuse("o commit automático");
}
export function mergeBranch(_root: string, _branch: string, _skipHooks: boolean): void {
  refuse("o merge feito pela skill");
}
export function revertCommits(_root: string, _shas: string[]): void {
  refuse("o revert feito pela skill");
}
