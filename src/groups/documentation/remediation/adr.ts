import type { Ctx } from "../../../collectors/context.js";
import { upsert } from "../../../remediation/changes.js";
import type { ActionPlan, FileChange } from "../../../remediation/types.js";
import { adrFiles } from "../collectors/d3-adrs.js";

const TEMPLATE = `# NNNN. Título da decisão

- Status: Proposto | Aceito | Substituído por NNNN
- Data: AAAA-MM-DD

## Contexto

Qual problema ou força motivou a decisão, e quais restrições existem.

## Decisão

O que foi decidido, em uma ou duas frases diretas.

## Consequências

O que muda, o que fica mais fácil, o que fica mais difícil e o que precisa ser acompanhado.
`;

function firstAdr(date: string): string {
  return `# 0001. Registrar decisões de arquitetura em ADRs

- Status: Proposto
- Data: ${date}

## Contexto

Decisões de arquitetura e de processo deste repositório se perdem em conversas e em histórico de PRs. Quem chega depois não sabe por que as coisas são como são.

## Decisão

Cada decisão relevante passa a ser registrada como um ADR (Architecture Decision Record) curto, versionado em \`docs/adr/\`, usando o modelo de \`template.md\`. Um ADR nunca é apagado: quando a decisão muda, um novo ADR a substitui e o antigo recebe o status "Substituído por".

## Consequências

- O motivo de cada decisão fica próximo do código e passa por revisão como qualquer mudança.
- Registrar custa alguns minutos por decisão; o ganho está em onboarding e em evitar rediscutir o que já foi decidido.
- Este ADR está como Proposto: o time o aceita (ou ajusta) ao mesclar a branch.
`;
}

export function planAdr(ctx: Ctx): ActionPlan | null {
  if (adrFiles(ctx.files, ctx.policy.docs.adr_dirs).length > 0) return null;
  const root = ctx.policy.docs.roots.find((r) => ctx.files.some((f) => f.startsWith(`${r}/`))) ?? "docs";
  const dir = `${root}/adr`;
  const date = ctx.now.toISOString().slice(0, 10);
  const changes = [
    upsert(ctx, `${dir}/template.md`, TEMPLATE),
    upsert(ctx, `${dir}/0001-registrar-decisoes-de-arquitetura.md`, firstAdr(date)),
    upsert(ctx, `${dir}/README.md`, `# Decisões de arquitetura (ADRs)\n\n- [Modelo de ADR](template.md)\n- [0001. Registrar decisões de arquitetura em ADRs](0001-registrar-decisoes-de-arquitetura.md)\n`),
  ].filter((c): c is FileChange => c !== null);
  return changes.length ? { changes, guided: [], notes: ["O ADR 0001 nasce como Proposto: o time o aceita ao mesclar."], postSteps: [] } : null;
}
