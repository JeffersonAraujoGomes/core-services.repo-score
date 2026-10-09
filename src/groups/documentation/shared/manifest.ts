import { z } from "zod";
import type { Ctx } from "../../../collectors/context.js";

export const MANIFEST_PATH = ".sdd/manifest.json";

/** Contrato do `.sdd/manifest.json` (o mesmo do sdd-bootstrap; repos já adotantes funcionam sem migração). */
export const SddManifestSchema = z.object({
  version: z.number().int().default(1),
  projectName: z.string().default(""),
  specsDir: z.string().min(1),
  skillSlug: z.string().min(1),
  skillPath: z.string().min(1),
  ruleCodeGlobs: z.array(z.string().min(1)).default([]),
});
export type SddManifest = z.infer<typeof SddManifestSchema>;

export type ManifestState =
  | { state: "missing" }
  | { state: "invalid"; reason: string }
  | { state: "ok"; manifest: SddManifest };

export function readManifest(ctx: Ctx): ManifestState {
  if (!ctx.files.includes(MANIFEST_PATH)) return { state: "missing" };
  const text = ctx.readText(MANIFEST_PATH);
  if (text === null) return { state: "invalid", reason: "não foi possível ler o arquivo" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { state: "invalid", reason: `JSON inválido: ${(e as Error).message}` };
  }
  const parsed = SddManifestSchema.safeParse(json);
  if (!parsed.success) {
    return { state: "invalid", reason: parsed.error.issues.map((i) => `${i.path.join(".") || "raiz"}: ${i.message}`).join("; ") };
  }
  return { state: "ok", manifest: parsed.data };
}
