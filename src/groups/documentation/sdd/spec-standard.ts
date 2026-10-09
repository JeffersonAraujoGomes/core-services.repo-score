import type { Audience } from "./audience.js";

/**
 * Padrão das specs geradas pelo repo-score. É o contrato que a descoberta segue e que o `lint` verifica:
 *  - os 4 blocos existem SEMPRE, na ordem, cada um com informação relevante;
 *  - uma regra por documento, curto; regra complexa vira vários documentos ligados entre si;
 *  - ponteiros para o código (`Arquivo:`) bem definidos: são o pré-requisito do gate do SDD.
 */
export const SPEC_BLOCKS = ["O que a regra faz", "Parâmetros", "Contexto", "Referências técnicas"] as const;

export const SPEC_BUDGET = {
  /** Tamanho que a spec deve mirar. */
  targetLines: 80,
  /** Acima disso a spec deve ser quebrada em versões menores. */
  maxLines: 120,
  /** Arquivos de código por spec de regra (mais que isso, divida o tema). */
  maxPointers: 4,
  /** Linhas de código cobertas por uma spec (mais que isso, divida o arquivo por grupos de métodos). */
  maxCodeLines: 450,
  /** Linhas de código por parte quando um arquivo grande é dividido. */
  splitCodeLines: 300,
  /** Specs por lote de um subagente. */
  specsPerBatch: 6,
} as const;

export interface SpecSkeletonInput {
  id: string;
  title: string;
  parent?: { id: string; title: string; file: string };
  files: string[];
  /** BUS (regra de negócio, linguagem de produto) ou ENG (componente técnico). */
  audience?: Audience;
  /** Orientação específica desta spec (fontes a converter, métodos do recorte etc.). */
  guidance?: string[];
}

/** Esqueleto que acompanha cada tarefa da descoberta: o Claude preenche o que está entre < >. */
export function renderSpecSkeleton(s: SpecSkeletonInput): string {
  const aud = s.audience ?? "BUS";
  const lines = [`# ${s.id} — [${aud}] ${s.title}`, ""];
  if (s.parent) lines.push(`> Parte de: [${s.parent.id} — ${s.parent.title}](./${s.parent.file})`, "");
  lines.push(
    `## ${SPEC_BLOCKS[0]}`,
    "",
    aud === "BUS"
      ? "<2 a 5 frases com o comportamento ATUAL, em linguagem de produto, como numa documentação para o time de negócio: o que acontece com o cliente, o contrato ou a operação, e quando. SEM nomes de classes, métodos, variáveis, campos, interfaces ou arquivos; os termos técnicos vão para Parâmetros e Contexto.>"
      : "<2 a 5 frases com o comportamento técnico ATUAL: o que o componente faz, de onde lê e para onde escreve, em que condições falha ou tenta de novo. Aqui pode citar tipos e métodos.>",
    "",
    `## ${SPEC_BLOCKS[1]}`,
    "",
    "<tabela com limiares, constantes, enums e entradas que mudam o resultado, com o valor atual. Se não há parâmetros, escreva \"Sem parâmetros:\" e diga por quê.>",
    "",
    `## ${SPEC_BLOCKS[2]}`,
    "",
    "<por que a regra existe, ligação com outras specs (links), fragilidades marcadas com ⚠️ Risco e decisões conhecidas. Se não há nada, diga o que foi verificado.>",
    "",
    "---",
    "",
    `## ${SPEC_BLOCKS[3]}`,
    "",
    "> Cada linha começando com `Arquivo:` é lida pelo gate de commit. Caminho relativo à raiz do repo, sem número de linha, uma por linha.",
    "",
    ...s.files.map((f) => `Arquivo: ${f}`),
  );
  return lines.join("\n");
}

export interface LintIssue {
  level: "error" | "warn";
  rule: "blocos" | "bloco-vazio" | "ponteiros" | "tamanho" | "linha-no-ponteiro" | "ponteiro-fora-do-bloco" | "pendencia" | "linguagem" | "marcacao";
  message: string;
}

/** Termos de código que não entram em "O que a regra faz" das specs de negócio (BUS). */
const TECH_WORDS = /\b(classes?|interfaces?|m[eé]todos?|vari[aá]veis?|enums?|dtos?|handlers?|reposit[oó]rios?|repositor(?:y|ies)|booleano|null|nulo|exce[cç][aã]o|ass[ií]ncron[ao]s?|s[ií]ncron[ao]s?|endpoints?|payload|json|sql|worker|thread|construtor|propriedades?|atributos?|namespace|inje[cç][aã]o)\b/gi;
const IDENT = /\b(?:[A-Z][a-z0-9]+){2,}\b|\b[a-z]+(?:[A-Z][a-z0-9]+)+\b|\bI[A-Z][a-z0-9]+(?:[A-Z]\w*)?\b|\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b|\b[A-Za-z]\w*\.(?:cs|ts|js|sql|json|yml|yaml)\b|\b[A-Z]\w+\.[A-Z]\w+\b/g;
const BRAND = new Set(["RabbitMQ", "PostgreSQL", "MongoDB", "JavaScript", "TypeScript", "GitHub", "DataLake", "OpenTelemetry"]);

/** Termos técnicos encontrados num texto de negócio: código entre crases, identificadores e vocabulário de código. */
export function technicalTerms(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`/g)) found.add(m[1]!.trim());
  const plain = text.replace(/`[^`]*`/g, " ");
  for (const m of plain.matchAll(IDENT)) if (!BRAND.has(m[0])) found.add(m[0]);
  for (const m of plain.matchAll(TECH_WORDS)) found.add(m[0].toLowerCase());
  return [...found];
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Verifica uma spec contra o padrão. Determinístico, sem modelo. */
export function lintSpec(text: string, budget = SPEC_BUDGET, opts: { audience?: Audience | null } = {}): LintIssue[] {
  const issues: LintIssue[] = [];
  const lines = text.split(/\r?\n/);
  const h2: { title: string; at: number }[] = [];
  lines.forEach((l, i) => {
    const m = /^##\s+(.+?)\s*$/.exec(l);
    if (m) h2.push({ title: m[1]!, at: i });
  });

  const found = SPEC_BLOCKS.map((b) => h2.findIndex((h) => norm(h.title) === norm(b)));
  SPEC_BLOCKS.forEach((b, i) => {
    if (found[i] === -1) issues.push({ level: "error", rule: "blocos", message: `falta o bloco "## ${b}"` });
  });
  const present = found.filter((x) => x !== -1);
  if (present.length > 1 && present.some((x, i) => i > 0 && x < present[i - 1]!)) {
    issues.push({ level: "error", rule: "blocos", message: "os blocos não estão na ordem do padrão" });
  }

  SPEC_BLOCKS.forEach((b, i) => {
    const idx = found[i]!;
    if (idx === -1) return;
    const start = h2[idx]!.at + 1;
    const end = h2[idx + 1]?.at ?? lines.length;
    // comentários em citação (> …) não contam como conteúdo, exceto ponteiros `Arquivo:` escritos assim
    const body = lines.slice(start, end).filter((l) => l.trim() !== "" && l.trim() !== "---" && (!/^>\s/.test(l.trim()) || /Arquivo:/.test(l)));
    if (body.length === 0) issues.push({ level: "error", rule: "bloco-vazio", message: `o bloco "${b}" está vazio` });
  });

  // spec de negócio (BUS): "O que a regra faz" em linguagem de produto, sem nomes de código
  if (opts.audience === "BUS" && found[0] !== -1) {
    const start = h2[found[0]!]!.at + 1;
    const end = h2[found[0]! + 1]?.at ?? lines.length;
    const terms = technicalTerms(lines.slice(start, end).join("\n"));
    if (terms.length) {
      issues.push({ level: "warn", rule: "linguagem", message: `"O que a regra faz" deve usar linguagem de produto (sem classes, métodos, variáveis ou campos); encontrei: ${terms.slice(0, 6).join(", ")}${terms.length > 6 ? `, +${terms.length - 6}` : ""}. Mova os termos técnicos para Parâmetros ou Contexto` });
    }
  }

  const refIdx = found[3]!;
  const refStart = refIdx === -1 ? lines.length : h2[refIdx]!.at;
  // o gate lê `Arquivo: caminho` em qualquer posição da linha; o padrão pede início de linha
  const pointers = lines.map((l, i) => ({ l, i })).filter(({ l }) => /Arquivo:\s+`?[^\s`]/.test(l));
  if (refIdx !== -1 && pointers.length === 0) issues.push({ level: "error", rule: "ponteiros", message: "o bloco de referências não tem nenhuma linha `Arquivo:` (pré-requisito do SDD)" });
  for (const { l, i } of pointers) {
    if (!/^\s*Arquivo:/.test(l)) issues.push({ level: "warn", rule: "ponteiros", message: `ponteiro na linha ${i + 1} não está no início da linha (o padrão é \`Arquivo: caminho\` sozinho)` });
    if (i < refStart) issues.push({ level: "warn", rule: "ponteiro-fora-do-bloco", message: `\`Arquivo:\` na linha ${i + 1} está fora de "Referências técnicas"` });
    if (/Arquivo:\s+`?\S+?(:\d+|#L\d+)\b/.test(l) || /\blinha\s*~?\d+/i.test(l)) {
      issues.push({ level: "error", rule: "linha-no-ponteiro", message: `ponteiro com número de linha (linha ${i + 1}): o padrão é nível de arquivo` });
    }
  }
  if (pointers.length > budget.maxPointers + 2) issues.push({ level: "warn", rule: "ponteiros", message: `${pointers.length} ponteiros: a spec cobre código demais, divida o tema` });

  const size = lines.filter((l) => l.trim() !== "").length;
  if (size > budget.maxLines) issues.push({ level: "error", rule: "tamanho", message: `${size} linhas (máximo ${budget.maxLines}): quebre em specs menores ligadas entre si` });
  else if (size > budget.targetLines + 20) issues.push({ level: "warn", rule: "tamanho", message: `${size} linhas (alvo ${budget.targetLines})` });

  if (/\b(TODO|TBD)\b/.test(text)) issues.push({ level: "error", rule: "pendencia", message: "contém marcador TODO/TBD" });
  return issues;
}

/** Resumo do padrão que vai DENTRO de cada briefing (o subagente não lê arquivos da skill). Mantido em sincronia com references/spec-standard.md. */
export const STANDARD_BRIEF = [
  "- Cada spec tem os 4 blocos, SEMPRE, nesta ordem: `## O que a regra faz`, `## Parâmetros`, `## Contexto`, `## Referências técnicas`. Nenhum é omitido; sem nada a dizer, o bloco diz o que foi verificado.",
  `- Uma regra por documento, curto: alvo de ${SPEC_BUDGET.targetLines} linhas e MÁXIMO de ${SPEC_BUDGET.maxLines}. Regra complexa vira várias specs ligadas ("> Parte de: [NN — Tema](./arquivo.md)").`,
  "- Ponteiros no bloco de referências: uma linha `Arquivo: caminho` por arquivo de código, relativa à raiz do repo, de um arquivo que EXISTE, nível de arquivo, SEM número de linha. Só nesse bloco.",
  "- As specs descrevem o comportamento ATUAL (as-is), não o ideal; marque fragilidades com `⚠️ Risco`. Português (BR); identificadores de código no idioma original.",
  "- Cada spec é `[BUS]` (regra de negócio) ou `[ENG]` (componente técnico), marcado no nome do arquivo (`NN.k-BUS-tema.md`, `NN.k-ENG-tema.md`) e no título (`# NN.k — [BUS] Título`). A marcação vem pronta no nome e no esqueleto; não renomeie o arquivo.",
  "- **[BUS]: `## O que a regra faz` em linguagem de produto**, como numa documentação para o time de negócio e produto: descreva o que acontece com o cliente, o contrato ou a operação e em que condições. NÃO cite nomes de classes, métodos, variáveis, campos, interfaces, enums nem arquivos nesse bloco (nada entre crases); termos técnicos entram em `## Parâmetros` (nome de negócio primeiro, nome técnico entre parênteses) e em `## Contexto`. O título do `#` pode ser reescrito em linguagem de negócio; o nome do arquivo não muda.",
  "- **[ENG]**: linguagem de engenharia, direta; pode citar tipos, métodos e filas. Se o conteúdo mostrar que a marcação do nome está errada, escreva a spec mesmo assim e avise na resposta qual deveria trocar.",
  "- Proibido: TODO/TBD, segredos, credenciais e dados pessoais, inventar comportamento que você não leu no código ou no documento-fonte.",
].join("\n");
