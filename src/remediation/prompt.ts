import type { FixSuggestion } from "./suggest.js";

/** Aspas para o caminho dentro do comando; o relatório mostra o texto exato que o dev cola na sessão. */
const quote = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

/**
 * Prompt do botão "Otimizar nota": o dev cola na sessão do Claude e a skill executa SÓ essa ação, na branch nova.
 * A primeira linha aciona a skill; o resto repete o escopo em texto para funcionar mesmo se os argumentos não forem lidos.
 */
export function optimizePrompt(root: string, fix: Pick<FixSuggestion, "id" | "group" | "title" | "criteria" | "kind" | "branch">): string {
  const lines = [
    `/repo-score otimizar ${fix.id} ${quote(root)}`,
    "",
    `Otimizar a nota do repositório ${root}.`,
    `Ação: ${fix.id} — ${fix.title}`,
    `Grupo: ${fix.group}${fix.criteria.length ? ` · critérios: ${fix.criteria.join(", ")}` : ""}`,
    "",
    "Escopo: trate somente esta ação; não faça outras correções nem altere o critério ou a rubrica.",
    fix.branch === "new"
      ? "Siga o fluxo da skill: previsão de tokens e minha confirmação antes de gastar; esta ação usa uma BRANCH NOVA (nunca a branch atual), informando o nome na tela, e se já houver uma sessão de correção aberta neste repo, use a MESMA branch dela em vez de criar outra; NÃO faça commit: só crie, altere e remova arquivos, o commit é meu; recalcule a nota e liste os arquivos."
      : "Siga o fluxo da skill: previsão de tokens e minha confirmação antes de gastar; aplique na BRANCH ATUAL (informe qual é antes de aplicar), sem criar branch nova, a menos que já exista uma sessão de correção aberta neste repo (aí use a branch dela); NÃO faça commit: só crie, altere e remova arquivos, o commit é meu; recalcule a nota e liste os arquivos.",
  ];
  if (fix.kind === "auto") lines.push("Esta ação é automática (0 tokens).");
  return lines.join("\n");
}
