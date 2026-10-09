import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Rubric } from "./schema/rubric.js";
import { reportsHome } from "./util/home.js";

export type EnabledSource = "env" | "user" | "skill" | "default";

export interface EnabledGroups {
  /** Grupos que podem ser escolhidos na análise, na ordem da rubrica. */
  enabled: string[];
  /** Todos os grupos da rubrica. */
  all: string[];
  /** De onde veio a configuração: a mais específica vence (env > user > skill > padrão). */
  source: EnabledSource;
  /** Arquivo que definiu a configuração, quando houver. */
  file: string | null;
}

const SkillConfigSchema = z.object({ enabled: z.array(z.string()).min(1), note: z.string().optional() });
const UserConfigSchema = z.object({ enabled_groups: z.array(z.string()).min(1) }).passthrough();

export const userConfigPath = () => path.join(reportsHome(), "config.json");

export function skillConfigPath(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.resolve(here, "../references/groups.json"), path.resolve(here, "../skill/references/groups.json"), path.resolve(here, "../../skill/references/groups.json")].find((c) => existsSync(c)) ?? null;
}

function readJson(file: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${what} inválido (${file}): ${(e as Error).message}`);
  }
}

function validate(ids: string[], all: string[], origin: string): string[] {
  const unknown = ids.filter((g) => !all.includes(g));
  if (unknown.length) throw new Error(`${origin}: grupo desconhecido ${unknown.join(", ")} (válidos: ${all.join(", ")})`);
  return all.filter((g) => ids.includes(g));
}

/** Resolve os grupos ativados. Precedência: REPO_SCORE_ENABLED_GROUPS > ~/.repo-score/config.json > groups.json da skill > todos. */
export function enabledGroups(rubric: Rubric): EnabledGroups {
  const all = rubric.dimensions.map((d) => d.id);
  const env = process.env["REPO_SCORE_ENABLED_GROUPS"]?.trim();
  if (env) {
    const ids = env === "all" ? all : validate(env.split(",").map((x) => x.trim()).filter(Boolean), all, "REPO_SCORE_ENABLED_GROUPS");
    return { enabled: ids, all, source: "env", file: null };
  }
  const user = userConfigPath();
  if (existsSync(user)) {
    const parsed = UserConfigSchema.safeParse(readJson(user, "config do usuário"));
    if (parsed.success) return { enabled: validate(parsed.data.enabled_groups, all, user), all, source: "user", file: user };
  }
  const skill = skillConfigPath();
  if (skill) {
    const parsed = SkillConfigSchema.safeParse(readJson(skill, "groups.json"));
    if (!parsed.success) throw new Error(`groups.json inválido (${skill}): ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    return { enabled: validate(parsed.data.enabled, all, skill), all, source: "skill", file: skill };
  }
  return { enabled: all, all, source: "default", file: null };
}

/** Grava a escolha do usuário (vale para todas as análises dele, em qualquer repo). */
export function setUserEnabled(rubric: Rubric, ids: string[]): string {
  const all = rubric.dimensions.map((d) => d.id);
  const enabled = ids.length === 1 && ids[0] === "all" ? all : validate(ids, all, "groups set");
  if (enabled.length === 0) throw new Error("informe ao menos um grupo");
  const file = userConfigPath();
  mkdirSync(path.dirname(file), { recursive: true });
  let current: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      current = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      current = {};
    }
  }
  writeFileSync(file, JSON.stringify({ ...current, enabled_groups: enabled }, null, 2) + "\n");
  return file;
}

export function resetUserEnabled(): boolean {
  const file = userConfigPath();
  if (!existsSync(file)) return false;
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    current = {};
  }
  delete current["enabled_groups"];
  writeFileSync(file, JSON.stringify(current, null, 2) + "\n");
  return true;
}

/** Grupos da análise: o que o usuário pediu (ou todos os ativados), sempre dentro dos ativados. */
export function resolveSelection(rubric: Rubric, requested?: string[]): { selected: string[]; enabled: EnabledGroups } {
  const enabled = enabledGroups(rubric);
  if (!requested || requested.length === 0) return { selected: enabled.enabled, enabled };
  const unknown = requested.filter((g) => !enabled.all.includes(g));
  if (unknown.length) throw new Error(`grupo desconhecido: ${unknown.join(", ")} (válidos: ${enabled.all.join(", ")})`);
  const disabled = requested.filter((g) => !enabled.enabled.includes(g));
  if (disabled.length) {
    throw new Error(`grupo desativado: ${disabled.join(", ")}. Ativados: ${enabled.enabled.join(", ")}. Para ativar: repo-score groups set ${[...new Set([...enabled.enabled, ...disabled])].join(",")}`);
  }
  return { selected: enabled.all.filter((g) => requested.includes(g)), enabled };
}
