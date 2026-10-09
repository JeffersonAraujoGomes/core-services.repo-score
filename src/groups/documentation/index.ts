import type { GroupModule } from "../types.js";
import { d1Readme } from "./collectors/d1-readme.js";
import { d2Owners } from "./collectors/d2-owners.js";
import { d3Adrs } from "./collectors/d3-adrs.js";
import { d4PathRefs } from "./collectors/d4-path-refs.js";
import { d5Index, d6Orphans } from "./collectors/d5-d6-index.js";
import { d7SpecsRules } from "./collectors/d7-specs-rules.js";
import { d8Hygiene } from "./collectors/d8-hygiene.js";
import { documentationPanels } from "./panels.js";
import { DOCUMENTATION_ACTIONS } from "./remediation/actions.js";

/**
 * Grupo Documentação (dimensão 5.6, D1–D9). Tudo que é específico dele fica nesta pasta:
 * coletores, política, ações de correção (inclui o SDD) e painéis. D9 (diagrama) ainda não tem coletor.
 */
export const documentation: GroupModule = {
  id: "documentation",
  collectors: [d1Readme, d2Owners, d3Adrs, d4PathRefs, d5Index, d6Orphans, d7SpecsRules, d8Hygiene],
  actions: DOCUMENTATION_ACTIONS,
  panels: documentationPanels,
};
