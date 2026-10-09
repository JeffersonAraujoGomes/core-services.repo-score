#!/usr/bin/env bash
# pre-push: verifica <specsDir>/**.md e codigo de regras (ruleCodeGlobs) nos
# commits sendo empurrados. Nao bloqueia o push (escopo: analise + plano/aviso,
# sem auto-refatoracao).
#
# Gerado por sdd-bootstrap. Parametrizado via .sdd/manifest.json.
#
# Ativacao (uma vez por dev):
#   git config core.hooksPath .githooks
set -euo pipefail

remote="$1"
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

manifest=".sdd/manifest.json"
[[ ! -f "$manifest" ]] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

specs_dir="$(jq -r '.specsDir' "$manifest")"
skill_slug="$(jq -r '.skillSlug' "$manifest")"
skill_path="$(jq -r '.skillPath' "$manifest")"
# Nao usa 'mapfile' (bash 4+) — o bash padrao do macOS e 3.2 (licenciamento
# da Apple) e nao tem esse builtin.
rule_globs=()
while IFS= read -r glob_line; do
  [[ -n "$glob_line" ]] && rule_globs+=("$glob_line")
done < <(jq -r '.ruleCodeGlobs[]?' "$manifest")

changed_specs=""
changed_rule_code=""
while read -r local_ref local_sha remote_ref remote_sha; do
  [[ "$local_sha" == "0000000000000000000000000000000000000000" ]] && continue
  if [[ "$remote_sha" == "0000000000000000000000000000000000000000" ]]; then
    base="$(git merge-base "$local_sha" HEAD 2>/dev/null || echo "$local_sha")"
    range="${base}..${local_sha}"
  else
    range="${remote_sha}..${local_sha}"
  fi
  specs="$(git diff --name-only "$range" -- "${specs_dir}/*.md" 2>/dev/null || true)"
  rule_code=""
  if [[ ${#rule_globs[@]} -gt 0 ]]; then
    rule_code="$(git diff --name-only "$range" -- "${rule_globs[@]}" 2>/dev/null || true)"
  fi
  [[ -n "$specs" ]] && changed_specs="${changed_specs}${specs}"$'\n'
  [[ -n "$rule_code" ]] && changed_rule_code="${changed_rule_code}${rule_code}"$'\n'
done

changed_specs="$(sed '/^$/d' <<<"$changed_specs" | sort -u)"
changed_rule_code="$(sed '/^$/d' <<<"$changed_rule_code" | sort -u)"

# Interceptacao local (nao bloqueia): codigo de regra mudou sem nenhuma spec
# tocada no mesmo push. Espelha o check de CI (spec-drift-check).
if [[ -n "$changed_rule_code" && -z "$changed_specs" ]]; then
  echo "[spec-change-guard] AVISO: codigo de regra alterado sem spec correspondente neste push:" >&2
  echo "$changed_rule_code" | sed 's/^/  - /' >&2
  echo "[spec-change-guard] confirme se ${specs_dir}/ deveria ter sido atualizada antes de prosseguir (nao bloqueia o push)." >&2
fi

if [[ -z "$changed_specs" ]]; then
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

claude_bin="$(find_claude || true)"

if [[ -z "$claude_bin" ]]; then
  report_dir="${specs_dir}/.impact-reports"
  mkdir -p "$report_dir"
  branch="$(git rev-parse --abbrev-ref HEAD)"
  pending_file="${report_dir}/PENDING-push-${branch//\//_}.md"
  {
    echo "# Análise SDD pendente — push da branch ${branch}"
    echo
    echo "As specs abaixo foram alteradas neste push, mas o CLI \`claude\` não foi"
    echo "encontrado neste ambiente, então o plano de impacto automático não pôde ser gerado."
    echo
    echo "## Specs alteradas"
    echo
    echo "$changed_specs" | sed 's/^/- /'
    echo
    echo "## Como gerar o plano manualmente"
    echo
    echo "Abra uma sessão do Claude Code neste repositório e peça:"
    echo
    echo "> Analise o impacto das specs alteradas nos últimos commits seguindo a skill"
    echo "> ${skill_slug}."
    echo
    echo "Para habilitar a geração automática, instale o CLI:"
    echo '`curl -fsSL https://claude.ai/install.sh | bash` (ou `npm install -g @anthropic-ai/claude-code`).'
  } > "$pending_file"
  echo "[spec-change-guard] 'claude' indisponivel — analise pendente registrada em: ${pending_file}" >&2
  exit 0
fi

report_dir="${specs_dir}/.impact-reports"
mkdir -p "$report_dir"
branch="$(git rev-parse --abbrev-ref HEAD)"
stamp="$(date +%Y%m%d-%H%M%S)"

# Se o post-commit ja gerou (ou esta gerando) plano para o commit no topo do
# push, nao duplica a analise. Cobre tanto o .md pronto quanto o .inprogress.
head_sha="$(git rev-parse --short HEAD)"
if ls "${report_dir}/commit-${head_sha}-"*.md* >/dev/null 2>&1; then
  echo "[spec-change-guard] plano de impacto ja gerado/em andamento pelo post-commit (commit-${head_sha}-*) — push liberado." >&2
  exit 0
fi

report_file="${report_dir}/push-${branch//\//_}-${stamp}.md"
tmp_file="${report_file}.inprogress"

prompt="Siga a skill ${skill_slug} (${skill_path}). As specs a seguir mudaram neste push: ${changed_specs}. Rode git diff em cada uma, mapeie os arquivos de codigo impactados, monte o Plano de Alteracoes (arquivos impactados, alteracao de codigo proposta, casos de teste obrigatorios, checklist de conflitos entre regras) e escreva SOMENTE o plano em markdown, sem alterar nenhum arquivo de codigo ou teste."

echo "[spec-change-guard] specs alteradas neste push:" >&2
echo "$changed_specs" | sed 's/^/  - /' >&2
echo "[spec-change-guard] gerando plano de impacto EM BACKGROUND (push nao espera) — resultado em: ${report_file} (só aparece quando pronto)" >&2

nohup bash -c '
  if "$1" -p "$2" > "$3" 2>/dev/null; then
    mv -f "$3" "$4"
  else
    rm -f "$3"
  fi
' _ "$claude_bin" "$prompt" "$tmp_file" "$report_file" >/dev/null 2>&1 < /dev/null &
disown 2>/dev/null || true

exit 0
