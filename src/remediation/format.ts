import type { ReportData } from "../analyze.js";
import type { FinishResult, FixState, PreviewItem, ScoreSummary, SealResult } from "./engine.js";
import type { FixSuggestion } from "./suggest.js";

const fmt = (n: number | null) => (n === null ? "n/d" : (Math.floor(n * 10) / 10).toFixed(1));
const tok = (n: number) => n.toLocaleString("pt-BR");
const kindLabel = (k: FixSuggestion["kind"]) => ({ auto: "automática (0 tokens)", guided: "guiada (Claude redige; gasta tokens)", mixed: "mista (script + Claude)", manual: "só avisos (revisão humana)" })[k];

export function formatSuggestions(fixes: FixSuggestion[]): string {
  if (fixes.length === 0) return "Nenhuma ação de correção disponível para os grupos avaliados.";
  const L = ["Ações de correção disponíveis, da maior para a menor melhoria potencial de nota:"];
  fixes.forEach((f, i) => {
    L.push(`${i + 1}. [${f.id}] ${f.title}`);
    L.push(`   ${kindLabel(f.kind)} · critérios ${f.criteria.join(", ")}${f.potential ? ` · potencial +${f.potential.gain_total.toFixed(1)} pts no total (teto)` : ""}`);
    L.push(`   ${f.summary}`);
    if (f.changes || f.guided_tasks) L.push(`   Escreve: ${f.changes} arquivo(s)${f.guided_tasks ? ` + ${f.guided_tasks} tarefa(s) guiada(s)` : ""}`);
    if (f.tokens) L.push(`   Tokens (estimativa): ≈ ${tok(f.tokens.low)}–${tok(f.tokens.high)} · ${f.tokens.basis}`);
    const missing = f.requires.filter((r) => !r.found);
    if (missing.length) L.push(`   Pré-requisitos ausentes: ${missing.map((r) => `${r.tool}${r.blocking ? " (obrigatório)" : ""}: ${r.why}`).join("; ")}`);
    if (f.params.length) L.push(`   Parâmetros: ${f.params.map((p) => p.key).join(", ")}`);
    for (const n of f.notes.slice(0, 3)) L.push(`   Aviso: ${n}`);
  });
  L.push("Todas as alterações vão para uma branch nova; a branch atual não é tocada e você decide o merge.");
  return L.join("\n");
}

export function formatPreview(items: PreviewItem[], target?: { mode: "in_place" | "new_branch"; branch: string | null; reason: string; session: FixState | null }): string {
  if (items.length === 0) return "Nada a alterar: nenhuma das ações selecionadas tem trabalho a fazer.";
  const where = !target
    ? "PRÉVIA (nada foi escrito)."
    : target.session
      ? `PRÉVIA (nada foi escrito). Há uma sessão aberta: ao aplicar, as ações entram na MESMA branch ${target.session.branch}, sem criar outra. A prévia considera a branch atual; para ver o efeito sobre a sessão, rode-a com a branch da sessão ativa.`
      : target.mode === "in_place"
        ? `PRÉVIA (nada foi escrito). Ao aplicar, as alterações serão COMMITADAS NA BRANCH ATUAL (${target.branch}), um commit por ação, sem criar branch nova.`
        : `PRÉVIA (nada foi escrito). Ao aplicar, será criada uma BRANCH NOVA (${target.reason}); a branch atual não é tocada.`;
  const L = [where];
  for (const it of items) {
    L.push(`\n[${it.id}] ${it.title}`);
    for (const c of it.changes) L.push(`  ${c.op === "create" ? "criar   " : c.op === "modify" ? "alterar " : "remover "}${c.path}  (${c.lines})${c.note ? ` — ${c.note}` : ""}`);
    for (const g of it.guided) L.push(`  tarefa guiada: ${g.title} → ${g.targets.length > 3 ? `${g.targets.length} arquivos` : g.targets.join(", ")}`);
    if (it.tokens) L.push(`  TOKENS (estimativa): ≈ ${tok(it.tokens.low)}–${tok(it.tokens.high)} · ${it.tokens.basis}`);
    for (const n of it.notes) L.push(`  aviso: ${n}`);
    for (const p of it.post_steps) L.push(`  fora da branch: ${p}`);
    const miss = it.requires.filter((r) => !r.found);
    if (miss.length) L.push(`  pré-requisitos ausentes: ${miss.map((r) => r.tool).join(", ")}`);
  }
  L.push("\nAções posteriores são planejadas depois das anteriores (ex.: o índice lista o que outras ações criam), então a lista final pode ter mais itens.");
  return L.join("\n");
}

function formatReused(s: FixState): string {
  const sess = s.session!;
  const L = [
    `SESSÃO ABERTA REAPROVEITADA: ${s.branch} (rodada ${sess.rounds}); nenhuma branch nova foi criada.`,
    `Origem: ${s.base_branch ?? "(HEAD destacado)"}@${s.base_commit.slice(0, 8)}, que NÃO foi alterada. A nota de partida segue sendo a da origem: ${s.baseline.grade} · ${fmt(s.baseline.total)}/100.`,
    `Ações da sessão até agora: ${s.actions.join(", ")}.`,
  ];
  if (sess.added_actions.length === 0 && s.status !== "commit_blocked") L.push(`Nada novo: ${s.actions.length ? "as ações pedidas já estavam aplicadas ou não têm o que alterar" : "sem alterações"}.`);
  else L.push(`Adicionado agora: ${sess.added_actions.join(", ")}.`);
  const tasks = s.guided_tasks.filter((t) => sess.added_tasks.includes(t.id));
  if (tasks.length) {
    L.push(`\nTarefas guiadas NOVAS (${tasks.length}) para o Claude executar agora, só nos arquivos indicados:`);
    for (const t of tasks) L.push(`  - ${t.title} → ${t.targets.join(", ")}`);
  }
  if (s.status === "commit_blocked" && s.blocked) {
    L.push(`\nCOMMIT BLOQUEADO por hook (${s.blocked.action}):`);
    L.push(s.blocked.output.split("\n").slice(0, 12).map((l) => `  | ${l}`).join("\n"));
    L.push("Se você aprova pular os hooks nesta correção, rode: fix resume --skip-hooks");
  }
  for (const n of s.notes.slice(-6)) L.push(`Aviso: ${n}`);
  L.push("\nPróximo passo: execute as tarefas guiadas (se houver) e rode `fix seal` (recalcula a nota NA BRANCH DA SESSÃO, contra a origem). Só encerre com `fix finish` quando não houver mais melhorias a aplicar.");
  return L.join("\n");
}

export function formatStart(s: FixState): string {
  if (s.session?.reused) return formatReused(s);
  if (s.status === "nothing_to_do") return `Nada a fazer: as ações selecionadas não produziram alterações. Nenhuma branch foi criada; você segue em ${s.base_branch ?? s.base_commit}.`;
  const L = s.mode === "in_place"
    ? [
        `ALTERAÇÕES NA BRANCH ATUAL: ${s.branch} (nenhuma branch nova foi criada).`,
        `Ponto de partida: ${s.branch}@${s.base_commit.slice(0, 8)}; cada ação vira um commit e dá para desfazer (fix finish --decision discard --confirm).`,
        `Nota de partida: ${s.baseline.grade} · ${fmt(s.baseline.total)}/100`,
      ]
    : [
        `BRANCH CRIADA: ${s.branch}`,
        `Origem: ${s.base_branch ?? "(HEAD destacado)"}@${s.base_commit.slice(0, 8)}. A branch de origem NÃO foi alterada.`,
        `Você está agora em ${s.branch}.`,
        `Nota de partida (medida na origem): ${s.baseline.grade} · ${fmt(s.baseline.total)}/100`,
      ];
  if (s.commits.length) {
    L.push(s.mode === "in_place" ? "Commits:" : "Commits na branch nova:");
    for (const c of s.commits) L.push(`  ${c.sha} ${c.subject}`);
  }
  if (s.status === "commit_blocked" && s.blocked) {
    L.push(`\nCOMMIT BLOQUEADO por hook (${s.blocked.action}). As alterações estão aplicadas e preparadas, mas sem commit:`);
    L.push(s.blocked.output.split("\n").slice(0, 12).map((l) => `  | ${l}`).join("\n"));
    L.push("Se você aprova pular os hooks nesta correção, rode: fix resume --skip-hooks (retoma e aplica as ações restantes)");
    if (s.not_applied?.length) L.push(`Ações ainda NÃO aplicadas (dependiam deste commit): ${s.not_applied.join(", ")}. fix resume as aplica depois do commit bloqueado.`);
  }
  if (s.guided_tasks.length) {
    L.push(`\nTarefas guiadas (${s.guided_tasks.length}) para o Claude executar agora, só nos arquivos indicados:`);
    for (const t of s.guided_tasks) L.push(`  - ${t.title} → ${t.targets.join(", ")}`);
  }
  for (const n of s.notes) L.push(`Aviso: ${n}`);
  for (const p of s.post_steps) L.push(`Fora da branch: ${p}`);
  L.push(s.guided_tasks.length ? "\nPróximo passo: execute as tarefas guiadas e rode `fix seal` (commita e recalcula a nota NA BRANCH NOVA)." : "\nPróximo passo: rode `fix seal` (recalcula a nota NA BRANCH NOVA).");
  return L.join("\n");
}

function criterionDiff(before: ScoreSummary, after: ScoreSummary): string[] {
  const out: string[] = [];
  for (const id of Object.keys(after.criteria)) {
    const a = before.criteria[id] ?? null;
    const b = after.criteria[id] ?? null;
    if (a !== b) out.push(`${id} ${a === null ? "não medido" : `${a}/2`} → ${b === null ? "não medido" : `${b}/2`}`);
  }
  return out;
}

export function formatSeal(r: SealResult): string {
  const { state: s, data } = r;
  const a = s.after!;
  const delta = s.baseline.total !== null && a.total !== null ? a.total - s.baseline.total : null;
  const L = [
    `RESULTADO MEDIDO NA BRANCH ${s.mode === "in_place" ? "ATUAL " : ""}${s.branch}@${data.meta.commit ?? "?"}${data.meta.dirty ? " (com alterações não commitadas)" : ""}:`,
    `  Antes  (${s.base_branch ?? "origem"}@${s.base_commit.slice(0, 8)}): nota ${s.baseline.grade} · ${fmt(s.baseline.total)}/100`,
    `  Depois (${s.branch}): nota ${a.grade} · ${fmt(a.total)}/100${delta === null ? "" : ` (${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pts)`}`,
  ];
  if (a.grade === "E" && data.final.reason === "insufficient_coverage") L.push(`  Obs.: a letra segue E por cobertura insuficiente (${Math.round(a.coverage_weight * 100)}% do peso medido); a pontuação dos critérios medidos é ${fmt(a.total)}/100.`);
  for (const id of Object.keys(a.dimensions)) {
    const b = s.baseline.dimensions[id] ?? null;
    if (b !== null || a.dimensions[id] !== null) L.push(`  ${data.meta.groups.find((g) => g.id === id)?.title ?? id}: ${b === null ? "n/d" : `${fmt(b)}%`} → ${a.dimensions[id] === null ? "n/d" : `${fmt(a.dimensions[id]!)}%`}`);
  }
  const diff = criterionDiff(s.baseline, a);
  L.push(diff.length ? `Critérios que mudaram: ${diff.join("; ")}` : "Nenhum critério mudou de pontuação.");
  if (a.blocked_by.length) L.push(`GATE ACIONADO: ${a.blocked_by.join(", ")}`);
  const checks = data.panels.filter((p) => p.group === "documentation").flatMap((p) => p.items).filter((i) => i.label === "Padrão das specs" || i.status === "fail");
  if (checks.length) {
    L.push("Verificações do SDD na branch:");
    for (const c of checks) L.push(`  ${c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✕"} ${c.label}: ${c.detail}`);
  }
  if (s.pending?.length) {
    L.push(`AINDA HÁ GANHO nas ações desta sessão: ${s.pending.map((p) => `${p.id} (até +${p.gain.toFixed(1)} pts)`).join(", ")}. Rode \`fix start --actions ${s.pending.map((p) => p.id).join(",")}\` de novo (reaproveita esta branch, sem criar outra) e \`fix seal\`; repita até o ganho acabar.`);
  }
  if (s.status === "commit_blocked" && s.blocked) L.push(`ATENÇÃO: há alterações sem commit (bloqueadas por hook em ${s.blocked.action}). A nota acima já as considera.`);
  if (s.commits.length) {
    L.push("Commits na branch:");
    for (const c of s.commits) L.push(`  ${c.sha} ${c.subject}`);
  }
  if (r.files) L.push(`Arquivos alterados em relação à origem:\n${r.files.split("\n").map((l) => `  ${l}`).join("\n")}`);
  for (const p of s.post_steps) L.push(`Fora da branch: ${p}`);
  L.push(`Relatório: ${r.report}`);
  if (s.mode === "in_place") {
    L.push(`\nAs alterações já estão commitadas em ${s.branch} (nada foi enviado). Para desfazer: fix finish --decision discard --confirm (commits de revert). Não há merge nem decisão pendente.`);
    return L.join("\n");
  }
  L.push(`\nDECISÃO (nada foi mesclado nem enviado):\n  merge    → fix finish --decision merge   (mescla ${s.branch} em ${s.base_branch ?? "origem"}, sem push)\n  keep     → fix finish --decision keep    (volta para ${s.base_branch ?? "origem"} e mantém a branch para revisão)\n  discard  → fix finish --decision discard --confirm   (apaga a branch)`);
  return L.join("\n");
}

export function formatFinish(r: FinishResult): string {
  return r.message;
}

export function formatState(s: FixState | null): string {
  if (!s) return "Nenhuma correção registrada para este repo.";
  return `${s.mode === "in_place" ? "Correção na branch atual" : "Sessão de correção"}: ${s.status} · branch ${s.branch} (origem ${s.base_branch ?? "HEAD destacado"}@${s.base_commit.slice(0, 8)}) · ações ${s.actions.join(", ")} · ${s.commits.length} commit(s)`;
}

export type { ReportData };
