import path from "node:path";
import type { Ctx } from "../../../collectors/context.js";
import type { ActionPlan, GuidedTask } from "../../../remediation/types.js";
import { readmeStatuses } from "../collectors/d1-readme.js";
import { loadCodeowners, ownersFor } from "../shared/codeowners.js";
import { PATH_RULES_BLOCK } from "../shared/path-rules.js";


/** Fatos verificáveis sobre o app, para o Claude redigir o README sem inventar. */
export function appFacts(ctx: Ctx, dir: string): string[] {
  const prefix = dir === "" ? "" : `${dir}/`;
  const inApp = ctx.files.filter((f) => f.startsWith(prefix) && f.slice(prefix.length).split("/").length <= 3);
  const facts: string[] = [];
  const sln = inApp.filter((f) => /\.sln$/.test(f));
  const proj = inApp.filter((f) => /\.(cs|fs)proj$/.test(f));
  if (sln.length || proj.length) facts.push(`.NET: ${[...sln, ...proj].slice(0, 6).join(", ")} (build/test típicos: dotnet build, dotnet test)`);
  const pkg = inApp.find((f) => path.posix.basename(f) === "package.json");
  if (pkg) {
    try {
      const scripts = Object.keys((JSON.parse(ctx.readText(pkg) ?? "{}") as { scripts?: Record<string, string> }).scripts ?? {});
      facts.push(`Node: ${pkg} com scripts ${scripts.slice(0, 8).join(", ") || "(nenhum)"}`);
    } catch {
      facts.push(`Node: ${pkg}`);
    }
  }
  if (inApp.some((f) => path.posix.basename(f) === "go.mod")) facts.push("Go: go.mod presente");
  const docker = inApp.filter((f) => /(^|\/)Dockerfile[^/]*$/.test(f));
  if (docker.length) facts.push(`Dockerfile: ${docker.slice(0, 3).join(", ")}`);
  // IaC do PRÓPRIO app: iac/<nome-do-app>/ (nunca o de outro app do monorepo)
  const appName = dir === "" ? null : path.posix.basename(dir);
  const iac = appName ? ctx.files.filter((f) => f.startsWith(`iac/${appName}/`)).slice(0, 3) : ctx.files.filter((f) => /(^|\/)iac\//.test(f)).slice(0, 3);
  if (iac.length) facts.push(`IaC/deploy do app: ${iac.join(", ")}`);
  const appSettings = inApp.filter((f) => /appsettings[^/]*\.json$|\.env(\.|$)|application[^/]*\.ya?ml$/i.test(f)).slice(0, 4);
  if (appSettings.length) facts.push(`Arquivos de configuração: ${appSettings.join(", ")}`);
  const co = loadCodeowners(ctx);
  const rule = co ? ownersFor(co, dir) : null;
  if (rule) facts.push(`Donos no CODEOWNERS: ${rule.owners.join(", ")}`);
  const wf = ctx.files.filter((f) => /^\.github\/workflows\//.test(f)).slice(0, 3);
  if (wf.length) facts.push(`Workflows de CI/CD: ${wf.join(", ")}`);
  return facts;
}

export function planReadme(ctx: Ctx): ActionPlan | null {
  const { statuses } = readmeStatuses(ctx);
  const guided: GuidedTask[] = [];
  for (const s of statuses) {
    if (s.readme && s.missing.length === 0) continue;
    const label = s.app.dir || s.app.name;
    const target = s.readme ?? (s.app.dir ? `${s.app.dir}/README.md` : "README.md");
    const facts = appFacts(ctx, s.app.dir);
    guided.push({
      id: `readme:${s.app.dir || "."}`,
      title: `README de ${label}`,
      targets: [target],
      instructions: [
        `${s.readme ? "Complete" : "Crie"} \`${target}\` (app ${label}).`,
        `Seções obrigatórias que faltam (o título de cada uma deve casar com um destes padrões, em pt ou en): ${s.missing.map((m) => `${m.label} [${m.match.join(" | ")}]`).join("; ")}.`,
        `Fatos verificáveis do app: ${facts.length ? facts.join(" · ") : "(poucos; leia o código e a pasta do app)"}.`,
        "Regras: preserve o conteúdo existente; escreva só o que pode ser confirmado no repo; se uma seção não se aplica, diga isso e por quê; sem marcadores TODO/TBD nem texto-modelo; links apenas para arquivos que existem.",
        "",
        PATH_RULES_BLOCK,
        "",
        `Altere somente \`${target}\`.`,
      ].join("\n"),
    });
  }
  return guided.length ? { changes: [], guided, notes: [], postSteps: [] } : null;
}
