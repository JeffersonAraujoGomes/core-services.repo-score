import type { Action } from "../../../remediation/types.js";
import { ruleGlobs, ruleUniverse } from "../collectors/d7-specs-rules.js";
import { buildSpecPlanCached } from "../sdd/discovery/plan.js";
import { lintSpecs } from "../sdd/discovery/lint.js";
import { readManifest } from "../shared/manifest.js";
import { estimateDiscoveryTokens, estimateGapTokens } from "../sdd/estimate.js";
import { estimateAdoption, estimateMigration } from "../sdd/tasks.js";
import { parseGlobs, planSdd } from "../sdd/scaffold.js";
import { planAdr } from "./adr.js";
import { planBrokenRefs } from "./broken-refs.js";
import { planHygiene } from "./hygiene.js";
import { planIndex } from "./index-docs.js";
import { planOwners } from "./owners.js";
import { planReadme } from "./readme.js";

const readManifestSpecsDir = (ctx: Parameters<typeof readManifest>[0], params: Record<string, string>): string => {
  const m = readManifest(ctx);
  return m.state === "ok" ? m.manifest.specsDir : (params["specs_dir"] || "docs/specs").replace(/\/+$/, "");
};

const git = { tool: "git", why: "as alterações vão para uma branch nova", blocking: true } as const;

/**
 * Catálogo de ações do grupo Documentação, NA ORDEM de aplicação: cada ação é planejada sobre o repo já com as
 * anteriores aplicadas, então o índice (que lista o que as outras criaram) vai por último.
 */
export const DOCUMENTATION_ACTIONS: Action[] = [
  {
    id: "sdd-adopt",
    group: "documentation",
    title: "Adotar ou completar o SDD (specs, hooks, skill e perímetro de regras)",
    summary: "Do zero: manifesto, hooks de commit/push, hook de sessão, seção no README, skill e descoberta das specs. Com SDD já adotado: amplia o perímetro do manifesto e cobre com specs as regras ainda sem documentação. A parte de specs é feita pelo Claude (gasta tokens).",
    criteria: ["D4", "D5", "D6", "D7", "D1", "D8"],
    kind: "mixed",
    requires: [
      git,
      { tool: "jq", why: "os hooks do SDD leem o manifest com jq e ficam inativos sem ele", blocking: false },
      { tool: "claude", why: "o sdd-analyze gera o plano de impacto com claude -p (consome tokens de quem commita a spec)", blocking: false },
    ],
    params: [
      { key: "specs_dir", label: "Pasta das specs", default: "docs/specs", help: "Onde ficam as especificações vivas." },
      { key: "skill_slug", label: "Nome da skill do domínio", help: "Ex.: sdd-pagamentos (padrão: sdd-<nome do repo>)." },
      { key: "rule_globs", label: "Globs do código de regra de negócio", help: "Separados por vírgula, ex.: src/Domain/Rules/*. O gate vigia esses arquivos." },
      { key: "project_name", label: "Nome do projeto", help: "Padrão: nome da pasta do repo." },
      { key: "max_specs", label: "Máximo de specs nesta rodada", default: "60", help: "Limita o plano (e o custo); as de menor densidade de regra ficam adiadas." },
      { key: "migrate", label: "Migrar specs legadas ao padrão", default: "auto", help: "none ignora as specs existentes fora do padrão." },
    ],
    plan: (ctx, params) => planSdd(ctx, params),
    estimateTokens(ctx, params) {
      const plan = planSdd(ctx, params);
      if (!plan?.guided.length) return null;
      const ids = plan.guided.map((g) => g.id);
      const parts: { low: number; high: number; basis: string }[] = [];
      if (ids.some((i) => i.startsWith("sdd-specs:"))) {
        const maxSpecs = Number(params["max_specs"]) > 0 ? Number(params["max_specs"]) : undefined;
        parts.push(estimateAdoption(buildSpecPlanCached(ctx, { specsDir: (params["specs_dir"] || "docs/specs").replace(/\/+$/, ""), ...(maxSpecs ? { maxSpecs } : {}) })));
      }
      if (ids.some((i) => i.startsWith("sdd-migrate:"))) parts.push(estimateMigration(ctx, lintSpecs(ctx, readManifestSpecsDir(ctx, params))));
      const u = ruleUniverse(ctx);
      if (ids.includes("sdd-gap-specs") && u) parts.push(estimateGapTokens(ctx, [...new Set([...u.declaredUncited, ...u.siblingsUncited])]));
      if (parts.length === 0) return estimateDiscoveryTokens(ctx, [...parseGlobs(params["rule_globs"]), ...ruleGlobs(ctx).globs]);
      return { low: parts.reduce((n, p) => n + p.low, 0), high: parts.reduce((n, p) => n + p.high, 0), basis: parts.map((p) => p.basis).join(" + ") };
    },
  },
  {
    id: "doc-hygiene",
    group: "documentation",
    title: "Remover resíduos (.DS_Store, .bak, relatórios efêmeros)",
    summary: "Apaga só lixo inequívoco e ajusta o .gitignore. Documentos vazios, com pendências ou soltos viram aviso para revisão humana.",
    criteria: ["D8"],
    kind: "auto",
    requires: [git],
    plan: (ctx) => planHygiene(ctx),
  },
  {
    id: "doc-adr",
    group: "documentation",
    title: "Criar a pasta de ADRs",
    summary: "docs/adr/ com modelo, índice e o ADR 0001 (registrar decisões em ADRs), como Proposto.",
    criteria: ["D3"],
    kind: "auto",
    requires: [git],
    plan: (ctx) => planAdr(ctx),
  },
  {
    id: "doc-owners",
    group: "documentation",
    title: "Gerar OWNERS.md a partir do CODEOWNERS",
    summary: "Substitui o texto-modelo pelos donos já declarados no CODEOWNERS. Não inventa nomes.",
    criteria: ["D2"],
    kind: "auto",
    requires: [git],
    plan: (ctx) => planOwners(ctx),
  },
  {
    id: "doc-refs",
    group: "documentation",
    title: "Corrigir referências de caminho quebradas",
    summary: "Corrige só as que têm um único arquivo de destino possível; as ambíguas viram aviso.",
    criteria: ["D4"],
    kind: "auto",
    requires: [git],
    plan: (ctx) => planBrokenRefs(ctx),
  },
  {
    id: "doc-readme",
    group: "documentation",
    title: "README por app com as seções obrigatórias",
    summary: "O Claude escreve ou completa o README de cada app com fatos verificáveis do repo (gasta tokens).",
    criteria: ["D1"],
    kind: "guided",
    requires: [git],
    plan: (ctx) => planReadme(ctx),
    estimateTokens(ctx) {
      const apps = planReadme(ctx)?.guided.length ?? 0;
      return apps ? { low: apps * 6_000, high: apps * 20_000, basis: `${apps} README(s) a escrever ou completar` } : null;
    },
  },
  {
    id: "doc-index",
    group: "documentation",
    title: "Indexar documentos e eliminar órfãos",
    summary: "Lista no índice (docs/README.md ou README.md) os documentos que ninguém aponta, em um bloco gerado e identificado.",
    criteria: ["D5", "D6"],
    kind: "auto",
    requires: [git],
    plan: (ctx) => planIndex(ctx),
  },
];
