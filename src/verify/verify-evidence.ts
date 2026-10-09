import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { CriterionResult, Evidence } from "../schema/evidence.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type EvidenceCheck =
  | { ok: true; verified: boolean }
  | { ok: false; reason: string };

export interface VerifyIssue {
  id: string;
  evidence: Evidence;
  reason: string;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function insideRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve um caminho de evidência dentro da raiz do repo. A evidência vem de agentes que leem
 * código não confiável, então caminho absoluto, `..` e symlink para fora da raiz são rejeitados.
 */
function resolveInside(root: string, p: string): { ok: true; abs: string } | { ok: false; reason: string } {
  if (p.includes("\0")) return { ok: false, reason: "caminho inválido" };
  if (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)) {
    return { ok: false, reason: "caminho absoluto não é aceito; use caminho relativo à raiz do repo" };
  }
  const rootReal = realpathSync(root);
  const abs = path.resolve(rootReal, p);
  if (!insideRoot(rootReal, abs)) return { ok: false, reason: "caminho fora da raiz do repo" };
  if (!existsSync(abs)) return { ok: false, reason: "arquivo não existe" };
  const real = realpathSync(abs);
  if (!insideRoot(rootReal, real)) return { ok: false, reason: "symlink aponta para fora da raiz do repo" };
  return { ok: true, abs: real };
}

export function verifyEvidence(root: string, ev: Evidence): EvidenceCheck {
  switch (ev.kind) {
    case "file": {
      const r = resolveInside(root, ev.path);
      if (!r.ok) return r;
      const st = statSync(r.abs);
      if (!st.isFile()) return { ok: false, reason: "o caminho não é um arquivo" };
      if (ev.line === undefined && ev.snippet === undefined) return { ok: true, verified: true };
      if (st.size > MAX_FILE_BYTES) return { ok: false, reason: "arquivo grande demais para verificar" };

      const lines = readFileSync(r.abs, "utf8").split(/\r?\n/);
      if (ev.line !== undefined && ev.line > lines.length) {
        return { ok: false, reason: `linha ${ev.line} não existe (arquivo tem ${lines.length})` };
      }
      if (ev.snippet === undefined) return { ok: true, verified: true };

      const wanted = normalize(ev.snippet);
      if (wanted === "") return { ok: false, reason: "trecho vazio" };
      let haystack: string;
      if (ev.line !== undefined) {
        const span = ev.snippet.split(/\r?\n/).length;
        haystack = normalize(lines.slice(ev.line - 1, ev.line - 1 + span).join(" "));
      } else {
        haystack = normalize(lines.join(" "));
      }
      return haystack.includes(wanted)
        ? { ok: true, verified: true }
        : { ok: false, reason: ev.line !== undefined ? `o trecho não está na linha ${ev.line}` : "o trecho não existe no arquivo" };
    }
    case "commit": {
      try {
        execFileSync("git", ["cat-file", "-e", `${ev.sha}^{commit}`], { cwd: root, stdio: "ignore" });
        return { ok: true, verified: true };
      } catch {
        return { ok: false, reason: "commit não existe neste repositório" };
      }
    }
    // URL e job vêm de fora do repo (GitHub, CI, Datadog); só o conector que os produziu pode conferi-los.
    case "url":
    case "job":
      return { ok: true, verified: false };
  }
}

/**
 * Confere toda evidência de arquivo/commit contra o repo. Evidência inválida é descartada;
 * se nenhuma sobrar, o critério vira `unmeasured`. Se sobrar só parte, a confiança cai para "low".
 */
export function verifyResults(
  root: string,
  results: CriterionResult[],
): { results: CriterionResult[]; issues: VerifyIssue[] } {
  const issues: VerifyIssue[] = [];
  const out = results.map((r): CriterionResult => {
    if (r.status !== "measured" || r.evidence.length === 0) return r;
    const kept: Evidence[] = [];
    const dropped: string[] = [];
    for (const ev of r.evidence) {
      const c = verifyEvidence(root, ev);
      if (c.ok) kept.push(ev);
      else {
        issues.push({ id: r.id, evidence: ev, reason: c.reason });
        dropped.push(c.reason);
      }
    }
    if (kept.length === 0) {
      return { id: r.id, status: "unmeasured", reason: `evidência inválida: ${dropped[0]}` };
    }
    if (dropped.length > 0) return { ...r, evidence: kept, confidence: "low" };
    return r;
  });
  return { results: out, issues };
}
