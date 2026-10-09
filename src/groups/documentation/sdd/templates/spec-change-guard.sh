#!/usr/bin/env bash
# PostToolUse hook: detecta edicoes em <specsDir>/**.md dentro de uma sessao
# do Claude Code e injeta instrucao para rodar o ciclo da skill do projeto.
#
# Gerado por sdd-bootstrap. Parametrizado via .sdd/manifest.json (nao edite
# os caminhos a mao aqui — edite o manifest e rode sdd-bootstrap de novo,
# ou ajuste manualmente as variaveis SPECS_DIR/SKILL_PATH abaixo se preferir
# nao usar o manifest).
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
manifest="$repo_root/.sdd/manifest.json"

if [[ ! -f "$manifest" ]] || ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

specs_dir="$(jq -r '.specsDir' "$manifest")"
skill_path="$(jq -r '.skillPath' "$manifest")"

input="$(cat)"
file_path="$(jq -r '.tool_input.file_path // empty' <<<"$input")"

if [[ -z "$file_path" ]]; then
  exit 0
fi

if [[ "$file_path" != *"${specs_dir}/"* || "$file_path" != *.md ]]; then
  exit 0
fi

rel_path="${file_path#*${specs_dir}/}"

context="A spec '${specs_dir}/${rel_path}' foi alterada nesta sessao. \
Antes de continuar, siga o ciclo SDD da skill deste projeto (${skill_path}): \
rode git diff no arquivo, mapeie os arquivos de codigo impactados usando a \
tabela spec->codigo da skill, monte o Plano de Alteracoes (arquivos \
impactados, casos de teste obrigatorios, checklist de conflitos entre \
regras) e apresente para aprovacao ANTES de alterar codigo, testes ou \
rodar a suite de testes do projeto."

jq -n --arg ctx "$context" \
  '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$ctx}}'
