
<!-- sdd-bootstrap:readme-section -->
## Specs e análise de impacto (SDD)

As regras de negócio deste projeto estão documentadas em
[`{{SPECS_DIR}}/`]({{SPECS_DIR}}/README.md). Mudanças nesses documentos disparam análise
automática de impacto no código (ver a skill [`{{SKILL_SLUG}}`]({{SKILL_PATH}})).

Ative uma vez os git hooks locais (cobre commit e push):

```sh
$ git config core.hooksPath .githooks
```

Camadas de interceptação:

- **Sessão do Claude Code** (`.claude/hooks/spec-change-guard.sh`): reage a edições de spec feitas
  em sessão, injetando o ciclo da skill no mesmo turno.
- **`pre-commit` (GATE — bloqueia)**: commit que toca spec só passa com análise de impacto
  aprovada; commit que toca arquivo **citado pelas specs** (`Arquivo: caminho`) sem spec junto é
  barrado. Rápido, sem LLM. Escape de emergência: `SDD_SKIP=1 git commit ...`.
- **`sdd-analyze`** (`.githooks/sdd-analyze`): gera o plano de impacto para o diff staged via
  `claude -p`, exibe no terminal e registra a aprovação que o gate exige (vinculada ao hash do
  diff — reeditar a spec invalida). Com o plano gerado numa sessão do Claude Code, use
  `./.githooks/sdd-analyze --approve`.
- **`post-commit`**: rede de segurança — se o commit tocou specs sem passar pelo `sdd-analyze`
  (ex.: `SDD_SKIP=1`), gera o plano em background em `{{SPECS_DIR}}/.impact-reports/`.
- **`pre-push`**: última rede local — gera plano (em background) para specs alteradas no push sem
  análise prévia e avisa se código de regra mudou sem spec.
{{CI_LINE}}

> `post-commit`/`pre-push` escrevem o relatório em `<nome>.md.inprogress` e só promovem (`mv`
> atômico) para `<nome>.md` quando `claude -p` termina — o arquivo final nunca aparece com 0
> bytes.

Fluxo típico ao mudar uma regra: editar a spec → `git add` → `./.githooks/sdd-analyze` (gera e
exibe o plano; aprova) → revisar o plano → `git commit`.

Configuração desta automação: [`.sdd/manifest.json`](.sdd/manifest.json).
<!-- /sdd-bootstrap:readme-section -->
