import path from "node:path";

/**
 * Público de uma spec: BUS = regra de negócio (linguagem de produto, para o time inteiro); ENG = componente técnico
 * (leitura de arquivos, consultas, workers, integrações: linguagem de engenharia). A marcação vai no NOME do arquivo
 * (`03.25-BUS-loss-cure-rule.md`) e no título (`# 03.25 — [BUS] …`). Colchetes ficam só no título: em nome de arquivo
 * eles são curingas de glob e quebram pathspec do git, .gitignore e os globs do manifest.
 */
export type Audience = "BUS" | "ENG";

export const AUDIENCE_LABEL: Record<Audience, string> = { BUS: "regra de negócio", ENG: "componente técnico" };

/** `03.25-BUS-loss-cure-rule.md` → "BUS"; sem marcação → null. */
export function audienceFromName(file: string): Audience | null {
  const m = /^\d+(?:\.\d+)*-(BUS|ENG)-/.exec(path.posix.basename(file));
  return m ? (m[1] as Audience) : null;
}

/** Palavras do nome do arquivo que indicam peça técnica (acesso a dados, mensageria, orquestração de infra). */
const ENG_TOKENS = new Set([
  "reader", "writer", "repository", "repositories", "queries", "query", "sql", "worker", "workers", "consumer", "receiver", "publisher", "producer",
  "send", "tracker", "factory", "mapper", "extensions", "helper", "helpers", "bucket", "storage", "acl", "kafka", "rabbit", "queue", "cache",
  "gateway", "adapter", "http", "grpc", "middleware", "scheduler", "job", "provider", "connection", "client", "api", "bootstrap", "retry",
]);
/** Pastas/projetos de infraestrutura. */
const ENG_PATH = /(^|[/.])(Infra|Infrastructure|Worker|Workers|Repositories|Queries|Consumers|Receivers|Storage|Acl|Messaging|Persistence)([/.]|$)/i;
/** "Client" e "Api" são palavras de negócio em nomes como CreditClientRisk…: só contam como técnicas quando fecham o nome. */
const TAIL_ONLY = new Set(["client", "api"]);

function tokens(stem: string): string[] {
  return stem.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Natureza de UM arquivo de código, pelo nome e pelo caminho (determinístico, sem modelo). */
export function audienceOfFile(rel: string): Audience {
  const stem = path.posix.basename(rel).replace(/\.[^.]+$/, "");
  const toks = tokens(stem);
  const eng = toks.some((t, i) => ENG_TOKENS.has(t) && (!TAIL_ONLY.has(t) || i === toks.length - 1));
  return eng || ENG_PATH.test(rel) ? "ENG" : "BUS";
}

/** Natureza de uma spec: a da maioria dos arquivos que ela cobre (empate = negócio). Sem arquivos: negócio. */
export function audienceOfFiles(files: string[]): Audience {
  if (files.length === 0) return "BUS";
  const eng = files.filter((f) => audienceOfFile(f) === "ENG").length;
  return eng > files.length / 2 ? "ENG" : "BUS";
}
