#!/usr/bin/env bash
# sdd-analyze: gera o plano de impacto SDD para as specs STAGED e registra a
# aprovacao que o pre-commit exige para deixar o commit passar.
#
# Gerado por sdd-bootstrap. Parametrizado via .sdd/manifest.json.
#
# Uso:
#   ./.githooks/sdd-analyze            # gera via claude -p e aprova
#   ./.githooks/sdd-analyze --approve  # so registra a aprovacao (plano
#                                      # gerado numa sessao do Claude Code)
#
# A aprovacao e vinculada ao hash do diff staged: reeditar a spec invalida.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

manifest=".sdd/manifest.json"
if [[ ! -f "$manifest" ]]; then
  echo "[sdd-analyze] .sdd/manifest.json nao encontrado — rode sdd-bootstrap neste repo primeiro." >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "[sdd-analyze] 'jq' e obrigatorio e nao foi encontrado no PATH." >&2
  exit 1
fi

specs_dir="$(jq -r '.specsDir' "$manifest")"
skill_path="$(jq -r '.skillPath' "$manifest")"
skill_slug="$(jq -r '.skillSlug' "$manifest")"

report_dir="${specs_dir}/.impact-reports"
mkdir -p "$report_dir"

staged_specs="$(git diff --cached --name-only -- "${specs_dir}/*.md" || true)"
if [[ -z "$staged_specs" ]]; then
  echo "[sdd-analyze] nenhuma spec staged (git add ${specs_dir}/... primeiro)." >&2
  exit 1
fi

spec_hash="$(git diff --cached --no-renames -- "$specs_dir" | shasum -a 256 | cut -d' ' -f1)"
token_file="${report_dir}/.approved-${spec_hash}"

approve() {
  rm -f "${report_dir}"/.approved-* 2>/dev/null || true
  {
    echo "specs aprovadas em $(date '+%Y-%m-%d %H:%M:%S'):"
    echo "$staged_specs"
  } > "$token_file"
  echo "[sdd-analyze] aprovacao registrada para o diff staged atual — o commit esta liberado." >&2
  echo "[sdd-analyze] (editar as specs de novo invalida a aprovacao)" >&2
}

if [[ "${1:-}" == "--approve" ]]; then
  approve
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
  echo "[sdd-analyze] CLI 'claude' nao encontrado. Gere o plano numa sessao do Claude Code" >&2
  echo "e depois rode: ./.githooks/sdd-analyze --approve" >&2
  exit 1
fi

stamp="$(date +%Y%m%d-%H%M%S)"
report_file="${report_dir}/staged-${stamp}.md"
staged_diff="$(git diff --cached --no-renames -- "$specs_dir")"

prompt="Siga a skill ${skill_slug} (${skill_path}). O diff STAGED abaixo altera specs. Mapeie os arquivos de codigo impactados, monte o Plano de Alteracoes (arquivos impactados, alteracao de codigo proposta, casos de teste obrigatorios, checklist de conflitos entre regras) e escreva SOMENTE o plano em markdown, sem alterar nenhum arquivo de codigo ou teste.

Specs alteradas:
${staged_specs}

Diff staged:
${staged_diff}"

echo "[sdd-analyze] gerando plano de impacto (pode levar alguns minutos)..." >&2
if "$claude_bin" -p "$prompt" > "$report_file" 2>/dev/null; then
  echo "[sdd-analyze] plano gerado em: ${report_file}" >&2
  echo "----------------------------------------------------------------------"
  cat "$report_file"
  echo "----------------------------------------------------------------------"
  approve
else
  rm -f "$report_file"
  echo "[sdd-analyze] falha ao gerar o plano — verifique o CLI e tente de novo," >&2
  echo "ou gere numa sessao do Claude Code e rode: ./.githooks/sdd-analyze --approve" >&2
  exit 1
fi
