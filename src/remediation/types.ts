import type { Ctx } from "../collectors/context.js";

/** Alteração de arquivo proposta por uma ação. Caminhos são sempre relativos à raiz do repo. */
export type FileChange =
  | { op: "create" | "modify"; path: string; content: string; mode?: "exec"; note?: string }
  | { op: "delete"; path: string; note?: string };

/** Trabalho que o Claude faz na sessão (redigir texto a partir do repo), depois do que o script aplicou. */
export interface GuidedTask {
  id: string;
  title: string;
  /** Instruções completas para o Claude; usam só fatos verificáveis no repo. */
  instructions: string;
  /** Arquivos que a tarefa deve criar ou alterar. */
  targets: string[];
}

export interface ActionPlan {
  changes: FileChange[];
  guided: GuidedTask[];
  /** Avisos e itens que exigem decisão humana (não aplicados). */
  notes: string[];
  /** Passos que não entram na branch (ex.: configuração local do git); sempre pedem confirmação à parte. */
  postSteps: string[];
}

export type Requirement = { tool: "jq" | "claude" | "git"; why: string; blocking: boolean };

export interface ParamSpec {
  key: string;
  label: string;
  default?: string;
  help: string;
}

export interface TokenEstimate {
  low: number;
  high: number;
  basis: string;
}

/**
 * Uma ação de correção de um grupo. `plan` descreve o que mudaria sem escrever nada; devolve null quando
 * não há nada a fazer.
 */
export interface Action {
  id: string;
  group: string;
  title: string;
  summary: string;
  /** Critérios que a ação pretende melhorar (usados na previsão de ganho). */
  criteria: string[];
  /** auto = só script (0 tokens); guided = o Claude redige (gasta tokens); mixed = os dois. */
  kind: "auto" | "guided" | "mixed";
  /**
   * Onde a ação grava (sempre sem commit: o commit é do usuário). `current` (padrão): no working tree da branch atual.
   * `new`: só quando a ação precisa de uma branch dedicada (ex.: o SDD, cujos hooks do repo agem nos commits).
   */
  branch?: "new" | "current";
  requires: Requirement[];
  params?: ParamSpec[];
  plan(ctx: Ctx, params: Record<string, string>): ActionPlan | null;
  estimateTokens?(ctx: Ctx, params: Record<string, string>): TokenEstimate | null;
}
