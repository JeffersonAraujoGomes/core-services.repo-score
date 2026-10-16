/**
 * Regra de caminhos que TODO briefing guiado carrega. Caminho abreviado ou solto num README, na skill ou numa spec
 * derruba o D4 (referências de caminho válidas) e só era descoberto pela nota, depois do `fix seal`.
 */
export const PATH_RULES_TITLE = "Caminhos (regra obrigatória)";

export const PATH_RULES = [
  "- Todo caminho que você escrever (em crase, em link `[x](caminho)` ou em linha `Arquivo: caminho`) deve ser **completo, relativo à raiz do repo e de um arquivo que EXISTE**. Confira com `ls` ou `git ls-files` antes de escrever; nunca de memória.",
  "- Sem abreviar: nada de só o nome do arquivo, só a pasta final ou parte do caminho (`Worker/Receivers/X.cs`, `Migrations`, `template.md`). Escreva `apps/<app>/.../X.cs` inteiro.",
  "- O que NÃO existe no repo (pasta que será criada, arquivo de exemplo, nome-modelo como `NNNN-titulo.md`, comando) entra como **texto simples**, sem crase e sem link, ou dentro de um bloco de código cercado.",
  "- Ao terminar, releia o que escreveu e confira cada caminho com `ls`. Depois, o orquestrador roda um verificador (`check refs`) nos seus arquivos e devolve o que sobrar para você corrigir.",
].join("\n");

/** Bloco pronto para embutir em um briefing (título + regras). */
export const PATH_RULES_BLOCK = `## ${PATH_RULES_TITLE}\n\n${PATH_RULES}`;
