import path from "node:path";
import type { Ctx } from "../../../collectors/context.js";
import { dirname } from "./docs-set.js";

export interface AppInfo {
  /** Diretório do app relativo à raiz ("" quando o repo inteiro é o app). */
  dir: string;
  name: string;
}

export type AppsSource = "policy" | "apps.yml" | "apps/ com Dockerfile" | "apps/ com projeto" | "repo inteiro";

const PROJECT_FILE = /(^|\/)([^/]+\.(cs|fs|vb)proj|package\.json|go\.mod|pom\.xml|build\.gradle(\.kts)?|pyproject\.toml|Cargo\.toml)$/;

/**
 * Apps (deployables) do repo: política > apps.yml > pastas de apps/ com Dockerfile > pastas de apps/ com
 * projeto > o repo inteiro. Pastas sem marcador não entram (V19).
 */
export function detectApps(ctx: Ctx): { apps: AppInfo[]; source: AppsSource } {
  const mk = (dir: string): AppInfo => ({ dir, name: dir === "" ? path.basename(ctx.root) : path.posix.basename(dir) });
  const exists = (dir: string) => ctx.files.some((f) => f === dir || f.startsWith(`${dir}/`));

  if (ctx.policy.docs.apps?.length) {
    return { apps: ctx.policy.docs.apps.map((d) => mk(d.replace(/\/+$/, ""))), source: "policy" };
  }

  const yml = ctx.files.find((f) => f === "apps.yml" || f === "apps.yaml");
  const ymlText = yml ? ctx.readText(yml) : null;
  if (ymlText) {
    const dirs = [...ymlText.matchAll(/^\s*-\s*dir:\s*['"]?([^'"\s#]+)/gm)].map((m) => m[1]!.replace(/\/+$/, ""));
    const resolved = dirs.map((d) => (exists(`apps/${d}`) ? `apps/${d}` : d)).filter(exists);
    if (resolved.length) return { apps: resolved.map(mk), source: "apps.yml" };
  }

  const underApps = new Map<string, string[]>();
  for (const f of ctx.files) {
    const m = /^apps\/([^/]+)\//.exec(f);
    if (m) underApps.set(m[1]!, [...(underApps.get(m[1]!) ?? []), f]);
  }
  const withDocker = [...underApps].filter(([, fs]) => fs.some((f) => /(^|\/)(Dockerfile[^/]*|[^/]+\.Dockerfile)$/i.test(f)));
  if (withDocker.length) return { apps: withDocker.map(([d]) => mk(`apps/${d}`)), source: "apps/ com Dockerfile" };
  const withProject = [...underApps].filter(([, fs]) => fs.some((f) => PROJECT_FILE.test(f)));
  if (withProject.length) return { apps: withProject.map(([d]) => mk(`apps/${d}`)), source: "apps/ com projeto" };

  return { apps: [mk("")], source: "repo inteiro" };
}

/** Arquivo `name` (sem diferenciar maiúsculas) diretamente na pasta do app. */
export function findInApp(ctx: Ctx, app: AppInfo, names: string[]): string | null {
  const wanted = names.map((n) => n.toLowerCase());
  return ctx.files.find((f) => dirname(f) === app.dir && wanted.includes(path.posix.basename(f).toLowerCase())) ?? null;
}
