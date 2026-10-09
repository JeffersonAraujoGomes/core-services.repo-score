import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import type { Evidence } from "../schema/evidence.js";
import { capEvidence, jobEvidence, measured, unmeasured, type Collector } from "./context.js";

/** Padrões de alta confiança. Cobrem credenciais emitidas por provedores, não senhas genéricas. */
export const HISTORY_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "chave de acesso AWS", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "chave privada", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { name: "token GitHub", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { name: "token Slack", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "chave de API Google", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "chave Stripe live", re: /\b[sr]k_live_[0-9a-zA-Z]{24,}\b/ },
];

const MAX_COMMITS = 5000;
const TIMEOUT_MS = 45_000;
const MAX_LINE = 5000;

export function matchHistoryLine(line: string): { name: string; fingerprint: string } | null {
  const text = line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line;
  for (const p of HISTORY_PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    if (/EXAMPLE|PLACEHOLDER|XXXXXXXX/i.test(m[0])) continue; // chaves de exemplo da documentação
    return { name: p.name, fingerprint: createHash("sha256").update(m[0]).digest("hex").slice(0, 16) };
  }
  return null;
}

export const s2HistorySecrets: Collector = {
  ids: ["S2"],
  async run(ctx) {
    if (!ctx.isGit) return [unmeasured("S2", "o diretório não é um repositório git")];
    const shallow = ctx.git(["rev-parse", "--is-shallow-repository"])?.trim() === "true";

    const seen = new Map<string, Evidence>();
    let commit = "";
    let path = "";
    let commits = 0;
    let truncated = false;

    await new Promise<void>((resolve) => {
      const child = spawn(
        "git",
        ["log", "--all", "-p", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=AM", `-n`, String(MAX_COMMITS), "--format=commit %H"],
        { cwd: ctx.root, stdio: ["ignore", "pipe", "ignore"] },
      );
      const timer = setTimeout(() => {
        truncated = true;
        child.kill("SIGKILL");
      }, TIMEOUT_MS);
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        if (line.startsWith("commit ") && /^commit [0-9a-f]{40}$/.test(line)) {
          commit = line.slice(7);
          path = "";
          commits += 1;
        } else if (line.startsWith("+++ b/")) {
          path = line.slice(6);
        } else if (line.startsWith("+") && !line.startsWith("+++")) {
          const hit = matchHistoryLine(line.slice(1));
          if (hit) {
            // `git log` vai do mais novo ao mais antigo: sobrescrever deixa o commit que introduziu o segredo.
            seen.set(hit.fingerprint, {
              kind: "commit",
              sha: commit,
              path: path || undefined,
              note: hit.name,
            });
          }
        }
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    if (commits === 0) return [unmeasured("S2", "não foi possível ler o histórico do git")];

    const partial = truncated || shallow || commits >= MAX_COMMITS;
    const scope = `${commits} commits${shallow ? " (clone raso)" : ""}${truncated ? " (tempo esgotado)" : ""}`;
    const evidence =
      seen.size > 0
        ? capEvidence([...seen.values()])
        : [jobEvidence("s2-history-secrets", `${scope} verificados, nenhum segredo de alta confiança`)];
    return [measured("S2", seen.size, evidence, partial ? "low" : "high")];
  },
};
