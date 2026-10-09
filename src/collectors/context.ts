import { execFile, execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { CriterionResult, Evidence } from "../schema/evidence.js";
import type { Policy } from "../policy.js";

export interface Ctx {
  root: string;
  /** Caminhos relativos (posix) de arquivos do repo, na working tree, respeitando .gitignore. */
  files: string[];
  isGit: boolean;
  policy: Policy;
  now: Date;
  /** Texto do arquivo para ANÁLISE (até 1 MB, sem binários). Se não for UTF-8 válido, decodifica como Latin-1. */
  readText(rel: string): string | null;
  /** Texto só se for UTF-8 válido: é o único que pode ser reescrito sem corromper acentos. */
  readTextStrict(rel: string): string | null;
  /** Saída do git ou null se falhar. */
  git(args: string[], opts?: { timeoutMs?: number }): string | null;
}

export type Collector = {
  /** Critérios que este coletor produz. */
  ids: string[];
  run(ctx: Ctx): Promise<CriterionResult[]>;
};

const HARD_IGNORED = new Set([".git", "node_modules", ".repo-score", ".venv", "__pycache__", ".idea", ".vs"]);
const MAX_TEXT_BYTES = 1024 * 1024;

export function git(root: string, args: string[], timeoutMs = 30_000): string | null {
  try {
    return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export function gitAsync(root: string, args: string[], timeoutMs = 30_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd: root, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

function walk(root: string, dir = ""): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (HARD_IGNORED.has(e.name)) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

export function listFiles(root: string, isGit: boolean): string[] {
  let files: string[] | null = null;
  if (isGit) {
    const out = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    if (out !== null) files = out.split("\0").filter(Boolean);
  }
  files ??= walk(root);
  return [...new Set(files)]
    .filter((rel) => !rel.split("/").some((seg) => HARD_IGNORED.has(seg)))
    .filter((rel) => {
      try {
        return lstatSync(path.join(root, rel)).isFile(); // ignora symlinks, diretórios e arquivos removidos
      } catch {
        return false;
      }
    })
    .sort();
}

export function createCtx(root: string, policy: Policy, now = new Date()): Ctx {
  const isGit = git(root, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
  const files = listFiles(root, isGit);
  const cache = new Map<string, string | null>();
  const strictCache = new Map<string, string | null>();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }); // ignoreBOM: preserva o BOM ao reescrever
  const readBuf = (rel: string): Buffer | null => {
    try {
      const buf = readFileSync(path.join(root, rel));
      return buf.length <= MAX_TEXT_BYTES && !buf.subarray(0, 8000).includes(0) ? buf : null;
    } catch {
      return null;
    }
  };
  return {
    root,
    files,
    isGit,
    policy,
    now,
    git: (args, opts) => (isGit ? git(root, args, opts?.timeoutMs) : null),
    readText(rel) {
      if (cache.has(rel)) return cache.get(rel) ?? null;
      const buf = readBuf(rel);
      let text: string | null = null;
      if (buf) {
        try {
          text = decoder.decode(buf);
        } catch {
          text = buf.toString("latin1"); // arquivo legado (ex.: Windows-1252): lê para análise, nunca reescreve
        }
      }
      cache.set(rel, text);
      return text;
    },
    readTextStrict(rel) {
      if (strictCache.has(rel)) return strictCache.get(rel) ?? null;
      const buf = readBuf(rel);
      let text: string | null = null;
      if (buf) {
        try {
          text = decoder.decode(buf);
        } catch {
          text = null;
        }
      }
      strictCache.set(rel, text);
      return text;
    },
  };
}

// --- helpers de resultado -------------------------------------------------------------

export const NOT_IMPLEMENTED = "coletor ainda não implementado nesta versão";

export const measured = (
  id: string,
  value: number | string,
  evidence: Evidence[],
  confidence?: "high" | "medium" | "low",
): CriterionResult => ({
  id,
  status: "measured",
  value,
  evidence,
  ...(confidence ? { confidence } : {}),
});
export const unmeasured = (id: string, reason: string): CriterionResult => ({ id, status: "unmeasured", reason });
export const notApplicable = (id: string, reason: string): CriterionResult => ({
  id,
  status: "not_applicable",
  reason,
});

export const MAX_EVIDENCE = 25;
export const capEvidence = (list: Evidence[]): Evidence[] => list.slice(0, MAX_EVIDENCE);

export const jobEvidence = (name: string, note: string): Evidence => ({ kind: "job", name, note });

export const round = (n: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

export const isTestPath = (rel: string): boolean =>
  /(^|\/)(tests?|__tests__|spec|specs|e2e|fixtures?|testdata|mocks?)(\/|$)/i.test(rel) ||
  /(\.|_)(test|tests|spec)\.[a-z]+$/i.test(rel) ||
  /\.Tests?(\/|\.)/.test(rel);
