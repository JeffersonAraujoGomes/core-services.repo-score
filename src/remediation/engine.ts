import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { analyze, persist, repoSlug, reportsHome, type ReportData } from "../analyze.js";
import { createCtx } from "../collectors/context.js";
import { GROUP_MODULES } from "../groups/index.js";
import { loadPolicy } from "../policy.js";
import { renderReport } from "../report/render.js";
import type { Grade } from "../schema/rubric.js";
import { applyChanges, safeTarget, summarizeChange } from "./apply.js";
import { branchExists, currentBranch, git, GitError, headSha, isClean, isRepo, repoTop, tryGit, uniqueBranchName } from "./git.js";
import type { Action, GuidedTask } from "./types.js";
import { hasCommand } from "../util/proc.js";

export class FixError extends Error {}

export interface ScoreSummary {
  grade: Grade;
  computed_grade: Grade | null;
  total: number | null;
  coverage_weight: number;
  dimensions: Record<string, number | null>;
  criteria: Record<string, number | null>;
  blocked_by: string[];
}

export interface CommitInfo {
  sha: string;
  subject: string;
}

export type FixStatus = "started" | "commit_blocked" | "sealed" | "merged" | "kept" | "discarded" | "nothing_to_do";

export interface FixState {
  version: 1;
  repo: string;
  root: string;
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
    });
  }
  return out;
}

/** Aplica as ações em ordem sobre a branch atual (cada uma planejada sobre o estado já alterado) e commita uma a uma. */
function runActions(root: string, policyPath: string | undefined, actions: Action[], state: FixState, params: Record<string, string>, skipHooks: boolean, now: Date): void {
  const { policy } = loadPolicy(root, policyPath);
  for (const [i, action] of actions.entries()) {
    const ctx = createCtx(root, policy, now);
    const plan = action.plan(ctx, params);
    if (!plan) continue;
    state.notes.push(...plan.notes.map((n) => `${action.id}: ${n}`));
    state.post_steps.push(...plan.postSteps.map((n) => `${action.id}: ${n}`));
    state.guided_tasks.push(...plan.guided.filter((g) => !state.guided_tasks.some((t) => t.id === g.id)));
    if (plan.changes.length === 0) continue;
    for (const c of plan.changes) safeTarget(root, c.path);
    const touched = applyChanges(root, plan.changes);
    try {
      const c = commit(root, touched, `docs(repo-score): ${action.title}\n\nAção ${action.id}; critérios: ${action.criteria.join(", ")}.${skipHooks ? "\n\nHooks pulados com aprovação explícita do usuário (SDD_SKIP=1)." : ""}`, skipHooks);
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
  now?: Date;
}

function commit(root: string, paths: string[] | null, message: string, skipHooks: boolean): CommitInfo | null {
  git(root, paths ? ["add", "-A", "--", ...paths] : ["add", "-A"]);
  if ((tryGit(root, ["diff", "--cached", "--name-only"]) ?? "").trim() === "") return null;
  const args = ["commit", "-q", "-m", message, ...(skipHooks ? ["--no-verify"] : [])];
  git(root, args, skipHooks ? { SDD_SKIP: "1" } : {});
  const sha = git(root, ["rev-parse", "--short", "HEAD"]).trim();
  return { sha, subject: message.split("\n")[0]! };
}

export async function startFix(opts: StartOptions): Promise<FixState> {
  const root = topRoot(opts.root);
  const actions = resolveActions(opts.actionIds);
  if (actions.length === 0) throw new FixError("nenhuma ação selecionada");
  for (const a of actions) {
    for (const r of a.requires) if (r.blocking && !hasCommand(r.tool)) throw new FixError(`${a.id} exige ${r.tool}: ${r.why}`);
  }
  if (!isClean(root) && !opts.allowDirty) {
    throw new FixError("há alterações não commitadas na branch atual. Commite ou guarde (git stash) antes, ou use --allow-dirty (as alterações viajam para a branch nova, misturadas às da correção).");
  }
  const existing = loadState(root);
  if (existing && ["started", "commit_blocked", "sealed"].includes(existing.status) && branchExists(root, existing.branch)) {
    throw new FixError(`já existe uma correção em andamento na branch ${existing.branch} (status ${existing.status}). Conclua com "fix finish" (merge, keep ou discard) antes de iniciar outra.`);
  }

  const now = opts.now ?? new Date();
  const baseBranch = currentBranch(root);
  const baseCommit = headSha(root);
  if (!baseCommit) throw new FixError("o repositório não tem commits");

  // 1. nota de partida, na branch atual (a referência da comparação)
  const base = await analyze({ root, rubricPath: opts.rubricPath, ...(opts.groups ? { groups: opts.groups } : {}), ...(opts.policyPath ? { policyPath: opts.policyPath } : {}), now });
  persist(base.outDir, base.data, renderReport(base.data));

  // 2. branch nova: nada é alterado na branch atual
  const branch = uniqueBranchName(root, opts.branchName ?? `docs/repo-score-${stamp(now)}`);
  git(root, ["switch", "-c", branch]);

  const state: FixState = {
    version: 1,
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
    guided_tasks: [],
    post_steps: [],
    notes: [],
    commits: [],
    baseline: summarize(base.data),
  };

  runActions(root, opts.policyPath, actions, state, opts.params, !!opts.skipHooks, now);
  if (state.status === "commit_blocked") {
    saveState(state);
    return state;
  }

  if (state.commits.length === 0 && state.guided_tasks.length === 0) {
    git(root, baseBranch ? ["switch", baseBranch] : ["switch", "--detach", baseCommit]);
    git(root, ["branch", "-D", branch]);
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
    const c = commit(root, null, `docs(repo-score): ${blockedAction?.title ?? "ajustes"}${opts.skipHooks ? "\n\nHooks pulados com aprovação explícita do usuário (SDD_SKIP=1)." : ""}`, !!opts.skipHooks);
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

  if (!isClean(root)) {
    try {
      const ids = state.guided_tasks.map((t) => t.id).join(", ");
      const c = commit(root, null, `docs(repo-score): ajustes${ids ? ` guiados (${ids})` : ""}`, !!opts.skipHooks);
      if (c) state.commits.push(c);
      delete state.blocked;
      state.status = "started";
    } catch (e) {
      state.status = "commit_blocked";
      state.blocked = { action: state.blocked?.action ?? "guided", output: e instanceof GitError ? e.stderr || e.message : (e as Error).message };
    }
  } else if (state.status === "commit_blocked") {
    delete state.blocked;
    state.status = "started";
  }

  // a nota é recalculada NA BRANCH NOVA (working tree dela), nunca estimada
  const after = await analyze({ root, rubricPath: opts.rubricPath, groups: state.groups, ...(opts.policyPath ? { policyPath: opts.policyPath } : {}), ...(opts.now ? { now: opts.now } : {}) });
  const persisted = persist(after.outDir, after.data, renderReport(after.data));
  state.after = summarize(after.data);
  if (state.status !== "commit_blocked") state.status = "sealed";
  saveState(state);
  const files = tryGit(root, ["diff", "--stat", `${state.base_commit}...HEAD`]) ?? "";
  return { state, data: after.data, files: files.trim(), report: persisted.html };
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
  const back = () => git(root, state.base_branch ? ["switch", state.base_branch] : ["switch", "--detach", state.base_commit]);

  if (opts.decision === "discard") {
    if (!opts.confirm) throw new FixError("descartar apaga a branch e todo o trabalho dela; confirme com --confirm");
    git(root, state.base_branch ? ["switch", "-f", state.base_branch] : ["switch", "-f", "--detach", state.base_commit]);
    git(root, ["branch", "-D", state.branch]);
    state.status = "discarded";
    saveState(state);
    return { state, decision: "discard", message: `Branch ${state.branch} descartada. Você voltou para ${state.base_branch ?? state.base_commit}.` };
  }

  if (!isClean(root)) throw new FixError("a branch da correção tem alterações não commitadas; rode fix seal antes (ou commite)");
  if (state.status === "commit_blocked") throw new FixError("há um commit bloqueado por hook; resolva (fix seal --skip-hooks, se aprovado) antes de concluir");
  back();
  if (opts.decision === "keep") {
    state.status = "kept";
    saveState(state);
    return { state, decision: "keep", message: `Você voltou para ${state.base_branch ?? state.base_commit}; a branch ${state.branch} continua para revisão (git diff ${state.base_branch ?? state.base_commit}...${state.branch}).` };
  }

  try {
    git(root, ["merge", "--no-ff", "-m", `Merge branch '${state.branch}' (repo-score)`, ...(opts.skipHooks ? ["--no-verify"] : []), state.branch], opts.skipHooks ? { SDD_SKIP: "1" } : {});
  } catch (e) {
    tryGit(root, ["merge", "--abort"]);
    throw new FixError(`o merge teve conflito ou foi bloqueado e foi desfeito; a branch ${state.branch} segue intacta. ${(e as Error).message}`);
  }
  state.status = "merged";
  saveState(state);
  return { state, decision: "merge", message: `Branch ${state.branch} mesclada em ${state.base_branch ?? state.base_commit} (sem push). A branch foi mantida; apague-a quando quiser.` };
}
