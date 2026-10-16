import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { analyze, persist, repoSlug, reportsHome, type ReportData } from "../analyze.js";
import { createCtx } from "../collectors/context.js";
import { GROUP_MODULES } from "../groups/index.js";
import { loadPolicy } from "../policy.js";
import { renderReport } from "../report/render.js";
import type { Grade } from "../schema/rubric.js";
import { applyChanges, safeTarget, summarizeChange } from "./apply.js";
import { branchExists, currentBranch, git, GitError, headSha, isClean, isRepo, repoTop, tryGit, uniqueBranchName } from "./git.js";
import { COMMIT_PATHS_ENABLED, commitAll, mergeBranch, revertCommits, type CommitInfo } from "./commit-paths.js";
import type { Action, GuidedTask } from "./types.js";
import { hasCommand } from "../util/proc.js";

import { FixError } from "./errors.js";
export { FixError };

export interface ScoreSummary {
  grade: Grade;
  computed_grade: Grade | null;
  total: number | null;
  coverage_weight: number;
  dimensions: Record<string, number | null>;
  criteria: Record<string, number | null>;
  blocked_by: string[];
}

export type { CommitInfo };

export type FixStatus = "started" | "commit_blocked" | "sealed" | "merged" | "kept" | "discarded" | "nothing_to_do";

export interface FixState {
  version: 1;
  repo: string;
  root: string;
  /** `in_place`: commits na branch atual (padrão; `branch` = a branch atual). `new_branch`: branch dedicada (SDD ou --new-branch). */
  mode?: "new_branch" | "in_place";
  /** A skill só escreve arquivos; o commit é do usuário. `true` só com `--commit` explícito (um commit por ação). */
  auto_commit?: boolean;
  /** Arquivos que os scripts das ações criaram, alteraram ou removeram (as tarefas guiadas escrevem além disso). */
  touched?: string[];
  /** A correção começou com alterações do usuário na árvore (--allow-dirty): desfazer automático é recusado. */
  carried_dirty?: boolean;
  base_branch: string | null;
  base_commit: string;
  branch: string;
  groups: string[];
  actions: string[];
  params: Record<string, string>;
  created_at: string;
  status: FixStatus;
  guided_tasks: GuidedTask[];
  post_steps: string[];
  notes: string[];
  commits: CommitInfo[];
  baseline: ScoreSummary;
  after?: ScoreSummary;
  blocked?: { action: string; output: string };
  /** Ações que não chegaram a ser aplicadas porque um commit anterior foi bloqueado. */
  not_applied?: string[];
  /** O que o último `fix start` fez nesta branch: criou a sessão ou reaproveitou a que já estava aberta. */
  session?: { reused: boolean; added_actions: string[]; added_tasks: string[]; rounds: number };
  /** Critérios que PIORARAM em relação à nota de partida (a correção feriu algo): a causa deve ser corrigida antes de seguir. */
  regressions?: { id: string; title: string; from: number; to: number; evidence: string[]; suggested_action: string | null }[];
  /** Ações da sessão que, medido na branch, ainda têm ganho de nota: rode `fix start --actions <id>` de novo (mesma branch). */
  pending?: { id: string; title: string; gain: number }[];
}

export function summarize(data: ReportData): ScoreSummary {
  const criteria: ScoreSummary["criteria"] = {};
  for (const d of Object.values(data.result.dimensions)) for (const c of d.criteria) criteria[c.id] = c.state === "scored" ? c.points : null;
  return {
    grade: data.final.grade,
    computed_grade: data.final.computed_grade,
    total: data.result.total,
    coverage_weight: data.result.coverage.weight_ratio,
    dimensions: Object.fromEntries(Object.values(data.result.dimensions).map((d) => [d.id, d.score_pct])),
    criteria,
    blocked_by: data.result.blocked_by,
  };
}

export const allActions = (): Action[] => GROUP_MODULES.flatMap((g) => g.actions);

export function parseParams(list: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of list) {
    const i = p.indexOf("=");
    if (i <= 0) throw new FixError(`--param deve ser chave=valor (recebi "${p}")`);
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}

function resolveActions(ids: string[]): Action[] {
  const catalog = allActions();
  const unknown = ids.filter((id) => !catalog.some((a) => a.id === id));
  if (unknown.length) throw new FixError(`ação desconhecida: ${unknown.join(", ")} (disponíveis: ${catalog.map((a) => a.id).join(", ")})`);
  return catalog.filter((a) => ids.includes(a.id)); // ordem do catálogo, não a digitada
}

export const stateDir = (root: string) => path.join(reportsHome(), repoSlug(root));
const stateFile = (root: string) => path.join(stateDir(root), "fix-state.json");

export function loadState(root: string): FixState | null {
  try {
    return JSON.parse(readFileSync(stateFile(root), "utf8")) as FixState;
  } catch {
    return null;
  }
}

function saveState(state: FixState): void {
  mkdirSync(stateDir(state.root), { recursive: true });
  writeFileSync(stateFile(state.root), JSON.stringify(state, null, 2) + "\n");
}

function topRoot(target: string): string {
  const root = path.resolve(target);
  if (!existsSync(root)) throw new FixError(`diretório não encontrado: ${root}`);
  if (!isRepo(root)) throw new FixError("a correção exige um repositório git: as alterações vão para uma branch nova");
  return repoTop(root);
}

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

// ─────────────────────────────────────── preview ───────────────────────────────────────

export interface PreviewItem {
  id: string;
  title: string;
  kind: Action["kind"];
  changes: { op: string; path: string; note?: string; lines: string }[];
  guided: GuidedTask[];
  notes: string[];
  post_steps: string[];
  requires: { tool: string; found: boolean; why: string; blocking: boolean }[];
  /** Previsão de tokens das tarefas guiadas (null quando a ação é só script). */
  tokens: { low: number; high: number; basis: string } | null;
}

/** Simula o que cada ação faria (sem escrever, sem branch). Cada ação é planejada sobre o estado atual. */
export function previewFixes(opts: { root: string; actionIds: string[]; params: Record<string, string>; policyPath?: string }): PreviewItem[] {
  const root = topRoot(opts.root);
  const { policy } = loadPolicy(root, opts.policyPath);
  const out: PreviewItem[] = [];
  for (const action of resolveActions(opts.actionIds)) {
    const ctx = createCtx(root, policy);
    const plan = action.plan(ctx, opts.params);
    if (!plan) continue;
    out.push({
      id: action.id,
      title: action.title,
      kind: action.kind,
      changes: plan.changes.map((c) => summarizeChange(c, c.op === "modify" ? ctx.readText(c.path) : null)),
      guided: plan.guided,
      notes: plan.notes,
      post_steps: plan.postSteps,
      requires: action.requires.map((r) => ({ tool: r.tool, found: hasCommand(r.tool), why: r.why, blocking: r.blocking })),
      tokens: plan.guided.length ? (action.estimateTokens?.(ctx, opts.params) ?? null) : null,
    });
  }
  return out;
}

/**
 * Aplica as ações em ordem no working tree (cada uma planejada sobre o estado já alterado). Só escreve arquivos: o commit
 * é do usuário. Com `auto_commit` (--commit), commita uma a uma.
 */
function runActions(root: string, policyPath: string | undefined, actions: Action[], state: FixState, params: Record<string, string>, skipHooks: boolean, now: Date): void {
  const { policy } = loadPolicy(root, policyPath);
  const preDirty = new Set(dirtyPaths(root));
  for (const [i, action] of actions.entries()) {
    const ctx = createCtx(root, policy, now);
    const plan = action.plan(ctx, params);
    if (!plan) continue;
    state.notes.push(...plan.notes.map((n) => `${action.id}: ${n}`));
    state.post_steps.push(...plan.postSteps.map((n) => `${action.id}: ${n}`));
    // uma tarefa com o mesmo id (ex.: lote de specs de uma rodada anterior da sessão) é substituída pela versão atual do plano
    state.guided_tasks = [...state.guided_tasks.filter((t) => !plan.guided.some((g) => g.id === t.id)), ...plan.guided];
    if (plan.changes.length === 0) continue;
    for (const c of plan.changes) safeTarget(root, c.path);
    for (const c of plan.changes) if (preDirty.has(c.path)) state.notes.push(`${action.id}: ${c.path} já tinha alterações suas não commitadas; as mudanças desta ação foram somadas ao arquivo (revise com git diff).`);
    const touched = applyChanges(root, plan.changes);
    state.touched = [...new Set([...(state.touched ?? []), ...touched])];
    if (!state.auto_commit) continue;
    try {
      const c = commitAll(root, touched, `docs(repo-score): ${action.title}`, `Ação ${action.id}; critérios: ${action.criteria.join(", ")}.`, skipHooks);
      if (c) state.commits.push(c);
    } catch (e) {
      state.status = "commit_blocked";
      state.blocked = { action: action.id, output: e instanceof GitError ? e.stderr || e.message : (e as Error).message };
      state.not_applied = actions.slice(i + 1).map((a) => a.id);
      return;
    }
  }
}

// ─────────────────────────────────────── start ───────────────────────────────────────

export interface StartOptions {
  root: string;
  rubricPath: string;
  actionIds: string[];
  params: Record<string, string>;
  /** Grupos a medir; omitido = todos os ativados. */
  groups?: string[];
  policyPath?: string;
  allowDirty?: boolean;
  skipHooks?: boolean;
  branchName?: string;
  /** Força a branch nova mesmo para ações que gravam na atual. */
  newBranch?: boolean;
  /** Commita uma ação por vez (a skill NÃO usa: o padrão é só escrever os arquivos e deixar o commit com o usuário). */
  commit?: boolean;
  now?: Date;
}

/** Caminhos com alterações não commitadas (modificados, removidos ou novos). */
function dirtyPaths(root: string): string[] {
  return (tryGit(root, ["status", "--porcelain", "-z", "--untracked-files=all"]) ?? "")
    .split("\0")
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3));
}

/** Onde as ações vão gravar: na branch atual, ou numa branch nova (SDD, --new-branch, HEAD destacado ou sessão aberta). */
export function fixTarget(opts: { root: string; actionIds: string[]; newBranch?: boolean }): { mode: "in_place" | "new_branch"; branch: string | null; reason: string; session: FixState | null } {
  const root = topRoot(opts.root);
  const actions = resolveActions(opts.actionIds);
  const existing = loadState(root);
  const session = existing && SESSION_OPEN.includes(existing.status) && existing.mode !== "in_place" && branchExists(root, existing.branch) ? existing : null;
  if (session) return { mode: "new_branch", branch: session.branch, reason: "há uma sessão de correção aberta: as ações entram na mesma branch dela", session };
  const current = currentBranch(root);
  if (opts.newBranch) return { mode: "new_branch", branch: null, reason: "pedido explícito (--new-branch)", session: null };
  const dedicated = actions.find((a) => a.branch === "new");
  if (dedicated) return { mode: "new_branch", branch: null, reason: `${dedicated.id} exige branch dedicada`, session: null };
  if (!current) return { mode: "new_branch", branch: null, reason: "HEAD destacado: não há branch atual para commitar", session: null };
  return { mode: "in_place", branch: current, reason: "as alterações ficam no working tree da branch atual, sem commit (o commit é seu)", session: null };
}

/** Commita o que ficou na working tree da branch da sessão (trabalho guiado da rodada anterior). Devolve false se um hook bloqueou. */
function commitPending(root: string, state: FixState, skipHooks: boolean): boolean {
  try {
    const ids = state.guided_tasks.map((t) => t.id).join(", ");
    const c = commitAll(root, null, `docs(repo-score): ajustes${ids ? ` guiados (${ids})` : ""}`, "", skipHooks);
    if (c) state.commits.push(c);
    delete state.blocked;
    state.status = "started";
    return true;
  } catch (e) {
    state.status = "commit_blocked";
    state.blocked = { action: state.blocked?.action ?? "guided", output: e instanceof GitError ? e.stderr || e.message : (e as Error).message };
    return false;
  }
}

const SESSION_OPEN: FixStatus[] = ["started", "commit_blocked", "sealed"];

/**
 * Uma sessão = uma branch para todas as melhorias de nota pedidas enquanto ela está aberta. Um novo `fix start` com
 * a sessão aberta aplica a nova ação NA MESMA branch, mantendo a nota de partida (a da origem) como referência.
 */
function addToSession(opts: StartOptions, root: string, state: FixState, actions: Action[], now: Date): FixState {
  if (state.status === "commit_blocked") throw new FixError(`há um commit bloqueado por hook na branch ${state.branch}; rode "fix resume" (ou "fix seal --skip-hooks", se o usuário aprovar) antes de adicionar outra ação.`);
  if (currentBranch(root) !== state.branch) {
    if (!isClean(root)) throw new FixError(`a sessão de correção está na branch ${state.branch}, mas a branch atual tem alterações não commitadas. Commite ou guarde antes de continuar a sessão.`);
    git(root, ["switch", state.branch]);
  }
  const previous: FixStatus = state.status;
  const had = { commits: state.commits.length, touched: (state.touched ?? []).length, tasks: new Set(state.guided_tasks.map((t) => t.id)) };
  if (state.auto_commit && !isClean(root) && !commitPending(root, state, !!opts.skipHooks)) {
    saveState(state);
    return state;
  }
  runActions(root, opts.policyPath, actions, state, opts.params, !!opts.skipHooks, now);
  const added_tasks = state.guided_tasks.map((t) => t.id).filter((id) => !had.tasks.has(id));
  const changed = state.commits.length > had.commits || (state.touched ?? []).length > had.touched || added_tasks.length > 0;
  state.session = { reused: true, added_actions: changed ? actions.map((a) => a.id) : [], added_tasks, rounds: (state.session?.rounds ?? 1) + (changed ? 1 : 0) };
  if (changed) {
    state.actions = [...new Set([...state.actions, ...actions.map((a) => a.id)])];
    state.params = { ...state.params, ...opts.params };
    if ((state.status as FixStatus) !== "commit_blocked") state.status = "started";
    delete state.after; // a nota "depois" precisa ser recalculada com a nova ação
  } else if ((state.status as FixStatus) !== "commit_blocked") state.status = previous;
  saveState(state);
  return state;
}

export async function startFix(opts: StartOptions): Promise<FixState> {
  const root = topRoot(opts.root);
  const actions = resolveActions(opts.actionIds);
  if (actions.length === 0) throw new FixError("nenhuma ação selecionada");
  for (const a of actions) {
    for (const r of a.requires) if (r.blocking && !hasCommand(r.tool)) throw new FixError(`${a.id} exige ${r.tool}: ${r.why}`);
  }
  const existing = loadState(root);
  const now = opts.now ?? new Date();
  const target = fixTarget({ root, actionIds: opts.actionIds, ...(opts.newBranch ? { newBranch: true } : {}) });
  if (existing?.mode === "in_place" && existing.status === "commit_blocked" && branchExists(root, existing.branch)) {
    throw new FixError(`há um commit bloqueado por hook na branch ${existing.branch}; rode "fix resume" (ou "fix seal --skip-hooks", se o usuário aprovar) antes de aplicar outra ação.`);
  }
  if (target.session) return addToSession(opts, root, target.session, actions, now);
  const inPlace = target.mode === "in_place";
  if (opts.commit && !COMMIT_PATHS_ENABLED) throw new FixError("--commit não existe nesta versão da skill: ela só cria, altera e remove arquivos, e o commit é seu.");
  const autoCommit = !!opts.commit;
  // sem commit automático, na branch atual, as alterações do usuário convivem com as da skill (o commit é dele); nos demais casos a árvore precisa estar limpa
  const mustBeClean = autoCommit || !inPlace;
  if (mustBeClean && !isClean(root) && !opts.allowDirty) {
    throw new FixError("há alterações não commitadas na branch atual. Commite ou guarde (git stash) antes, ou use --allow-dirty (as alterações viajam para a branch nova, misturadas às da correção).");
  }

  const baseBranch = currentBranch(root);
  const baseCommit = headSha(root);
  if (!baseCommit) throw new FixError("o repositório não tem commits");

  // 1. nota de partida, na branch atual (a referência da comparação)
  const base = await analyze({ root, rubricPath: opts.rubricPath, ...(opts.groups ? { groups: opts.groups } : {}), ...(opts.policyPath ? { policyPath: opts.policyPath } : {}), now });
  persist(base.outDir, base.data, renderReport(base.data));

  // 2. branch nova (SDD, --new-branch): a atual não é tocada. Nas demais ações, os commits vão para a branch atual.
  const branch = inPlace ? baseBranch! : uniqueBranchName(root, opts.branchName ?? `docs/repo-score-${stamp(now)}`);
  if (!inPlace) git(root, ["switch", "-c", branch]);

  const state: FixState = {
    version: 1,
    mode: inPlace ? "in_place" : "new_branch",
    repo: path.basename(root),
    root,
    base_branch: baseBranch,
    base_commit: baseCommit,
    branch,
    groups: base.data.meta.selected_groups,
    actions: actions.map((a) => a.id),
    params: opts.params,
    created_at: now.toISOString(),
    status: "started",
    auto_commit: autoCommit,
    touched: [],
    ...(!isClean(root) ? { carried_dirty: true } : {}),
    session: { reused: false, added_actions: actions.map((a) => a.id), added_tasks: [], rounds: 1 },
    guided_tasks: [],
    post_steps: [],
    notes: [],
    commits: [],
    baseline: summarize(base.data),
  };

  runActions(root, opts.policyPath, actions, state, opts.params, !!opts.skipHooks, now);
  state.session!.added_tasks = state.guided_tasks.map((t) => t.id);
  if (state.status === "commit_blocked") {
    saveState(state);
    return state;
  }

  if (state.commits.length === 0 && state.guided_tasks.length === 0 && (state.touched ?? []).length === 0) {
    if (!inPlace) {
      git(root, baseBranch ? ["switch", baseBranch] : ["switch", "--detach", baseCommit]);
      git(root, ["branch", "-D", branch]);
    }
    state.status = "nothing_to_do";
  }
  saveState(state);
  return state;
}

// ─────────────────────────────────────── resume ───────────────────────────────────────

/**
 * Retoma uma correção cujo commit foi bloqueado por hook: commita o que ficou preparado (com --skip-hooks, se o
 * usuário aprovou) e aplica as ações que não chegaram a rodar, na mesma branch.
 */
export async function resumeFix(opts: { root: string; policyPath?: string; skipHooks?: boolean; now?: Date }): Promise<FixState> {
  const root = topRoot(opts.root);
  const state = loadState(root);
  if (!state || state.status !== "commit_blocked") throw new FixError("não há correção com commit bloqueado para retomar");
  if (currentBranch(root) !== state.branch) throw new FixError(`você não está na branch da correção. Rode: git switch ${state.branch}`);
  const now = opts.now ?? new Date();
  const blockedAction = allActions().find((a) => a.id === state.blocked?.action);
  try {
    const c = commitAll(root, null, `docs(repo-score): ${blockedAction?.title ?? "ajustes"}`, "", !!opts.skipHooks);
    if (c) state.commits.push(c);
  } catch (e) {
    state.blocked = { action: state.blocked?.action ?? "?", output: e instanceof GitError ? e.stderr || e.message : (e as Error).message };
    saveState(state);
    return state;
  }
  const pending = state.not_applied ?? [];
  delete state.blocked;
  delete state.not_applied;
  state.status = "started";
  runActions(root, opts.policyPath, resolveActions(pending), state, state.params, !!opts.skipHooks, now);
  saveState(state);
  return state;
}

// ─────────────────────────────────────── seal ───────────────────────────────────────

export interface SealResult {
  state: FixState;
  data: ReportData;
  files: string;
  report: string;
}

export async function sealFix(opts: { root: string; rubricPath: string; policyPath?: string; skipHooks?: boolean; now?: Date }): Promise<SealResult> {
  const root = topRoot(opts.root);
  const state = loadState(root);
  if (!state) throw new FixError("nenhuma correção em andamento neste repo (rode fix start antes)");
  if (!["started", "commit_blocked", "sealed"].includes(state.status)) throw new FixError(`a correção está ${state.status}; nada a selar`);
  if (currentBranch(root) !== state.branch) throw new FixError(`você não está na branch da correção. Rode: git switch ${state.branch}`);

  if (state.auto_commit && !isClean(root)) commitPending(root, state, !!opts.skipHooks);
  else if (state.status === "commit_blocked") {
    delete state.blocked;
    state.status = "started";
  }

  // a nota é recalculada NA BRANCH NOVA (working tree dela), nunca estimada
  const after = await analyze({ root, rubricPath: opts.rubricPath, groups: state.groups, ...(opts.policyPath ? { policyPath: opts.policyPath } : {}), ...(opts.now ? { now: opts.now } : {}) });
  const persisted = persist(after.outDir, after.data, renderReport(after.data));
  state.after = summarize(after.data);
  state.regressions = findRegressions(state.baseline, state.after, after.data);
  // ações da sessão que ainda têm ganho de nota medido (ação só com tarefa sem efeito na nota não entra)
  state.pending = after.data.fixes.filter((f) => state.actions.includes(f.id) && f.prompt !== null && (f.potential?.gain_total ?? 0) > 0).map((f) => ({ id: f.id, title: f.title, gain: f.potential!.gain_total }));
  if (state.status !== "commit_blocked") state.status = "sealed";
  saveState(state);
  // sem commit automático, o que mudou está no working tree; com commits, o diff em relação à origem
  const files = state.auto_commit ? (tryGit(root, ["diff", "--stat", `${state.base_commit}...HEAD`]) ?? "") : (tryGit(root, ["status", "--short", "--untracked-files=all"]) ?? "");
  return { state, data: after.data, files: files.trimEnd(), report: persisted.html };
}

/** Critérios que caíram em relação à partida, com as evidências atuais e a ação que costuma reparar (se ainda houver). */
export function findRegressions(before: ScoreSummary, after: ScoreSummary, data: ReportData): NonNullable<FixState["regressions"]> {
  const outcomes = new Map(Object.values(data.result.dimensions).flatMap((d) => d.criteria).map((c) => [c.id, c]));
  const out: NonNullable<FixState["regressions"]> = [];
  for (const [id, to] of Object.entries(after.criteria)) {
    const from = before.criteria[id] ?? null;
    if (from === null || to === null || to >= from) continue;
    const o = outcomes.get(id);
    const evidence = o && o.state === "scored"
      ? o.evidence.slice(0, 6).map((e) => (e.kind === "file" ? `${e.path}:${e.line}${e.snippet ? `  ${e.snippet}` : ""}${e.note ? `  (${e.note})` : ""}` : e.kind === "job" ? `${e.name}${e.note ? `: ${e.note}` : ""}` : e.kind))
      : [];
    const fix = data.fixes.find((f) => f.criteria.includes(id) && f.prompt !== null && f.kind === "auto");
    out.push({ id, title: data.criteria[id]?.title ?? id, from, to, evidence, suggested_action: fix?.id ?? null });
  }
  return out;
}

// ─────────────────────────────────────── finish ───────────────────────────────────────

export type Decision = "merge" | "keep" | "discard";

export interface FinishResult {
  state: FixState;
  decision: Decision;
  message: string;
}

export function finishFix(opts: { root: string; decision: Decision; confirm?: boolean; skipHooks?: boolean }): FinishResult {
  const root = topRoot(opts.root);
  const state = loadState(root);
  if (!state) throw new FixError("nenhuma correção em andamento neste repo");
  if (["merged", "kept", "discarded", "nothing_to_do"].includes(state.status)) throw new FixError(`a correção já foi concluída (${state.status})`);
  if (!branchExists(root, state.branch)) throw new FixError(`a branch ${state.branch} não existe mais`);
  if (state.mode === "in_place") return finishInPlace(root, state, opts);
  const back = () => git(root, state.base_branch ? ["switch", state.base_branch] : ["switch", "--detach", state.base_commit]);

  if (opts.decision === "discard") {
    if (!opts.confirm) throw new FixError("descartar apaga a branch e todo o trabalho dela, inclusive os arquivos ainda não commitados; confirme com --confirm");
    if (state.carried_dirty) throw new FixError("a correção começou com alterações suas não commitadas (--allow-dirty); descartar a branch as apagaria junto. Desfaça com git, à mão.");
    git(root, state.base_branch ? ["switch", "-f", state.base_branch] : ["switch", "-f", "--detach", state.base_commit]);
    git(root, ["branch", "-D", state.branch]);
    // a troca forçada restaura os arquivos rastreados; os arquivos NOVOS (não rastreados) criados pelos scripts são removidos aqui
    const removed: string[] = [];
    for (const rel of state.touched ?? []) {
      if (tryGit(root, ["ls-files", "--error-unmatch", "--", rel]) !== null) continue;
      const abs = safeTarget(root, rel);
      if (existsSync(abs)) {
        rmSync(abs, { force: true });
        removed.push(rel);
      }
    }
    const leftover = dirtyPaths(root);
    state.status = "discarded";
    saveState(state);
    return { state, decision: "discard", message: `Branch ${state.branch} descartada. Você voltou para ${state.base_branch ?? state.base_commit}; ${removed.length} arquivo(s) novo(s) dos scripts removido(s).${leftover.length ? ` Sobraram ${leftover.length} arquivo(s) não rastreado(s) (escritos pelas tarefas guiadas); apague se quiser: ${leftover.slice(0, 10).join(", ")}${leftover.length > 10 ? ", …" : ""}` : ""}` };
  }

  if (state.status === "commit_blocked") throw new FixError("há um commit bloqueado por hook; resolva (fix seal --skip-hooks, se aprovado) antes de concluir");
  if (!isClean(root)) {
    // a skill não commita: as alterações estão no working tree da branch. Manter = ficar nela e commitar à mão; mesclar só leva commits.
    if (opts.decision === "merge") throw new FixError(`há alterações não commitadas na branch ${state.branch}: commite (ou guarde) antes. O merge só leva commits.`);
    state.status = "kept";
    saveState(state);
    return { state, decision: "keep", message: `Mantido: você segue na branch ${state.branch} com as alterações ainda não commitadas. Revise (git status, git diff) e commite quando quiser; depois mescle em ${state.base_branch ?? state.base_commit} do seu jeito.` };
  }
  if (opts.decision === "merge" && !COMMIT_PATHS_ENABLED) {
    throw new FixError(`o merge feito pela skill não existe nesta versão: ela não cria commits. Commite na branch ${state.branch} e mescle você mesmo (git switch ${state.base_branch ?? state.base_commit} && git merge ${state.branch}).`);
  }
  back();
  if (opts.decision === "keep") {
    state.status = "kept";
    saveState(state);
    return { state, decision: "keep", message: `Você voltou para ${state.base_branch ?? state.base_commit}; a branch ${state.branch} continua para revisão (git diff ${state.base_branch ?? state.base_commit}...${state.branch}).` };
  }

  try {
    mergeBranch(root, state.branch, !!opts.skipHooks);
  } catch (e) {
    if (e instanceof FixError) throw e;
    throw new FixError(`o merge teve conflito ou foi bloqueado e foi desfeito; a branch ${state.branch} segue intacta. ${(e as Error).message}`);
  }
  state.status = "merged";
  saveState(state);
  return { state, decision: "merge", message: `Branch ${state.branch} mesclada em ${state.base_branch ?? state.base_commit} (sem push). A branch foi mantida; apague-a quando quiser.` };
}

/** Correção na branch atual: não há branch para mesclar. `keep` encerra; `discard` desfaz com commits de revert (nada é reescrito). */
function finishInPlace(root: string, state: FixState, opts: { decision: Decision; confirm?: boolean }): FinishResult {
  if (!state.auto_commit) {
    if (opts.decision === "keep") {
      state.status = "kept";
      saveState(state);
      return { state, decision: "keep", message: `Encerrado. As alterações estão no working tree de ${state.branch}, sem commit: revise (git status, git diff) e commite quando quiser.` };
    }
    throw new FixError(`a skill não commita: as alterações estão só no working tree de ${state.branch}, então não há merge nem commit a desfazer. Para descartar, use git (git restore / git checkout -- <arquivo>, e apague os arquivos novos), com a lista que o fix seal mostrou.`);
  }
  if (opts.decision === "merge") throw new FixError(`as alterações já estão na branch ${state.branch} (commits desta correção): não há merge a fazer. Use keep para encerrar ou discard para desfazer.`);
  if (opts.decision === "keep") {
    state.status = "kept";
    saveState(state);
    return { state, decision: "keep", message: `Mantido: ${state.commits.length} commit(s) da correção seguem na branch ${state.branch}.` };
  }
  if (!opts.confirm) throw new FixError(`desfazer cria commits de revert dos ${state.commits.length} commit(s) desta correção em ${state.branch}; confirme com --confirm`);
  if (currentBranch(root) !== state.branch) throw new FixError(`você não está na branch ${state.branch}. Rode: git switch ${state.branch}`);
  if (!isClean(root)) throw new FixError("há alterações não commitadas; commite ou guarde antes de desfazer");
  const shas = [...state.commits].reverse().map((c) => c.sha);
  if (shas.length) {
    try {
      revertCommits(root, shas);
    } catch (e) {
      if (e instanceof FixError) throw e;
      throw new FixError(`não foi possível reverter (conflito com commits posteriores); nada foi alterado. ${(e as Error).message}`);
    }
  }
  state.status = "discarded";
  saveState(state);
  return { state, decision: "discard", message: `Desfeito: ${shas.length} commit(s) revertido(s) em ${state.branch} (o histórico foi preservado, com commits de revert).` };
}
