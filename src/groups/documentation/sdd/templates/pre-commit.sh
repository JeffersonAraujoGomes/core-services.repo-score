#!/usr/bin/env bash
# pre-commit (GATE SDD): intercepta commits que tocam a pasta de specs OU
# arquivos de codigo citados pelas specs (rastreabilidade "Arquivo: caminho"),
# mesmo fora do Claude Code. Rapido e sem LLM.
#
# Gerado por sdd-bootstrap. Parametrizado via .sdd/manifest.json.
#
# Bloqueios (escape de emergencia: SDD_SKIP=1 git commit ...):
#   1. Spec staged SEM analise de impacto aprovada -> bloqueia.
#      Aprovacao: ./.githooks/sdd-analyze (gera o plano e aprova) ou
#      ./.githooks/sdd-analyze --approve (plano gerado numa sessao do Claude Code).
#      A aprovacao e vinculada ao hash do diff staged: reeditar a spec invalida.
#   2. Arquivo citado por spec staged SEM spec junto -> bloqueia.
#
# Ao bloquear, grava <specsDir>/.impact-reports/BLOCKED-commit.md com as
# opcoes e um prompt pronto para colar no Claude Code.
#
# Ativacao (uma vez por dev, ja cobre todos os hooks desta pasta):
#   git config core.hooksPath .githooks
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

manifest=".sdd/manifest.json"
if [[ ! -f "$manifest" ]] || ! command -v jq >/dev/null 2>&1; then
  # Sem manifest ou sem jq, o gate nao tem como funcionar — nao bloqueia
  # silenciosamente para nao travar o time; avisa uma vez.
  echo "[spec-change-guard] AVISO: .sdd/manifest.json ou 'jq' ausente — gate SDD inativo. Rode sdd-bootstrap ou instale jq." >&2
  exit 0
fi

specs_dir="$(jq -r '.specsDir' "$manifest")"
skill_slug="$(jq -r '.skillSlug' "$manifest")"

report_dir="${specs_dir}/.impact-reports"
blocked_file="${report_dir}/BLOCKED-commit.md"

if [[ "${SDD_SKIP:-0}" == "1" ]]; then
  echo "[spec-change-guard] SDD_SKIP=1 — gate SDD ignorado neste commit (registre o motivo no PR)." >&2
  rm -f "$blocked_file"
  exit 0
fi

staged="$(git diff --cached --name-only)"
[[ -z "$staged" ]] && exit 0

staged_specs="$(grep -E "^${specs_dir}/.*\.md\$" <<<"$staged" || true)"

# ─── Gate 1: spec staged exige analise de impacto aprovada ─────────────────────
if [[ -n "$staged_specs" ]]; then
  spec_hash="$(git diff --cached --no-renames -- "$specs_dir" | shasum -a 256 | cut -d' ' -f1)"
  token_file="${report_dir}/.approved-${spec_hash}"
  if [[ -f "$token_file" ]]; then
    echo "[spec-change-guard] specs neste commit (analise aprovada):" >&2
    echo "$staged_specs" | sed 's/^/  - /' >&2
  else
    mkdir -p "$report_dir"
    {
      echo "# Commit bloqueado — specs alteradas sem análise de impacto"
      echo
      echo "Specs staged:"
      echo "$staged_specs" | sed 's/^/- /'
      echo
      echo "## Como liberar o commit"
      echo
      echo "**Opção 1 — terminal (recomendado):**"
      echo '```sh'
      echo "./.githooks/sdd-analyze"
      echo '```'
      echo "Gera o plano de impacto, exibe no terminal e registra a aprovação. Depois repita o commit."
      echo
      echo "**Opção 2 — sessão do Claude Code:** cole o prompt abaixo e, após revisar o plano, rode"
      echo '`./.githooks/sdd-analyze --approve` e repita o commit.'
      echo
      echo "> Analise o impacto do diff staged das specs (git diff --cached -- ${specs_dir})"
      echo "> seguindo a skill ${skill_slug}: mapeie o código impactado, monte o Plano de"
      echo "> Alterações com casos de teste obrigatórios e checklist de conflitos entre regras."
      echo
      echo "**Emergência (sem análise):** \`SDD_SKIP=1 git commit ...\` — registre o motivo no PR."
    } > "$blocked_file"
    echo "[spec-change-guard] COMMIT BLOQUEADO — rode ./.githooks/sdd-analyze e repita o commit (orientacao completa em ${blocked_file})" >&2
    echo "  Specs sem analise de impacto aprovada:" >&2
    echo "$staged_specs" | sed 's/^/  - /' >&2
    echo "  Alternativas: plano via sessao do Claude Code + ./.githooks/sdd-analyze --approve | emergencia: SDD_SKIP=1 git commit" >&2
    exit 1
  fi
fi

# ─── Gate 2: arquivo citado por spec sem spec junto ────────────────────────────
citation_map="$(grep -rHoE 'Arquivo: [^` ]+' "$specs_dir" 2>/dev/null \
  | sed -E 's/:Arquivo: /\t/' | awk -F'\t' '$2 ~ /\//' | sort -u || true)"

find_citing_specs() {
  local f="$1" spec c
  while IFS=$'\t' read -r spec c; do
    [[ -z "$c" ]] && continue
    if [[ "$c" == .../* ]]; then
      if [[ "$f" == *"${c#...}" ]]; then echo "$spec"; fi
    elif [[ "$c" == */ ]]; then
      if [[ "$f" == "$c"* ]]; then echo "$spec"; fi
    else
      if [[ "$f" == "$c" ]]; then echo "$spec"; fi
    fi
  done <<<"$citation_map" | sort -u
  return 0
}

staged_cited=""
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  [[ "$f" == "${specs_dir}"/* ]] && continue
  citing="$(find_citing_specs "$f" | paste -sd ', ' - || true)"
  if [[ -n "$citing" ]]; then
    staged_cited="${staged_cited}${f}"$'\t'"${citing}"$'\n'
  fi
done <<<"$staged"
staged_cited="$(sed '/^$/d' <<<"$staged_cited")"

if [[ -n "$staged_cited" && -z "$staged_specs" ]]; then
  mkdir -p "$report_dir"
  {
    echo "# Commit bloqueado — código citado por specs alterado sem spec"
    echo
    echo "Arquivos staged e a(s) spec(s) que os citam:"
    echo
    while IFS=$'\t' read -r f citing; do
      echo "- \`${f}\`"
      echo "  - citado por: ${citing}"
    done <<<"$staged_cited"
    echo
    echo "## Como liberar o commit"
    echo
    echo "**Se a mudança altera regra de negócio:** atualize a(s) spec(s) acima e inclua no mesmo"
    echo "commit (\`git add\` da spec + \`./.githooks/sdd-analyze\`)."
    echo
    echo "**Na dúvida — cole este prompt numa sessão do Claude Code:**"
    echo
    echo "> O pre-commit bloqueou meu commit: os arquivos abaixo, citados por specs, foram alterados"
    echo "> sem atualização de spec. Analise o diff staged (git diff --cached), determine se há"
    echo "> mudança de regra de negócio e, se houver, proponha a atualização das specs"
    echo "> correspondentes seguindo a skill ${skill_slug}:"
    while IFS=$'\t' read -r f citing; do
      echo "> - ${f} (citado por: ${citing})"
    done <<<"$staged_cited"
    echo
    echo "**Se NÃO altera regra (refactor, log, performance):** \`SDD_SKIP=1 git commit ...\`"
  } > "$blocked_file"
  echo "[spec-change-guard] COMMIT BLOQUEADO — codigo citado por spec sem spec junto; proximos passos em ${blocked_file}" >&2
  while IFS=$'\t' read -r f citing; do
    echo "  - ${f}  (spec: ${citing})" >&2
  done <<<"$staged_cited"
  echo "  Regra mudou? atualize a spec acima e inclua no commit. Refactor sem mudanca de regra? SDD_SKIP=1 git commit" >&2
  exit 1
fi

rm -f "$blocked_file"
exit 0
