import type { Ctx } from "../collectors/context.js";
import type { FileChange } from "./types.js";

/** Cria ou atualiza um arquivo; null quando o conteúdo já é idêntico (idempotência) ou quando `createOnly` e ele existe. */
export function upsert(
  ctx: Ctx,
  rel: string,
  content: string,
  opts: { mode?: "exec"; note?: string; createOnly?: boolean } = {},
): FileChange | null {
  const exists = ctx.files.includes(rel);
  const existing = exists ? ctx.readTextStrict(rel) : null;
  if (exists && existing === null) return null; // binário, grande demais ou fora de UTF-8: nunca reescrever
  if (existing === content) return null;
  if (exists && opts.createOnly) return null;
  return {
    op: exists ? "modify" : "create",
    path: rel,
    content,
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.note ? { note: opts.note } : {}),
  };
}

export const kebab = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/**
 * Lê um arquivo que a ação vai editar. Se ele existe mas não é UTF-8 válido (ou é binário/grande), NÃO pode ser
 * reescrito sem risco de corromper acentos: devolve skip e registra o motivo em `notes`.
 */
export function readForEdit(ctx: Ctx, rel: string, notes: string[]): { skip: true } | { skip: false; text: string | null } {
  if (!ctx.files.includes(rel)) return { skip: false, text: null };
  const text = ctx.readTextStrict(rel);
  if (text === null) {
    notes.push(`${rel}: não está em UTF-8 (ou é binário/grande); não alterei para não corromper acentos. Ajuste manualmente.`);
    return { skip: true };
  }
  return { skip: false, text };
}
