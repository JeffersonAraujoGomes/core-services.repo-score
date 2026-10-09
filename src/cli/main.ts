import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyze, persist, type ReportData } from "../analyze.js";
import { enabledGroups, resetUserEnabled, setUserEnabled, userConfigPath } from "../groups-config.js";
import { formatPlan, plan } from "../plan.js";
import { finishFix, FixError, loadState, parseParams, previewFixes, resumeFix, sealFix, startFix, type Decision } from "../remediation/engine.js";
import { formatFinish, formatPreview, formatSeal, formatStart, formatState, formatSuggestions } from "../remediation/format.js";
import { renderReport } from "../report/render.js";
import { ResultsFileSchema } from "../schema/evidence.js";
import { parseRubric } from "../schema/rubric.js";
import { score } from "../scorer/score.js";
import { verifyResults } from "../verify/verify-evidence.js";

const USAGE = `repo-score <comando>

  plan <caminho-do-repo> [--groups a,b] [--policy <arquivo>] [--json]
      Não mede nada: verifica pré-requisitos, lista os grupos de análise e prevê o gasto de tokens.
  analyze <caminho-do-repo> [--groups a,b] [--policy <arquivo>] [--out <pasta>] [--no-open] [--json]
      Mede o repositório com os coletores automáticos, verifica as evidências, calcula a nota,
      grava o relatório HTML em ~/.repo-score/<repo>/ e o abre no navegador.
      Grupos: security, tests, code, architecture, operability, documentation, process (padrão: todos).
  score --results <results.json> [--repo-root <dir>] [--rubric <rubric.json>] [--out <result.json>]
      Só o cálculo: verifica evidências (se --repo-root) e pontua um arquivo de resultados.
  validate-rubric [--rubric <rubric.json>]
      Valida o rubric.json e imprime um resumo.

  groups
      Mostra quais grupos estão ativados (só eles podem ser escolhidos) e de onde vem essa configuração.
  groups set <ids|all>
      Ativa os grupos informados (grava em ~/.repo-score/config.json). groups reset volta ao padrão da skill.
      Também vale a variável REPO_SCORE_ENABLED_GROUPS (ids separados por vírgula, ou all).

  fixes <caminho-do-repo> [--groups a,b] [--json]
      Lista as ações de correção dos grupos avaliados, com melhoria potencial de nota, tokens e pré-requisitos.
  fix preview <repo> --actions a,b [--param k=v ...]
      Mostra o que cada ação faria. Não escreve nada e não cria branch.
  fix start <repo> --actions a,b [--param k=v ...] [--groups a,b] [--allow-dirty] [--skip-hooks] [--branch nome]
      Cria uma BRANCH NOVA (a atual não é tocada), aplica as ações e commita nela. Ações guiadas devolvem tarefas.
  fix resume <repo> [--skip-hooks]
      Retoma uma correção com commit bloqueado por hook: commita o que ficou preparado e aplica as ações que não rodaram.
  fix seal <repo> [--skip-hooks]
      Commita o que faltar na branch nova e RECALCULA A NOTA NELA, comparando com a nota de partida.
  fix finish <repo> --decision merge|keep|discard [--confirm]
      Decisão do usuário: mesclar na branch de origem (sem push), manter a branch para revisão, ou descartá-la.
  fix status <repo>
      Mostra a correção em andamento.
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const VALUE_FLAGS = ["policy", "out", "groups", "rubric", "results", "repo-root", "actions", "param", "decision", "branch"];

const flagAll = (args: string[], name: string): string[] => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] !== undefined ? [args[i + 1]!] : []));

/** Primeiro argumento que não é flag nem valor de flag. */
function positional(args: string[]): string | undefined {
  return args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes((args[i - 1] ?? "").replace(/^--/, "")));
}

function groupsFlag(args: string[]): string[] | undefined {
  const g = flag(args, "groups");
  return g ? g.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
}

function defaultSkillMd(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.resolve(here, "../SKILL.md"), path.resolve(here, "../../skill/SKILL.md")].find((c) => existsSync(c));
}

function defaultRubricPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../references/rubric.json"), // skill/scripts -> skill/references
    path.resolve(here, "../../skill/references/rubric.json"), // src/cli -> skill/references
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error("rubric.json não encontrado; informe --rubric");
  return found;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`não foi possível ler ${file}: ${(e as Error).message}`);
  }
}

function openInBrowser(file: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [file]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", file]]
        : ["xdg-open", [file]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* sem navegador: o caminho do relatório já foi impresso */
  }
}

const fmt = (n: number | null) => (n === null ? "n/d" : (Math.floor(n * 10) / 10).toFixed(1));

function summary(data: ReportData, reportPath: string): string {
  const r = data.result;
  const lines: string[] = [];
  lines.push(`Repositório: ${data.meta.repo}${data.meta.branch ? ` (${data.meta.branch}${data.meta.commit ? `@${data.meta.commit}` : ""}${data.meta.dirty ? ", com alterações não commitadas" : ""})` : ""}`);
  const f = data.final;
  const pct = Math.round(r.coverage.weight_ratio * 100);
  lines.push(`Nota: ${f.grade}${f.reason === "insufficient_coverage" ? ` (cobertura insuficiente: ${pct}% do peso do escopo medido; mínimo ${Math.round(data.meta.min_coverage_for_grade * 100)}%)` : f.reason === "nothing_measured" ? " (nenhum critério medido)" : r.coverage.ratio < 1 ? " (provisória: parte dos critérios não foi medida)" : ""}`);
  if (f.reason) lines.push(`Pontuação dos critérios medidos: ${fmt(r.total)}/100${f.computed_grade && f.computed_grade !== f.grade ? ` (a letra seria ${f.computed_grade} se a cobertura fosse suficiente)` : ""}`);
  else lines.push(`Total: ${fmt(r.total)}/100`);
  const off = data.meta.groups.filter((g) => !data.meta.selected_groups.includes(g.id));
  lines.push(`Grupos avaliados: ${data.meta.groups.filter((g) => data.meta.selected_groups.includes(g.id)).map((g) => g.title).join(", ")}${off.length ? ` (não avaliados: ${off.map((g) => `${g.title}${data.meta.enabled_groups.includes(g.id) ? "" : " [desativado]"}`).join(", ")})` : ""}`);
  lines.push(`Medido: ${r.coverage.measured} de ${r.coverage.applicable} critérios (${Math.round(r.coverage.weight_ratio * 100)}% do peso da rubrica ${data.meta.rubric_version})`);
  if (r.blocked_by.length) lines.push(`GATE ACIONADO: ${r.blocked_by.join(", ")} (nota limitada a C)`);
  const c = data.comparison;
  if (c.status === "scope_changed") lines.push(`Comparação com a análise anterior suspensa: ${c.reason}`);
  if (c.status === "ok" || c.status === "regression") {
    lines.push(`Vs. análise anterior: ${c.delta >= 0 ? "+" : ""}${c.delta.toFixed(1)} pts${c.status === "regression" ? " (REGRESSÃO)" : ""}`);
  }
  lines.push("Dimensões:");
  for (const d of Object.values(r.dimensions)) {
    if (!data.meta.selected_groups.includes(d.id)) continue;
    const measured = d.criteria.filter((x) => x.state === "scored").length;
    lines.push(`  - ${d.title}: ${d.score_pct === null ? "não medida" : `${fmt(d.score_pct)}%`} (${measured} critérios medidos)`);
  }
  const zero = r.dimensions && Object.values(r.dimensions).flatMap((d) => d.criteria).filter((x) => x.state === "scored" && x.points < 2);
  if (zero && zero.length) {
    lines.push("Achados (critérios abaixo de 2 pontos):");
    for (const o of zero) {
      if (o.state !== "scored") continue;
      const ev = o.evidence.find((e) => e.kind === "file");
      const where = ev && ev.kind === "file" ? ` — ${ev.path}${ev.line ? `:${ev.line}` : ""}` : "";
      lines.push(`  - ${o.id} ${data.criteria[o.id]?.title} → ${o.points}/2 (valor ${o.value})${where}`);
    }
  }
  if (data.opportunities.length) {
    lines.push("Maiores ganhos:");
    for (const o of data.opportunities.slice(0, 3)) lines.push(`  - ${o.id} ${o.title}: +${o.gain.toFixed(1)} pts${o.unblocks_gate ? " (remove o gate)" : ""}`);
  }
  if (data.evidence_issues.length) lines.push(`Evidências descartadas na verificação: ${data.evidence_issues.length}`);
  lines.push(`Relatório: ${reportPath}`);
  return lines.join("\n");
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;

  if (cmd === "plan") {
    const target = positional(args);
    if (!target) {
      console.error("faltou o caminho do repositório\n\n" + USAGE);
      return 2;
    }
    const policyPath = flag(args, "policy");
    const groups = groupsFlag(args);
    const skillMdPath = defaultSkillMd();
    const p = plan({
      root: target,
      rubricPath: defaultRubricPath(),
      ...(policyPath ? { policyPath } : {}),
      ...(groups ? { groups } : {}),
      ...(skillMdPath ? { skillMdPath } : {}),
    });
    console.log(args.includes("--json") ? JSON.stringify(p, null, 2) : formatPlan(p));
    return p.blockers.length ? 3 : 0;
  }

  if (cmd === "analyze") {
    const target = positional(args);
    if (!target) {
      console.error("faltou o caminho do repositório\n\n" + USAGE);
      return 2;
    }
    const policyPath = flag(args, "policy");
    const outDir = flag(args, "out");
    const groups = groupsFlag(args);
    const { data, outDir: dir } = await analyze({
      root: target,
      rubricPath: defaultRubricPath(),
      ...(policyPath ? { policyPath } : {}),
      ...(outDir ? { outDir } : {}),
      ...(groups ? { groups } : {}),
    });
    const html = renderReport(data);
    const files = persist(dir, data, html);
    if (args.includes("--json")) console.log(JSON.stringify(data, null, 2));
    else console.log(summary(data, files.html));
    const reportUrl = pathToFileURL(path.join(dir, "report.html")).href;
    if (args.includes("--no-open")) console.error(`relatório: ${reportUrl}`);
    else {
      openInBrowser(path.join(dir, "report.html"));
      console.error(`abrindo ${reportUrl}`);
    }
    return 0;
  }

  if (cmd === "groups") {
    const rubric = parseRubric(readJson(flag(args, "rubric") ?? defaultRubricPath()));
    const sub = args[0];
    const asJson = args.includes("--json");
    if (sub === "set") {
      const ids = (args[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      if (ids.length === 0) throw new Error("uso: groups set <ids separados por vírgula | all>");
      const file = setUserEnabled(rubric, ids);
      console.log(`Grupos ativados gravados em ${file}.`);
    } else if (sub === "reset") {
      console.log(resetUserEnabled() ? `Configuração do usuário removida (${userConfigPath()}); vale o padrão da skill.` : "Não havia configuração do usuário.");
    } else if (sub !== undefined && sub !== "--json") {
      throw new Error(`subcomando desconhecido: groups ${sub}`);
    }
    const g = enabledGroups(rubric);
    const rows = rubric.dimensions.map((d) => ({ id: d.id, title: d.title, weight: d.weight, enabled: g.enabled.includes(d.id) }));
    if (asJson) console.log(JSON.stringify({ source: g.source, file: g.file, groups: rows }, null, 2));
    else {
      console.log(`Grupos (configuração: ${g.source}${g.file ? ` — ${g.file}` : ""}):`);
      for (const r of rows) console.log(`  [${r.enabled ? "x" : " "}] ${r.id} — ${r.title} (peso ${r.weight})${r.enabled ? "" : " · desativado"}`);
    }
    return 0;
  }

  if (cmd === "fixes") {
    const target = positional(args);
    if (!target) {
      console.error("faltou o caminho do repositório\n\n" + USAGE);
      return 2;
    }
    const policyPath = flag(args, "policy");
    const groups = groupsFlag(args);
    const { data } = await analyze({ root: target, rubricPath: defaultRubricPath(), ...(policyPath ? { policyPath } : {}), ...(groups ? { groups } : {}), outDir: path.join(os.tmpdir(), "repo-score-fixes") });
    console.log(args.includes("--json") ? JSON.stringify(data.fixes, null, 2) : formatSuggestions(data.fixes));
    return 0;
  }

  if (cmd === "fix") {
    const [sub, ...rest] = args;
    const target = positional(rest);
    if (!sub || !target) {
      console.error("uso: fix <preview|start|seal|finish|status> <repo> ...\n\n" + USAGE);
      return 2;
    }
    const policyPath = flag(rest, "policy");
    const rubricPath = defaultRubricPath();
    const actionIds = (flag(rest, "actions") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const params = parseParams(flagAll(rest, "param"));
    const groups = groupsFlag(rest);
    const json = rest.includes("--json");
    const out = (obj: unknown, text: string) => console.log(json ? JSON.stringify(obj, null, 2) : text);
    if (sub === "preview") {
      if (actionIds.length === 0) throw new FixError("informe --actions (veja `fixes`)");
      const items = previewFixes({ root: target, actionIds, params, ...(policyPath ? { policyPath } : {}) });
      out(items, formatPreview(items));
      return 0;
    }
    if (sub === "start") {
      if (actionIds.length === 0) throw new FixError("informe --actions (veja `fixes`)");
      const branch = flag(rest, "branch");
      const state = await startFix({ root: target, rubricPath, actionIds, params, ...(groups ? { groups } : {}), ...(policyPath ? { policyPath } : {}), allowDirty: rest.includes("--allow-dirty"), skipHooks: rest.includes("--skip-hooks"), ...(branch ? { branchName: branch } : {}) });
      out(state, formatStart(state));
      return state.status === "commit_blocked" ? 4 : 0;
    }
    if (sub === "resume") {
      const st = await resumeFix({ root: target, ...(policyPath ? { policyPath } : {}), skipHooks: rest.includes("--skip-hooks") });
      out(st, formatStart(st));
      return st.status === "commit_blocked" ? 4 : 0;
    }
    if (sub === "seal") {
      const r = await sealFix({ root: target, rubricPath, ...(policyPath ? { policyPath } : {}), skipHooks: rest.includes("--skip-hooks") });
      out(r.state, formatSeal(r));
      if (!rest.includes("--no-open")) openInBrowser(r.report.replace(/report-[^/]*\.html$/, "report.html"));
      return r.state.status === "commit_blocked" ? 4 : 0;
    }
    if (sub === "finish") {
      const decision = flag(rest, "decision") as Decision | undefined;
      if (!decision || !["merge", "keep", "discard"].includes(decision)) throw new FixError("informe --decision merge|keep|discard");
      const r = finishFix({ root: target, decision, confirm: rest.includes("--confirm"), skipHooks: rest.includes("--skip-hooks") });
      out(r.state, formatFinish(r));
      return 0;
    }
    if (sub === "status") {
      const st = loadState(path.resolve(target));
      out(st, formatState(st));
      return 0;
    }
    throw new FixError(`subcomando desconhecido: fix ${sub}`);
  }

  if (cmd === "validate-rubric") {
    const rubric = parseRubric(readJson(flag(args, "rubric") ?? defaultRubricPath()));
    const n = rubric.dimensions.reduce((s, d) => s + d.criteria.length, 0);
    console.log(`rubrica ${rubric.version} válida: ${rubric.dimensions.length} dimensões, ${n} critérios`);
    return 0;
  }

  if (cmd === "score") {
    const resultsPath = flag(args, "results");
    if (!resultsPath) {
      console.error("faltou --results\n\n" + USAGE);
      return 2;
    }
    const rubric = parseRubric(readJson(flag(args, "rubric") ?? defaultRubricPath()));
    const input = ResultsFileSchema.parse(readJson(resultsPath));
    if (input.rubric_version && input.rubric_version !== rubric.version) {
      console.error(`aviso: resultados gerados para a rubrica ${input.rubric_version}, calculando com ${rubric.version}`);
    }

    const repoRoot = flag(args, "repo-root");
    let issues: unknown[] = [];
    if (repoRoot) {
      const v = verifyResults(repoRoot, input.results);
      input.results = v.results;
      issues = v.issues;
    }

    const result = { ...score(rubric, input), evidence_issues: issues };
    const json = JSON.stringify(result, null, 2);
    const out = flag(args, "out");
    if (out) writeFileSync(out, json + "\n");
    else console.log(json);

    console.error(
      `nota ${result.grade ?? "n/d"} (${fmt(result.total)}) · medido ${result.coverage.measured}/${result.coverage.applicable}` +
        (result.blocked_by.length ? ` · gate: ${result.blocked_by.join(", ")}` : ""),
    );
    return 0;
  }

  console.error(USAGE);
  return cmd === undefined || cmd === "--help" || cmd === "help" ? 0 : 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`erro: ${(e as Error).message}`);
    process.exitCode = 1;
  },
);
