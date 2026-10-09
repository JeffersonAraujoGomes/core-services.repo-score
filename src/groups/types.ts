import type { Collector, Ctx } from "../collectors/context.js";
import type { Action } from "../remediation/types.js";

export interface PanelItem {
  label: string;
  status: "ok" | "warn" | "fail" | "info";
  detail: string;
}

/** Painel informativo de um grupo no relatório (ex.: "SDD: saúde"). */
export interface Panel {
  group: string;
  title: string;
  items: PanelItem[];
}

/**
 * Um grupo de análise (dimensão da rubrica) com tudo que é específico dele: coletores, ações de
 * correção e painéis. Código de um grupo não importa de outro grupo.
 */
export interface GroupModule {
  /** Id da dimensão na rubrica (ex.: "documentation"). */
  id: string;
  collectors: Collector[];
  actions: Action[];
  panels?(ctx: Ctx): Panel[];
}
