import { z } from "zod";

export const ReadmeSectionSchema = z.object({
  id: z.string().min(1),
  /** Nome exibido nos relatórios e nas instruções de correção. */
  label: z.string().min(1),
  /** Expressões regulares (sem barras, sem flags; casam sem diferenciar maiúsculas) para os títulos aceitos. */
  match: z.array(z.string().min(1)).min(1),
});
export type ReadmeSection = z.infer<typeof ReadmeSectionSchema>;

/**
 * Seções obrigatórias do README de cada app (D1). Padrão proposto; para mudar a lista oficial,
 * defina `docs.readme_required_sections` na política do repo (substitui esta lista inteira).
 */
export const DEFAULT_README_SECTIONS: ReadmeSection[] = [
  { id: "overview", label: "Descrição / visão geral", match: ["descri", "vis[aã]o geral", "sobre", "overview", "introdu", "about", "objetivo", "prop[oó]sito"] },
  { id: "run", label: "Como executar", match: ["execu", "rodar", "rodando", "running", "getting started", "come[cç]ando", "usage", "\\buso\\b", "instala", "install"] },
  { id: "config", label: "Configuração", match: ["config", "vari[aá]veis", "environment", "ambiente", "settings"] },
  { id: "tests", label: "Testes", match: ["\\btest", "teste"] },
  { id: "deploy", label: "Deploy", match: ["deploy", "implanta", "publica", "release", "ci/cd", "pipeline"] },
  { id: "owners", label: "Responsáveis", match: ["respons", "mantenedor", "owner", "contato", "contact", "squad", "maintainer"] },
];

const validRegex = (src: string) => {
  try {
    new RegExp(src, "i");
    return true;
  } catch {
    return false;
  }
};

export const DocsPolicySchema = z.object({
  /** Diretórios dos apps (relativos à raiz). Omitido: apps.yml, pastas de apps/ com Dockerfile ou o repo inteiro. */
  apps: z.array(z.string().min(1)).optional(),
  /** Pastas de documentação consideradas "docs" para o índice (D5). */
  roots: z.array(z.string().min(1)).default(["docs", "doc", "documentation"]),
  readme_required_sections: z.array(ReadmeSectionSchema).default(DEFAULT_README_SECTIONS),
  /** Globs (estilo gitignore) de docs a ignorar nas métricas. */
  ignore_globs: z.array(z.string().min(1)).default([]),
  /** Regex (sem flags) de caminhos que contam como resíduo em D8, além dos padrões embutidos. */
  residual_patterns: z.array(z.string().min(1)).default([]).refine((l) => l.every(validRegex), "regex inválida em residual_patterns"),
  /** Pastas extras de ADR (D3). */
  adr_dirs: z.array(z.string().min(1)).default([]),
  /** Globs (pathspec) do código de regra de negócio (D7), somados ao ruleCodeGlobs do .sdd/manifest.json. */
  rule_globs: z.array(z.string().min(1)).default([]),
  /** Pathspecs de arquivos revisados e que NÃO são regra de negócio (plumbing, infra): saem do universo do D7. */
  rule_exclude_globs: z.array(z.string().min(1)).default([]),
});
export type DocsPolicy = z.infer<typeof DocsPolicySchema>;
