#!/usr/bin/env bash
# post-commit: se o commit que acabou de ser criado tocou <specsDir>/**.md,
# gera o plano de impacto via Claude Code (headless) EM BACKGROUND — o commit
# nao espera; o relatorio aparece em <specsDir>/.impact-reports/ ao terminar.
#
# Gerado por sdd-bootstrap. Parametrizado via .sdd/manifest.json.
#
# Se o CLI 'claude' nao estiver disponivel (ex.: commit feito por IDE/GUI, que
# nao herda o PATH do shell, ou CLI nao instalado), grava um arquivo
# PENDING-*.md no mesmo diretorio — garante que SEMPRE exista um artefato
# visivel da interceptacao.
#
# Escreve o relatorio em <nome>.md.inprogress e so promove (mv atomico) para
# <nome>.md quando o 'claude -p' termina — 'claude -p' nao faz streaming
# (escreve tudo no final), entao o nome final nunca aparece com 0 bytes.
#
# Ativacao (uma vez por dev): git config core.hooksPath .githooks
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

manifest=".sdd/manifest.json"
[[ ! -f "$manifest" ]] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

specs_dir="$(jq -r '.specsDir' "$manifest")"
skill_slug="$(jq -r '.skillSlug' "$manifest")"
skill_path="$(jq -r '.skillPath' "$manifest")"

changed_specs="$(git diff-tree --no-commit-id --name-only -r HEAD -- "${specs_dir}/*.md" 2>/dev/null || true)"
[[ -z "$changed_specs" ]] && exit 0

report_dir="${specs_dir}/.impact-reports"

# Dedupe: se o gate do pre-commit acabou de aprovar via sdd-analyze, o plano ja existe.
if find "$report_dir" -name '.approved-*' -mmin -60 2>/dev/null | grep -q .; then
  echo "[spec-change-guard] plano ja gerado/aprovado via sdd-analyze — sem nova analise em background." >&2
  exit 0
fi

find_claude() {
  command -v claude 2>/dev/null && return 0
  local c
  for c in "$HOME/.claude/local/claude" "$HOME/.local/bin/claude" \
           /opt/homebrew/bin/claude /usr/local/bin/claude; do
    [[ -x "$c" ]] && { echo "$c"; return 0; }
  done
  return 1
}

mkdir -p "$report_dir"
sha="$(git rev-parse --short HEAD)"
stamp="$(date +%Y%m%d-%H%M%S)"

claude_bin="$(find_claude || true)"

if [[ -z "$claude_bin" ]]; then
  pending_file="${report_dir}/PENDING-commit-${sha}.md"
  {
    echo "# Análise SDD pendente — commit ${sha}"
    echo
    echo "O commit \`${sha}\` alterou as specs abaixo, mas o CLI \`claude\` não foi"
    echo "encontrado neste ambiente (commit via IDE/GUI, ou CLI não instalado), então o"
    echo "plano de impacto automático não pôde ser gerado."
    echo
    echo "## Specs alteradas"
    echo
    echo "$changed_specs" | sed 's/^/- /'
    echo
    echo "## Como gerar o plano manualmente"
    echo
    echo "Abra uma sessão do Claude Code neste repositório e peça:"
    echo
    echo "> Analise o impacto das specs alteradas no commit ${sha} seguindo a skill"
    echo "> ${skill_slug} (git show ${sha} para o diff)."
    echo
    echo "Para habilitar a geração automática, instale o CLI:"
    echo '`curl -fsSL https://claude.ai/install.sh | bash` (ou `npm install -g @anthropic-ai/claude-code`).'
  } > "$pending_file"
  echo "[spec-change-guard] 'claude' indisponivel — analise pendente registrada em: ${pending_file}" >&2
  exit 0
fi

report_file="${report_dir}/commit-${sha}-${stamp}.md"
tmp_file="${report_file}.inprogress"

prompt="Siga a skill ${skill_slug} (${skill_path}). As specs a seguir mudaram no commit ${sha}: ${changed_specs}. Rode git show ${sha} -- em cada uma para ver o diff, mapeie os arquivos de codigo impactados, monte o Plano de Alteracoes (arquivos impactados, alteracao de codigo proposta, casos de teste obrigatorios, checklist de conflitos entre regras) e escreva SOMENTE o plano em markdown, sem alterar nenhum arquivo de codigo ou teste."

echo "[spec-change-guard] specs alteradas no commit ${sha} — gerando plano de impacto em background..." >&2
echo "[spec-change-guard] resultado em: ${report_file} (aparece só quando pronto — não fica com 0 bytes)" >&2

nohup bash -c '
  if "$1" -p "$2" > "$3" 2>/dev/null; then
    mv -f "$3" "$4"
  else
    rm -f "$3"
  fi
' _ "$claude_bin" "$prompt" "$tmp_file" "$report_file" >/dev/null 2>&1 &
disown 2>/dev/null || true

exit 0
