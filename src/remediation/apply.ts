import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FileChange } from "./types.js";

export class ApplyError extends Error {}

/** Resolve um caminho relativo dentro da raiz; recusa absoluto, `..`, `.git/` e symlink que escapa. */
export function safeTarget(root: string, rel: string): string {
  if (rel.includes("\0") || path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel)) throw new ApplyError(`caminho inválido: ${rel}`);
  const norm = path.posix.normalize(rel.replace(/\\/g, "/"));
  if (norm.startsWith("../") || norm === ".." || norm === "." || norm === ".git" || norm.startsWith(".git/")) {
    throw new ApplyError(`caminho fora do que pode ser alterado: ${rel}`);
  }
  const rootReal = realpathSync(root);
  const abs = path.resolve(rootReal, norm);
  // o pai existente mais próximo precisa continuar dentro da raiz (sem symlink para fora)
  let probe = path.dirname(abs);
  while (!existsSync(probe) && probe !== rootReal) probe = path.dirname(probe);
  const real = realpathSync(probe);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new ApplyError(`symlink aponta para fora do repo: ${rel}`);
  return abs;
}

/** Aplica as alterações no disco. Não faz git. Devolve os caminhos tocados. */
export function applyChanges(root: string, changes: FileChange[]): string[] {
  const touched: string[] = [];
  for (const c of changes) {
    const abs = safeTarget(root, c.path);
    if (c.op === "delete") {
      if (!existsSync(abs) || !lstatSync(abs).isFile()) continue;
      rmSync(abs);
      touched.push(c.path);
      continue;
    }
    const exists = existsSync(abs);
    if (c.op === "create" && exists) throw new ApplyError(`${c.path} já existe; a ação deveria ter planejado uma modificação`);
    if (c.op === "modify" && !exists) throw new ApplyError(`${c.path} não existe; a ação deveria ter planejado uma criação`);
    if (exists && !lstatSync(abs).isFile()) throw new ApplyError(`${c.path} não é um arquivo`);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, c.content);
    if (c.mode === "exec") chmodSync(abs, 0o755);
    touched.push(c.path);
  }
  return touched;
}

export function summarizeChange(c: FileChange, existing: string | null): { op: FileChange["op"]; path: string; note?: string; lines: string } {
  const note = c.note ? { note: c.note } : {};
  if (c.op === "delete") return { op: c.op, path: c.path, ...note, lines: "remoção" };
  const next = c.content.split("\n").length;
  if (c.op === "create" || existing === null) return { op: c.op, path: c.path, ...note, lines: `+${next} linhas` };
  const prev = existing.split("\n");
  const prevSet = new Set(prev);
  const nextLines = c.content.split("\n");
  const nextSet = new Set(nextLines);
  const added = nextLines.filter((l) => !prevSet.has(l)).length;
  const removed = prev.filter((l) => !nextSet.has(l)).length;
  return { op: c.op, path: c.path, ...note, lines: `+${added} −${removed}` };
}
