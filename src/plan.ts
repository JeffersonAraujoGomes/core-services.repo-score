import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { MIN_COVERAGE_FOR_GRADE } from "./analyze.js";
import { resolveSelection } from "./groups-config.js";
import { ALL_COLLECTORS as COLLECTORS } from "./groups/index.js";
import { createCtx, git } from "./collectors/context.js";
import { loadPolicy } from "./policy.js";
import { hasCommand } from "./util/proc.js";
import { parseRubric } from "./schema/rubric.js";

export interface ToolCheck {
  name: string;
  required: boolean;
  found: boolean;
  why: string;
  install?: string;
}

export interface GroupPlan {
  id: string;
  title: string;
  weight: number;
  criteria: number;
  /** Critérios que esta versão sabe medir automaticamente. */
  measurable: number;
  /** Ativado na configuração: só grupos ativados podem ser escolhidos. */
  enabled: boolean;
  selected: boolean;
}

export interface PlanOutput {
  repo: {
    name: string;
    path: string;
    exists: boolean;
    is_git: boolean;
    branch: string | null;
    commit: string | null;
    dirty: boolean;
    shallow: boolean;
    files: number;
    commits: number | null;
    policy_file: string | null;
  };
  /** Impede a análise (ex.: caminho inexistente). */
  blockers: string[];
  /** Não impede, mas reduz o que pode ser medido. */
  warnings: string[];
  tools: ToolCheck[];
  groups: GroupPlan[];
  enabled_groups: { groups: string[]; source: string; file: string | null };
  selection: {
    groups: string[];
    criteria: number;
    measurable: number;
    /** Maior fração do peso que esta versão consegue medir no escopo escolhido. */
    max_weight_coverage: number;
    /** A nota será E por cobertura insuficiente mesmo que tudo o que é medido passe. */
    grade_will_be_capped_at_e: boolean;
  };
  estimate: {
    /** A medição é feita por scripts determinísticos: não usa tokens. */
    measurement_tokens: 0;
    session_tokens: { low: number; high: number };
    breakdown: { item: string; low: number; high: number }[];
    seconds: number;
    notes: string[];
  };
}

const tokensOf = (chars: number) => Math.ceil(chars / 3.5);

export function estimateSession(skillChars: number, planChars: number): PlanOutput["estimate"]["session_tokens"] & {
  breakdown: PlanOutput["estimate"]["breakdown"];
} {
  const breakdown = [
    { item: "instruções da skill", low: tokensOf(skillChars), high: tokensOf(skillChars) },
    { item: "plano e perguntas (caminho, grupos, confirmação)", low: tokensOf(planChars) + 600, high: tokensOf(planChars) + 1400 },
    { item: "resultado da análise lido pelo Claude", low: 900, high: 3500 },
    { item: "resposta final ao usuário", low: 400, high: 900 },
  ];
  return {
    low: breakdown.reduce((s, b) => s + b.low, 0),
    high: breakdown.reduce((s, b) => s + b.high, 0),
    breakdown,
  };
}

function installHint(tool: "git" | "gh" | "node"): string {
  const p = process.platform;
  const hints = {
    git: { darwin: "xcode-select --install  (ou: brew install git)", win32: "winget install Git.Git", linux: "sudo apt install git  (ou o gerenciador da sua distro)" },
    gh: { darwin: "brew install gh", win32: "winget install GitHub.cli", linux: "veja https://cli.github.com" },
    node: { darwin: "instale o Node 20+ em https://nodejs.org  (ou: brew install node@20)", win32: "winget install OpenJS.NodeJS.LTS", linux: "instale o Node 20+ (https://nodejs.org ou nvm)" },
  } as const;
  const h = hints[tool];
  return p === "darwin" ? h.darwin : p === "win32" ? h.win32 : h.linux;
}

export interface PlanOptions {
  root: string;
  rubricPath: string;
  policyPath?: string;
  groups?: string[];
  /** Caminho do SKILL.md, para estimar os tokens das instruções. */
  skillMdPath?: string;
}

export function plan(opts: PlanOptions): PlanOutput {
  const root = path.resolve(opts.root);
  const rubric = parseRubric(JSON.parse(readFileSync(opts.rubricPath, "utf8")));
  const { selected, enabled } = resolveSelection(rubric, opts.groups);
  const measurableIds = new Set(COLLECTORS.flatMap((c) => c.ids));

  const blockers: string[] = [];
  const warnings: string[] = [];
  const exists = existsSync(root) && statSync(root).isDirectory();
  if (!exists) blockers.push(`o diretório não existe: ${root}`);

  const gitFound = hasCommand("git");
  let isGit = false;
  let files = 0;
  let commits: number | null = null;
  let shallow = false;
  let branch: string | null = null;
  let commit: string | null = null;
  let dirty = false;
  let policyFile: string | null = null;

  if (exists) {
    let policyDefaults;
    try {
      const lp = loadPolicy(root, opts.policyPath);
      policyDefaults = lp.policy;
      policyFile = lp.source;
    } catch (e) {
      blockers.push((e as Error).message);
    }
    if (policyDefaults) {
      const ctx = createCtx(root, policyDefaults);
      isGit = ctx.isGit;
      files = ctx.files.length;
    }
    if (isGit) {
      const n = Number(git(root, ["rev-list", "--count", "HEAD"])?.trim());
      commits = Number.isFinite(n) ? n : null;
      shallow = git(root, ["rev-parse", "--is-shallow-repository"])?.trim() === "true";
      branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() ?? null;
      commit = git(root, ["rev-parse", "--short", "HEAD"])?.trim() ?? null;
      dirty = (git(root, ["status", "--porcelain"]) ?? "").trim() !== "";
    }
  }

  if (exists && !isGit) {
    warnings.push("o diretório não é um repositório git: histórico, commits e ADRs (S2, P4, D3) não serão medidos e os arquivos ignorados pelo .gitignore entram na análise");
  }
  if (!gitFound) warnings.push(`git não encontrado no PATH. Instale: ${installHint("git")}`);
  if (shallow) warnings.push("clone raso: a verificação do histórico (S2) e dos commits (P4) fica parcial");
  if (files > 50_000) warnings.push(`repositório grande (${files} arquivos): a análise pode levar mais tempo`);
  if (exists && !policyFile) warnings.push("sem repo-score.policy.json: todos os critérios contam como aplicáveis (N/A só existe se declarado)");

  const tools: ToolCheck[] = [
    { name: "node", required: true, found: true, why: `executa a análise (Node ${process.versions.node})` },
    { name: "git", required: true, found: gitFound, why: "histórico, commits, ADRs e lista de arquivos respeitando .gitignore", ...(gitFound ? {} : { install: installHint("git") }) },
    { name: "gh", required: false, found: hasCommand("gh"), why: "futuro: proteção de branch, status de CI e checks obrigatórios (T6, T7, P1)", ...(hasCommand("gh") ? {} : { install: installHint("gh") }) },
  ];
  if (!tools[1]!.found) blockers.push("git é necessário para a análise");

  const groups: GroupPlan[] = rubric.dimensions.map((d) => ({
    id: d.id,
    title: d.title,
    weight: d.weight,
    criteria: d.criteria.length,
    measurable: d.criteria.filter((c) => measurableIds.has(c.id)).length,
    enabled: enabled.enabled.includes(d.id),
    selected: selected.includes(d.id),
  }));

  const inScope = rubric.dimensions.filter((d) => selected.includes(d.id)).flatMap((d) => d.criteria);
  const scopeWeight = inScope.reduce((s, c) => s + c.weight, 0);
  const measurableWeight = inScope.filter((c) => measurableIds.has(c.id)).reduce((s, c) => s + c.weight, 0);
  const maxCoverage = scopeWeight > 0 ? measurableWeight / scopeWeight : 0;

  const skillChars = opts.skillMdPath && existsSync(opts.skillMdPath) ? readFileSync(opts.skillMdPath, "utf8").length : 5000;
  const base = { groups, blockers, warnings, tools };
  const planChars = JSON.stringify(base).length;
  const est = estimateSession(skillChars, planChars);

  return {
    repo: { name: path.basename(root), path: root, exists, is_git: isGit, branch, commit, dirty, shallow, files, commits, policy_file: policyFile },
    blockers,
    warnings,
    tools,
    groups,
    enabled_groups: { groups: enabled.enabled, source: enabled.source, file: enabled.file },
    selection: {
      groups: selected,
      criteria: inScope.length,
      measurable: inScope.filter((c) => measurableIds.has(c.id)).length,
      max_weight_coverage: maxCoverage,
      grade_will_be_capped_at_e: maxCoverage + 1e-9 < MIN_COVERAGE_FOR_GRADE,
    },
    estimate: {
      measurement_tokens: 0,
      session_tokens: { low: est.low, high: est.high },
      breakdown: est.breakdown,
      seconds: Math.max(2, Math.ceil(1 + files / 5000 + (commits ?? 0) / 2000)),
      notes: [
        "A medição é feita por scripts determinísticos, sem chamar modelo: 0 tokens.",
        "Os tokens acima são os que esta conversa acrescenta (instruções da skill, perguntas, leitura do resultado e resposta).",
        "Cada turno também relê o contexto da conversa (em geral com cache); o consumo no seu plano pode ser maior se a sessão já for longa.",
        "Nesta versão não há agentes de leitura de código: os critérios semânticos entram em versões futuras, e a previsão passará a incluí-los.",
      ],
    },
  };
}

export function formatPlan(p: PlanOutput): string {
  const L: string[] = [];
  L.push(`Repositório: ${p.repo.name} (${p.repo.path})`);
  if (p.repo.is_git) L.push(`  git: ${p.repo.branch ?? "?"}@${p.repo.commit ?? "?"}${p.repo.dirty ? " com alterações não commitadas" : ""} · ${p.repo.commits ?? "?"} commits · ${p.repo.files} arquivos`);
  for (const b of p.blockers) L.push(`BLOQUEIO: ${b}`);
  for (const w of p.warnings) L.push(`Aviso: ${w}`);
  L.push("Ferramentas:");
  for (const t of p.tools) L.push(`  - ${t.name}: ${t.found ? "ok" : t.required ? "FALTA (obrigatória)" : "não encontrada (opcional)"} — ${t.why}${!t.found && t.install ? ` · instalar: ${t.install}` : ""}`);
  L.push("Grupos de análise:");
  for (const g of p.groups) L.push(`  ${g.selected ? "[x]" : "[ ]"} ${g.id} — ${g.title} (peso ${g.weight}): ${g.criteria} critérios, ${g.measurable} com medição automática${g.enabled ? "" : " · DESATIVADO"}`);
  if (p.groups.some((g) => !g.enabled)) L.push(`Ativados: ${p.enabled_groups.groups.join(", ")} (config: ${p.enabled_groups.source}). Para ativar outros: repo-score groups set <ids>`);
  const pct = Math.round(p.selection.max_weight_coverage * 100);
  L.push(`Escopo: ${p.selection.criteria} critérios, ${p.selection.measurable} mensuráveis nesta versão (até ${pct}% do peso).`);
  if (p.selection.grade_will_be_capped_at_e) L.push(`ATENÇÃO: com cobertura máxima de ${pct}% (mínimo ${Math.round(MIN_COVERAGE_FOR_GRADE * 100)}%), a nota será E por cobertura insuficiente.`);
  L.push(`Previsão: medição 0 tokens · conversa ≈ ${p.estimate.session_tokens.low.toLocaleString("pt-BR")}–${p.estimate.session_tokens.high.toLocaleString("pt-BR")} tokens · ≈ ${p.estimate.seconds} s`);
  return L.join("\n");
}
