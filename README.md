# core-services-repo-score

Skill local do Claude Code que avalia um repositório contra o **Platform Repository Maturity Score v2.3** (7 dimensões, 71 critérios, nota E–S) e abre o resultado em um relatório HTML no navegador.

O dev instala a skill e pede ao Claude Code "analise o meu repo". A medição roda na máquina dele, sem enviar nada a um serviço central e sem gastar tokens; o Claude só orquestra e explica o resultado.

## Princípio de projeto

**O Claude nunca dá a nota.** Os coletores produzem *evidências* (`arquivo:linha`, commit, URL ou job). Dois passos de código decidem:

1. `verify` confere cada evidência contra o repo (arquivo existe? linha existe? o trecho bate? sem path traversal nem symlink para fora da raiz). Evidência que não confere é descartada e o critério vira `unmeasured`.
2. `score` aplica `skill/references/rubric.json`: pontos 0/1/2 por critério, agregação por dimensão, gates (S1, S3 e S6 limitam a C) e a nota.

Segredos achados nunca são reproduzidos: a evidência traz só arquivo, linha e o nome da chave.

## Instalar e usar a skill

Requer Node 20 ou mais (só para executar a análise; a skill avisa como instalar se faltar).

```bash
git clone <este-repo> && cd core-services-repo-score
npm install
npm run install-skill             # copia repo-score e reposcore para ~/.claude/skills
npm run install-skill -- --link   # alternativa para desenvolver a skill (links simbólicos)
```

Se o Claude Code já estava aberto e a skill não aparecer, abra uma nova sessão. Depois, em qualquer sessão (terminal ou aba Code do app):

- `/repo-score` ou `/reposcore`, ou escreva "repo score" / "analise o meu repo".

A skill conduz a análise passo a passo:

1. verifica o Node e pergunta qual repositório (o diretório atual ou outro caminho);
2. roda `plan`: confere pré-requisitos, mostra o que falta instalar (git, `gh` opcional) e avisos;
3. pergunta **quais grupos avaliar** (os 7 grupos da rubrica, todos ou escolhidos);
4. mostra a **previsão de tokens** (medição = 0; conversa ≈ N–M) e do tempo, e pede confirmação;
5. roda a análise e abre o relatório no navegador.

O relatório fica em `~/.repo-score/<repo>-<hash>/report.html` (os 20 mais recentes são mantidos); nada é gravado dentro do repo analisado. A análise considera a working tree, inclusive alterações ainda não commitadas, e compara com a execução anterior (se os grupos avaliados forem os mesmos).

## Grupos ativados

Neste momento **só o grupo Documentação está ativado**; Segurança, Testes, Código, Arquitetura, Operabilidade e Processo estão desativados (os coletores existem, mas não podem ser escolhidos). A ativação é parametrizável, da mais específica para a mais geral:

1. variável `REPO_SCORE_ENABLED_GROUPS` (ids separados por vírgula, ou `all`);
2. escolha do usuário em `~/.repo-score/config.json`: `repo-score groups set documentation,security` (e `groups reset`);
3. padrão entregue com a skill em `skill/references/groups.json`.

Na skill, a pergunta "quais grupos avaliar" lista só os ativados; com um único ativado ela apenas informa. Pedir um grupo desativado é recusado com a instrução de como ativá-lo.

## A nota

A nota é **sempre exibida**, de E a S. Duas regras de apresentação sobre o resultado do motor:

- **Cobertura insuficiente = E.** Se menos de 50% do peso do escopo avaliado foi medido, a nota é E e o relatório mostra a pontuação dos critérios medidos ao lado. Com os 10 coletores da v0, a cobertura máxima é de cerca de 10% do peso total, então hoje a nota tende a ser E; ela sobe conforme novos coletores entram.
- **Gate:** critério bloqueante (S1, S3, S6) em 0 ponto limita a nota a C.

Grupos não escolhidos ficam fora do cálculo (como dimensão N/A) e o total usa só o peso dos grupos avaliados.

## Correções e o SDD (grupo Documentação)

Depois de abrir o relatório, cada ponto de "Como subir a nota" tem um botão **Otimizar nota** que copia o comando para a sessão do Claude e inicia só aquela correção na branch atual (só a adoção do SDD usa branch nova). As ações são ranqueadas pelo ganho potencial de nota, com tipo (automática, guiada ou mista), tokens estimados e pré-requisitos. A principal é **adotar o SDD** (specs vivas + gate de commit com IA), incorporado do projeto `core-services.sdd-gate-ia`.

**Onde grava:** as ações comuns commitam na **branch atual**, um commit por ação, e dá para desfazer (`fix finish --decision discard --confirm` cria commits de revert). A adoção do SDD é a exceção: usa uma **branch nova** (`docs/repo-score-AAAAMMDD-HHMM`) e a atual não é tocada; com essa sessão aberta, os demais botões entram nela. A nota é **recalculada** depois e comparada com a de partida; na branch nova quem decide o merge é o usuário (`merge`, `keep` ou `discard`). Nunca há push. Árvore suja é recusada, um commit bloqueado por hook do time não é contornado sem aprovação, e arquivos que não são UTF-8 nunca são reescritos.

```bash
CLI=skill/scripts/repo-score.mjs
node $CLI fixes <repo> --groups documentation                                  # ações e ganho potencial
node $CLI fix preview <repo> --actions doc-hygiene,doc-owners                  # não escreve nada
node $CLI fix start <repo> --actions sdd-adopt --param rule_globs='src/Domain/Rules/*'   # cria a branch
node $CLI fix seal <repo>                                                      # commita o que falta e recalcula a nota
node $CLI fix finish <repo> --decision merge|keep|discard [--confirm]
```

**D7 (specs ↔ regras)** mede um universo, não só o que o manifest declara: arquivos no perímetro (`ruleCodeGlobs`) + código que as specs citam como regra + arquivos de comportamento nas mesmas pastas (heurística, sem DTOs, modelos, comandos e interfaces). Uma regra só está ligada se está **no perímetro e citada por uma spec**; citada fora do perímetro, no perímetro sem spec ou irmã sem nenhum dos dois contam como lacuna. Arquivos revisados que não são regra saem do universo em `docs.rule_exclude_globs`. A ação `sdd-adopt` também **completa um SDD já adotado**: amplia o perímetro com as pastas que as specs já citam (revisável, ou `--param rule_globs=a,b` / `perimeter=none`) e devolve uma tarefa guiada para documentar as regras sem spec.

Ações: `sdd-adopt`, `doc-hygiene`, `doc-adr`, `doc-owners`, `doc-refs`, `doc-readme` (guiada) e `doc-index`. Os templates dos hooks vêm do `core-services.sdd-gate-ia` por `npm run sync-sdd-templates` (um teste detecta edição manual). Detalhes e critérios D1–D9: [docs/plano-documentacao-sdd.md](docs/plano-documentacao-sdd.md).

## Rodar sem o Claude

```bash
npm run build
node skill/scripts/repo-score.mjs plan /caminho/do/repo               # pré-requisitos, grupos e previsão (não mede)
node skill/scripts/repo-score.mjs analyze /caminho/do/repo            # abre o navegador
node skill/scripts/repo-score.mjs analyze /caminho/do/repo --groups security,process
node skill/scripts/repo-score.mjs analyze /caminho/do/repo --no-open  # só imprime o resumo
node skill/scripts/repo-score.mjs analyze /caminho/do/repo --json     # saída completa em JSON
```

## O que a v0 mede

| Critério | O que mede |
|---|---|
| S1 | Segredos literais em config/IaC (appsettings, .env, values*.yaml, compose, `kind: Secret`, connection strings) |
| S2 | Credenciais de alta confiança no histórico git (AWS, chaves privadas, tokens GitHub/Slack/Google/Stripe) |
| S9 | Imagem base sem tag, `:latest` ou registry não aprovado |
| S12 | Lockfile presente e restaurado em modo locked (npm, .NET, Go, Gradle) |
| S13 | GitHub Actions fixadas por SHA |
| C12 | Arquivos de código acima do limite de linhas (gerados e testes ficam de fora) |
| P4 | Commits convencionais nos últimos 200 |
| P5 | Versionamento central de dependências (.NET, npm workspaces, Gradle) |
| P6 | CODEOWNERS granular |
| D3 | ADRs presentes e atualizados nos últimos 12 meses |

Os outros 61 critérios aparecem como "aguardando coletor" e ficam **fora do cálculo**. A nota nunca equivale à nota oficial da plataforma enquanto a cobertura for parcial.

## Política do repo (opcional)

`repo-score.policy.json` na raiz do repo analisado (ou `--policy <arquivo>`):

```json
{
  "profile": { "rules_engine": false, "has_database": true, "exposes_api": false },
  "max_file_lines": 500,
  "trusted_action_orgs": ["minha-org"],
  "approved_registries": ["mcr.microsoft.com"],
  "secret_allowlist": [{ "path": "tests/fixtures", "justification": "credenciais fictícias de teste" }]
}
```

Critérios não aplicáveis só existem se declarados em `profile` (N/A declarado, nunca silencioso).

## Desenvolvimento

```bash
npm install
npm test            # vitest (168 testes)
npm run typecheck   # tsc --noEmit
npm run build       # gera skill/scripts/repo-score.mjs
```

Restrições para permitir um binário único por plataforma no futuro (sem exigir Node do dev): sem addons nativos, sem `require` dinâmico, tudo em um bundle esbuild. O `npm run build` falha se o bundle violar isso.

Divergências do documento original que precisam de decisão do time: [docs/spec-discrepancies.md](docs/spec-discrepancies.md).

## Estrutura

```
skill/                 skill principal (SKILL.md, references/rubric.json, scripts/repo-score.mjs)
skill-alias/reposcore/ atalho /reposcore, que chama a skill repo-score
src/schema/            contratos (zod): rubrica, evidência, resultados
src/scorer/            pontuação, agregação, gates, regressão
src/verify/            conferência de evidências contra o repo
src/collectors/        coletores determinísticos (um arquivo por critério ou grupo)
src/report/ + ui/      relatório HTML autocontido (dados embutidos, sem rede)
src/groups/            um módulo por grupo da rubrica; Documentação (D1–D8, SDD, ações) já é independente
src/remediation/       motor genérico de correção (branch nova, aplicação segura, seal, finish)
src/analyze.ts         orquestra coleta → verificação → nota → histórico (e a regra da nota final)
src/plan.ts            pré-requisitos, grupos e previsão de tokens, sem medir nada
src/cli/               entrada do CLI
tests/                 vitest, com repositórios temporários como fixtures
```

## Próximos passos

Coletores para os 61 critérios restantes (começando pelos determinísticos: S3, S4, S8, C1–C3, A1, A5, D1…), agentes por dimensão para os critérios semânticos (A8–A10, D7, D9, O3), binário único por plataforma, e leitura opcional de GitHub (proteção de branch, status de CI) via `gh`.
