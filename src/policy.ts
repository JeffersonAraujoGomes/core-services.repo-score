import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DocsPolicySchema } from "./groups/documentation/policy.js";
import { ProfileSchema, type Profile } from "./schema/evidence.js";

/**
 * Política opcional do repo (`repo-score.policy.json` na raiz ou --policy).
 * A rubrica é a mesma para todos; só caminhos, perfis e allowlists variam aqui.
 */
export const PolicySchema = z.object({
  /** N/A declarado: só desliga critérios por perfil. O que não for declarado conta como aplicável. */
  profile: ProfileSchema.partial().default({}),
  /** Limite de linhas por arquivo para C12. */
  max_file_lines: z.number().int().positive().default(500),
  /** Organizações cujas actions podem usar tag em vez de SHA (S13). */
  trusted_action_orgs: z.array(z.string()).default([]),
  /** Registries aprovados para imagens base (S9). Vazio = não restringe o registry. */
  approved_registries: z.array(z.string()).default([]),
  /** Política do grupo Documentação (D1–D9); detalhes em groups/documentation/policy.ts. */
  docs: DocsPolicySchema.prefault({}),
  /** Exceções para S1: exigem justificativa (V17: valores como "guest" não são allowlist válida). */
  secret_allowlist: z
    .array(z.object({ path: z.string().min(1), justification: z.string().min(10) }))
    .default([]),
});
export type Policy = z.infer<typeof PolicySchema>;

export interface LoadedPolicy {
  policy: Policy;
  source: string | null;
}

export function loadPolicy(root: string, explicit?: string): LoadedPolicy {
  const file = explicit ?? path.join(root, "repo-score.policy.json");
  if (!existsSync(file)) {
    if (explicit) throw new Error(`política não encontrada: ${explicit}`);
    return { policy: PolicySchema.parse({}), source: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`política inválida (${file}): ${(e as Error).message}`);
  }
  const parsed = PolicySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`política inválida (${file}): ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return { policy: parsed.data, source: file };
}

/**
 * Perfil completo. Tudo é aplicável por padrão (um critério só vira N/A quando a política declara),
 * exceto o padrão leste-oeste, que depende de um ADR da plataforma e não do repo (V35).
 */
export function resolveProfile(policy: Policy): Profile {
  return {
    rules_engine: true,
    has_database: true,
    exposes_api: true,
    east_west_standard_defined: false,
    ...policy.profile,
  };
}
