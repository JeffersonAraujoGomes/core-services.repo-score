import os from "node:os";
import path from "node:path";

/** Pasta do repo-score do usuário (relatórios, histórico, config). REPO_SCORE_HOME a substitui (testes). */
export function reportsHome(): string {
  return process.env["REPO_SCORE_HOME"] ?? path.join(os.homedir(), ".repo-score");
}
