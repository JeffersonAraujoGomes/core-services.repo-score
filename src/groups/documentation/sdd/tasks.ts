import type { Ctx } from "../../../collectors/context.js";
import type { GuidedTask, TokenEstimate } from "../../../remediation/types.js";
import type { SddManifest } from "../shared/manifest.js";
import type { SpecLintResult } from "./discovery/lint.js";
import type { PlannedSpec, SpecPlan } from "./discovery/plan.js";
import { forecastTokens, TOKEN_MODEL } from "./discovery/tokens.js";
import { AUDIENCE_LABEL } from "./audience.js";
import { renderSpecSkeleton, SPEC_BUDGET, STANDARD_BRIEF } from "./spec-standard.js";

const chunk = <T,>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
const fence = (s: string) => "```markdown\n" + s + "\n```";

function specBrief(spec: PlannedSpec, plan: SpecPlan, n: number): string {
  const parent = spec.parent ? plan.specs.find((s) => s.id === spec.parent) : undefined;
  const children = plan.specs.filter((s) => s.parent === spec.id);
  const L = [`### ${n}. \`${plan.specsDir}/${spec.file}\` (${spec.kind}) · **[${spec.audience}] ${AUDIENCE_LABEL[spec.audience]}**`, `Título: ${spec.title}${spec.audience === "BUS" ? " (reescreva em linguagem de negócio, sem nomes de código; o nome do arquivo não muda)" : ""}`];
  if (parent) L.push(`Spec-mãe: ${parent.id} — ${parent.title} (\`${parent.file}\`)`);
  if (spec.subtopic) L.push(`Recorte desta spec: ${spec.subtopic}. Documente SÓ esse recorte; o resto é de outra spec.`);
  L.push("Arquivos de código (viram os ponteiros `Arquivo:`):", ...spec.pointers.map((p) => `- \`${p}\``));
  if (spec.sourceDocs.length) L.push("Documentos existentes a CONVERTER (a regra já está descrita ali; confirme no código e reescreva no padrão):", ...spec.sourceDocs.map((d) => `- \`${d}\``));
  if (spec.kind === "orquestracao") {
    L.push(`Esta é a visão do fluxo do app: curta, sem duplicar as sub-specs. No bloco Contexto liste as sub-specs com link: ${children.map((c) => `\`${c.file}\``).join(", ") || "(nenhuma)"}.`);
  }
  for (const note of spec.notes.filter((x) => x.startsWith("nenhum"))) L.push(`⚠️ ${note}`);
  L.push("Esqueleto (preencha o que está entre < >):", fence(renderSpecSkeleton({ id: spec.id, title: spec.title, ...(parent ? { parent: { id: parent.id, title: parent.title, file: parent.file } } : {}), files: spec.pointers, audience: spec.audience })));
  return L.join("\n");
}

const COMMON_RULES = (specsDir: string) =>
  [
    "## Como trabalhar",
    "",
    "1. Leia por completo cada arquivo de código listado (e só o necessário ao redor) e os documentos-fonte; descreva o que o código FAZ hoje.",
    `2. Escreva SOMENTE os arquivos deste lote, em \`${specsDir}/\`. Não altere código, testes, o índice (\`README.md\`) nem outras specs.`,
    "3. Antes de terminar, confira você mesmo: os 4 blocos presentes e na ordem; no máximo " + SPEC_BUDGET.maxLines + " linhas por arquivo; cada `Arquivo:` aponta para um arquivo que existe (use `ls`); nenhum número de linha; sem TODO/TBD; nas specs [BUS], o bloco \"O que a regra faz\" sem nenhum nome de classe, método, variável, campo ou arquivo (e nada entre crases).",
    "4. Se uma spec ficar acima do limite, divida em duas specs ligadas e avise na resposta (o orquestrador ajusta o índice).",
    "5. Responda com a lista dos arquivos criados e, para cada um, o número de linhas e qualquer ponteiro que não conseguiu confirmar.",
  ].join("\n");

/** Tarefas guiadas da adoção do zero: lotes de specs (paralelizáveis), depois visão geral + índice, depois a skill. */
export function adoptionTasks(manifest: SddManifest, plan: SpecPlan): GuidedTask[] {
  const writable = plan.specs.filter((s) => s.kind !== "visao-geral" && s.kind !== "glossario");
  const batches = chunk(writable, SPEC_BUDGET.specsPerBatch);
  const header = (n: number, total: number) => `Lote ${n} de ${total}: escrever ${batches[n - 1]!.length} specs de SDD de ${manifest.projectName || "este repositório"}, em português (BR), em \`${plan.specsDir}/\`.`;

  const tasks: GuidedTask[] = batches.map((specs, i) => ({
    id: `sdd-specs:${i + 1}`,
    title: `Specs, lote ${i + 1} de ${batches.length}: ${specs.map((s) => s.id).join(", ")}`,
    targets: specs.map((s) => `${plan.specsDir}/${s.file}`),
    instructions: [header(i + 1, batches.length), "", "## Padrão (obrigatório)", "", STANDARD_BRIEF, "", "## Specs deste lote", "", ...specs.map((s, k) => specBrief(s, plan, k + 1) + "\n"), COMMON_RULES(plan.specsDir)].join("\n"),
  }));

  const head = plan.specs.filter((s) => s.kind === "visao-geral" || s.kind === "glossario");
  const all = plan.specs.map((s) => `- ${s.id} — [${s.audience}] ${s.title} (\`${s.file}\`)`);
  tasks.push({
    id: "sdd-overview",
    title: `Visão geral, glossário e índice (${head.length + 1} arquivos)`,
    targets: [...head.map((s) => `${plan.specsDir}/${s.file}`), `${plan.specsDir}/README.md`],
    instructions: [
      `Depois que TODOS os lotes terminarem, escreva em \`${plan.specsDir}/\`: ${head.map((s) => `\`${s.file}\``).join(", ")} e o índice \`README.md\` (substitui o rascunho existente).`,
      "",
      "## Padrão (obrigatório para a visão geral e o glossário)",
      "",
      STANDARD_BRIEF,
      "",
      ...head.map((s, k) => specBrief(s, plan, k + 1) + "\n"),
      "## Índice (`README.md`)",
      "",
      "Duas tabelas `| # | Documento | Tópico |`: primeiro **Regras de negócio [BUS]** (as specs BUS, para o time de negócio e produto), depois **Componentes técnicos [ENG]**. UMA linha por spec abaixo, na ordem, com link `[Título](./arquivo.md)` e um tópico de uma frase tirado do bloco \"O que a regra faz\" de cada spec já escrita (em linguagem de negócio nas BUS). A tabela BUS deve ser legível por quem não programa. Depois da tabela, a seção \"Como ler / manter\": ciclo SDD (spec → código → testes → conflitos) e a convenção `Arquivo: caminho` (nível de arquivo, sem linha).",
      ...all,
      "",
      "Confira que todo link do índice aponta para um arquivo que existe e que nenhuma spec ficou fora dele.",
    ].join("\n"),
  });
  return tasks;
}

/** Tarefas de migração: reescrever specs legadas para o padrão, em lotes, preservando o conteúdo. */
export function migrationTasks(manifest: SddManifest, results: SpecLintResult[]): GuidedTask[] {
  const legacy = results.filter((r) => r.issues.length > 0).sort((a, b) => b.lines - a.lines);
  return chunk(legacy, SPEC_BUDGET.specsPerBatch).map((batch, i, all) => ({
    id: `sdd-migrate:${i + 1}`,
    title: `Migrar specs para o padrão, lote ${i + 1} de ${all.length} (${batch.length} specs)`,
    targets: [`${manifest.specsDir}/`],
    instructions: [
      `Migrar ${batch.length} specs legadas de ${manifest.projectName || "este repositório"} para o padrão, em \`${manifest.specsDir}/\`. Lote ${i + 1} de ${all.length}.`,
      "",
      "## Padrão (obrigatório)",
      "",
      STANDARD_BRIEF,
      "",
      "## Specs deste lote (o que o verificador apontou)",
      "",
      ...batch.map((r) => [`### \`${r.path}\` (${r.lines} linhas)`, ...r.issues.map((x) => `- ${x.level === "error" ? "erro" : "aviso"}: ${x.message}`), r.lines > SPEC_BUDGET.maxLines ? `- Acima do limite: o arquivo original vira a spec de orquestração curta, com links, e o conteúdo detalhado passa para sub-specs \`NN.k-tema.md\` (cada uma até ${SPEC_BUDGET.maxLines} linhas, com "Parte de" apontando para a original).` : "", ""].filter(Boolean).join("\n")),
      "## Como trabalhar",
      "",
      "1. Leia a spec por completo e reescreva no padrão SEM perder regra, valor, tabela, risco (`⚠️ Risco`) nem citação: o que não cabe em um bloco vai para o bloco certo (parâmetros → Parâmetros; motivo e interações → Contexto).",
      "2. Todas as citações `Arquivo:` vão para o bloco \"Referências técnicas\", uma por linha, no início da linha, sem número de linha. Confira com `ls` que cada caminho existe; se um não existe, corrija para o arquivo atual ou registre no Contexto que foi removido.",
      "3. Mantenha a numeração e os links que outras specs usam. **Marcação no nome:** se o arquivo não tem `-BUS-` ou `-ENG-` depois do número (`03.25-BUS-tema.md`), renomeie com `git mv` (BUS = regra de negócio; ENG = componente técnico: leitura de arquivos, consultas, workers, integrações), ponha `[BUS]`/`[ENG]` no título (`# 03.25 — [BUS] Título`) e atualize TODOS os links para o arquivo em `" + manifest.specsDir + "/` (inclusive o índice). Se criar sub-specs, liste-as na spec original (Contexto) e informe os novos arquivos para o índice.",
      "   **Linguagem [BUS]:** `## O que a regra faz` em linguagem de produto, sem nomes de classes, métodos, variáveis, campos ou arquivos (nada entre crases); o aviso `linguagem` do verificador lista os termos a tirar. O detalhe técnico vai para Parâmetros e Contexto, sem perder nada.",
      "4. Descreva o comportamento ATUAL; não invente regra nova. Sem TODO/TBD.",
      "5. Altere somente as specs deste lote (e as sub-specs que criar). Responda com os arquivos alterados/criados, linhas de cada um e pendências.",
    ].join("\n"),
  }));
}

export function estimateAdoption(plan: SpecPlan): TokenEstimate {
  const f = forecastTokens(plan);
  return { low: f.low, high: f.high, basis: `${plan.specs.length} specs em ${f.batches} lote(s); ${f.basis}` };
}

/** Migrar é reescrever texto que já existe: lê a spec (pouco) e escreve de volta (muito), mais a partida fria de cada lote. */
export function estimateMigration(ctx: Ctx, results: SpecLintResult[]): TokenEstimate {
  const legacy = results.filter((r) => r.issues.length > 0);
  const batches = Math.max(1, Math.ceil(legacy.length / SPEC_BUDGET.specsPerBatch));
  const body = legacy.reduce((n, r) => {
    const chars = ctx.readText(r.path)?.length ?? 0;
    const parts = Math.max(1, Math.ceil(r.lines / SPEC_BUDGET.targetLines));
    return n + (chars / 3.5) * 1.3 + (chars / 3.5) * 1.1 + parts * 600;
  }, 0);
  const mid = body + batches * TOKEN_MODEL.coldStartPerBatch * 0.6 + TOKEN_MODEL.verification;
  return { low: Math.round((mid * TOKEN_MODEL.rangeLow) / 1000) * 1000, high: Math.round((mid * TOKEN_MODEL.rangeHigh) / 1000) * 1000, basis: `${legacy.length} specs fora do padrão em ${batches} lote(s)` };
}
