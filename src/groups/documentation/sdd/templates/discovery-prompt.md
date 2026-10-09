Você vai preparar este repositório para adotar um processo de Spec-Driven Development (SDD)
assistido por IA. Sua tarefa tem duas partes: (1) criar uma pasta de especificações vivas
documentando as regras de negócio deste sistema, e (2) gerar um arquivo de manifesto que uma
ferramenta de linha de comando (sdd-bootstrap) vai usar depois para configurar hooks de git
automaticamente — sem precisar editar nenhum script à mão.

## Parte 1 — Pasta de specs

Explore o código deste repositório e identifique as regras de negócio centrais (validações,
cálculos, políticas, máquinas de estado, regras regulatórias — o que for o "coração" do domínio,
não infraestrutura genérica). Crie a pasta de specs (sugestão: `documentation/specs/`, mas use o
que fizer mais sentido para as convenções deste repo) com:

- `README.md`: índice numerado dos documentos, convenções (idioma, como citar código) e o ciclo
  SDD (spec → código → testes → checklist de conflitos).
- Um documento por tema/regra (ex.: `00-visao-geral.md`, `01-...md`, ...), cada um citando
  `Arquivo: caminho/do/arquivo.ext` do código que implementa a regra — **nível de arquivo, sem
  número de linha** (evita a citação ficar desatualizada a cada refactor).
- Um documento de glossário e invariantes: thresholds, enums, conjuntos de valores que não podem
  mudar sem decisão explícita.
- Marque explicitamente comportamento frágil ou dívida técnica onde encontrar (ex.: "⚠️ Risco").

Escreva no idioma predominante do time (o mesmo do código/comentários/commits). Documente o
comportamento **atual** do sistema (as-is), não o ideal.

## Parte 2 — Manifesto para a ferramenta de bootstrap

Depois de criar as specs, crie o arquivo `.sdd/manifest.json` na raiz do repositório:

```json
{
  "version": 1,
  "projectName": "<nome do projeto, inferido do repo>",
  "specsDir": "<caminho da pasta de specs que você criou, relativo à raiz>",
  "skillSlug": "sdd-<slug-curto-do-dominio>",
  "skillPath": ".claude/skills/sdd-<slug-curto-do-dominio>/SKILL.md",
  "ruleCodeGlobs": [
    "<glob 1 apontando para a pasta de regras de negócio>",
    "<glob 2, se houver mais de uma área relevante — ex.: regras de validação vs. regras de reversão/estorno>"
  ]
}
```

`ruleCodeGlobs` deve cobrir os diretórios de código onde vivem as regras de negócio que você
documentou — são os arquivos que, se mudarem sem a spec correspondente mudar junto, indicam risco
de divergência (drift). Use padrões relativos à raiz do repo, compatíveis com `git diff -- <pathspec>`
(ex.: `"src/domain/rules/*"`, `"internal/pricing/**"`).

## Ao terminar

Me diga: quantos documentos de spec você criou, o caminho da pasta de specs, e quais diretórios
entraram em `ruleCodeGlobs`. Não é necessário (nem recomendado) modificar nenhum outro arquivo do
repositório nesta etapa — isso é feito pela próxima etapa da ferramenta.
