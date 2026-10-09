# Plano: dimensão Documentação (5.6) e integração do SDD ao repo-score

Status: **implementado** (fases 1 a 4 e 6, exceto D9/diagrama). As decisões da seção 9 foram respondidas e estão registradas abaixo.

## Decisões tomadas e como foram implementadas

| # | Decisão | Implementação |
|---|---|---|
| 1 | Medir, entregar nota e abrir a opção de correção, com decisão do usuário | Coletores D1–D8, nota, seção "Como subir a nota" no relatório e fluxo `fixes` / `fix preview|start|seal|finish` |
| 2 | Incorporar o `sdd-gate-ia`; tudo de Documentação separado dos demais grupos | Módulo `src/groups/documentation/` (coletores, política, ações, painel, SDD); testes em `tests/documentation/`; instrução da skill em `skill/references/documentation.md`; um teste falha se o grupo importar de outro ou vice-versa |
| 3 | Discovery dentro da skill | Tarefas guiadas `sdd-discovery` e `sdd-skill`, executadas pelo Claude, com previsão de tokens e confirmação antes |
| 4 | Sem CI | O workflow não é instalado; o README gerado explica o motivo |
| 5 | D2: OWNERS preenchido e coberto pelo CODEOWNERS | Como proposto |
| 6 | Seções do README: lista proposta, parametrizável | `docs.readme_required_sections` na política substitui a lista inteira |
| 7 | `rules_engine` / alvo de teste: `crdt-risk.risk-services` | Usado como repo de referência e de calibração (em clone) |
| + | **Toda alteração em branch nova; nota recalculada nela; o usuário decide o merge** | `fix start` cria `docs/repo-score-AAAAMMDD-HHMM` e commita lá; `fix seal` recalcula a nota na branch e compara com a partida; `fix finish` = merge (sem push), keep ou discard |

Desvios do plano original, por causa da regra da branch: as ações **commitam na branch nova** (o plano dizia "nunca commita"), e o globs de regra do D7 ficam em `docs.rule_globs` (não em `rules.globs`), para manter o grupo isolado. D9 (diagrama) segue sem coletor.


## 1. Objetivo

1. Medir de verdade os 9 critérios de Documentação (D1–D9, peso 10), hoje só D3 tem coletor.
2. Quando a nota de Documentação for baixa, o relatório e a skill passam a oferecer um **plano de melhoria** com ações concretas, ranqueadas por ganho de nota, e a ação principal é **adotar o SDD** (specs vivas + gate de commit com IA), trazendo para dentro do repo-score o que hoje vive no `core-services.sdd-gate-ia`.
3. Depois de aplicar uma ação, a skill reanalisa e mostra a variação de nota.

Jornada final, dentro de `/repo-score`:

```
analisar (grupo Documentação) → nota + achados → "Quer um plano de melhoria?"
  → ações ranqueadas (ganho potencial, esforço, tokens) → você escolhe
  → simulação (dry-run: arquivos que seriam criados/alterados) → você aprova
  → aplica → reanálise → "Documentação 23% → 71% (+X na nota total)"
```

## 2. O que a investigação encontrou

**`core-services.sdd-gate-ia`** (Python, `pip install`): wizard `sdd-bootstrap` em duas fases.
- *Discovery* (humano): o wizard imprime um prompt que você cola em **outra** sessão do Claude Code; ela cria a pasta de specs e o `.sdd/manifest.json` (`specsDir`, `skillSlug`, `skillPath`, `ruleCodeGlobs`).
- *Scaffold* (script): copia hooks genéricos (`.githooks/pre-commit`, `sdd-analyze`, `post-commit`, `pre-push`, `.claude/hooks/spec-change-guard.sh`), faz merge seguro de `.claude/settings.json`, `.gitignore` e `README.md`, gera o rascunho da skill (via `claude -p` ou template com TODOs) e opcionalmente o workflow de CI.
- Os hooks **não são editados por projeto**: leem o manifest em runtime com `jq`. O gate extrai as citações `Arquivo: caminho` das specs a cada commit, então qualquer citação nova já passa a proteger aquele arquivo.

**`crdt-risk.risk-services`** (referência de SDD completo): 36 documentos em `docs/specs/` (índice, specs numeradas, glossário/invariantes), manifest, 4 hooks, skill-ponteiro em `.claude/skills/` apontando para a skill completa em `.github/skills/`, seção SDD no README da raiz e do app. README e OWNERS em 4 de 5 apps.

**O que o repo-score diz hoje sobre o `risk-services`** (rodei agora): Documentação **0,0%**, nota E, 1 de 10 critérios medidos (só D3: "sem ADR"). Ou seja, o SDD inteiro é invisível para a nota. É a motivação central deste plano.

**Fatos que mudam o desenho:**

| Fato | Consequência |
|---|---|
| O wizard é Python (`rich`, `pip`); o repo-score é TypeScript e promete não exigir instalação | Portar o scaffold para TS em vez de chamar o Python |
| A fase de discovery exige colar um prompt em outra sessão | Dentro da skill, o próprio Claude executa o discovery (com subagentes), sem sessão paralela |
| O guia (`sdd-guia-simplificado.md`) diz que a camada de CI foi **removida** (IP allow list da org bloqueia runners hospedados), mas o wizard ainda oferece o workflow com **padrão = sim** | Padrão deve ser **sem CI**; ponto aberto nº 4 |
| `OWNERS.md` do `customs-ingestion` é o texto-modelo ("Coloque aqui o nome do mantenedor 1") | D2 precisa detectar placeholder; "arquivo existe" não basta |
| `risk-services` versiona 3 arquivos `.bak` e deixa `PROMPT_PROXIMOS_PASSOS.md` solto na raiz | Resíduos reais, o que valida o desenho de D8 |
| Os hooks exigem `jq`; o `sdd-analyze` chama `claude -p` (gasta tokens do dev a cada commit de spec) | Pré-requisitos no `plan` e aviso de **custo recorrente** do SDD |
| `git config core.hooksPath .githooks` sobrescreve husky/lefthook se já existirem | Detectar e não sobrescrever sem aprovação |

## 3. Critérios D1–D9: o que medir e o que o SDD resolve

"SDD" na última coluna: **direto** = a adoção correta do SDD move o critério; **parcial** = ajuda; **não** = precisa de outra ação.

| ID (peso) | Como medir (determinístico) | SDD | Ação corretiva |
|---|---|---|---|
| **D1** README por app com seções obrigatórias (3) | Para cada app, README existe e contém os títulos obrigatórios (sinônimos pt/en). % de apps conformes. | parcial (o bootstrap adiciona uma seção SDD ao README) | Gerar esqueleto de README por app com as seções que faltam, preenchido com o que o repo já sabe (comando de build, testes) |
| **D2** OWNERS preenchido e consistente (1) | `OWNERS.md` por app sem texto-modelo, ≥ 1 mantenedor, e coberto por regra do CODEOWNERS | não | Gerar OWNERS a partir do CODEOWNERS, pedindo confirmação dos nomes |
| **D3** ADRs presentes e vivos (2) | Já existe | parcial: a análise de impacto do SDD acha "decisões de negócio pendentes", que viram ADR | Criar `docs/adr/` com template e o 1º ADR (adotar SDD) |
| **D4** Referências de caminho válidas (1) | % de referências a arquivos em docs (links, `Arquivo:`, caminhos entre crases) que resolvem. | **direto**: a convenção `Arquivo: caminho` e o gate mantêm as citações válidas | Listar referências quebradas com sugestão de destino (via `git log --follow`); corrigir com aprovação |
| **D5** Índice da raiz completo (1) | % dos docs de primeiro nível citados no índice (README raiz ou `docs/README.md`) | **direto**: o README de specs é um índice | Gerar/atualizar o índice |
| **D6** Docs internos sem órfãos (1) | % de docs com ≥ 1 link vindo de outro doc | **direto**: cada spec entra no índice | Linkar os órfãos no índice |
| **D7** Specs ↔ regras ligadas (1, só `rules_engine`) | % de arquivos de regra (globs do manifest) citados por alguma spec | **direto**: é exatamente o `ruleCodeGlobs` + citações | Discovery do SDD (cria specs citando as regras) |
| **D8** Higiene de docs e resíduos (1) | Contagem de: `.DS_Store`, `*.bak/.orig/.tmp`, docs vazios, docs com `TODO`/placeholder, relatórios efêmeros versionados | parcial (o bootstrap ignora `.impact-reports/`; skill com `TODO` conta como resíduo) | Lista de `git rm` proposta, nunca aplicada sem aprovação |
| **D9** Qualidade estrutural do diagrama (2) | Checklist de 9 itens sobre o diagrama como código (ver fase 5) | não | Rascunho de `docs/architecture/` (C1+C2) |

Com as fases 1 e 2 prontas (todos menos D9), o grupo Documentação mede 11 dos 13 pontos de peso (85%), então a nota do grupo deixa de ser "E por cobertura" e passa a ser uma letra real.

## 4. Decisões de medição (definições que preciso fechar)

- **O que é "app"** (D1, D2): lista de `apps.yml` se existir; senão pastas em `apps/` com Dockerfile ou projeto executável; senão o repo inteiro é um app. Pastas sem marcador não entram (V19).
- **O que é "doc"** (D4–D6, D8): `*.md` fora de `node_modules`, `bin`, `obj`, relatórios gerados (`.impact-reports/`) e CHANGELOG. Skills (`.claude/skills`, `.github/skills`) contam como docs.
- **Referência de caminho** (D4): links markdown relativos, `Arquivo: x` e caminhos entre crases com `/` e extensão. Ignora URLs, âncoras, globs, `<placeholders>` e blocos de código. Resolve relativo ao doc e à raiz do repo.
- **Seções obrigatórias de README** (D1), proposta padrão: descrição/visão geral, como executar, configuração, testes, deploy, responsáveis. Ajustável em `policy.docs.readme_required_sections`.
- **Globs de regra** (D7): lê `ruleCodeGlobs` do `.sdd/manifest.json` se existir, senão `policy.rules.globs`. Um só lugar, sem duplicar.
- **Novos campos de política**: `apps`, `docs.readme_required_sections`, `docs.ignore_globs`, `docs.residual_patterns`, `docs.adr_dirs`, `rules.globs`.

## 5. Remediação: catálogo de ações e fluxo

### 5.1 Catálogo (dado, não código espalhado)

Cada ação declara: `id`, título, critérios afetados, **tipo** (`auto` = script, sem tokens; `guided` = o Claude redige, gasta tokens; `manual` = só instruções), pré-requisitos (`jq`, `claude`, git limpo), o que escreve e o que nunca toca.

| Ação | Critérios | Tipo |
|---|---|---|
| **SDD-1 Adotar SDD** (pacote, ver 5.2) | D4, D5, D6, D7 (+D1, D8) | discovery `guided`, resto `auto` |
| DOC-1 Higiene (lista de resíduos) | D8 | `auto` (propõe), você confirma |
| DOC-2 Índice e órfãos | D5, D6 | `auto` |
| DOC-3 Referências quebradas | D4 | `auto` (sugere), você confirma |
| DOC-4 README por app | D1 | `auto` (esqueleto) + `guided` (conteúdo) |
| DOC-5 OWNERS a partir do CODEOWNERS | D2 | `auto`, nomes confirmados por você |
| DOC-6 ADRs (pasta, template, ADR de adoção do SDD) | D3 | `auto` |
| DOC-7 Diagrama C1+C2 como código | D9 (e A8–A10 depois) | `guided` |

### 5.2 O pacote SDD-1 (o que vem do `sdd-gate-ia`)

1. **Pré-checagem**: git limpo ou branch nova, `jq`, CLI `claude`, `core.hooksPath` já usado (husky/lefthook)? Se sim, **não sobrescrever**: mostrar como integrar.
2. **Discovery pela própria skill**: subagentes leem o código das regras e escrevem `docs/specs/` (índice, um tema por doc, glossário/invariantes, `Arquivo: caminho` sem linha) e o `.sdd/manifest.json`. É a etapa cara em tokens.
3. **Scaffold (script, sem tokens)**: hooks verbatim, `.claude/hooks/spec-change-guard.sh`, merge de `settings.json`, `.gitignore` (`.impact-reports/`), seção no README, rascunho da skill do domínio. Idempotente: nada é sobrescrito sem diferença, e a skill existente nunca é sobrescrita.
4. **Ativação** (`git config core.hooksPath .githooks`): pergunta explícita, separada.
5. **Reanálise** e delta de nota.

### 5.3 Regras de segurança da escrita

- Padrão é **dry-run**: lista de arquivos a criar/alterar com diff; só aplica após aprovação explícita.
- Nunca faz `git commit`, `push`, nem apaga arquivo sem aprovação por item.
- Só escreve dentro do repo; recusa árvore suja sem `--allow-dirty` (ou propõe criar a branch `docs/repo-score-AAAA-MM-DD`).
- Conteúdo do repo continua sendo dado, não instrução (já vale hoje).

### 5.4 Ganho previsto e tokens

- **Ganho potencial**: simula no próprio scorer "se estas ações atingirem 2 pontos nos critérios afetados", e mostra o ganho na dimensão e no total. É teto, rotulado como potencial, nunca promessa.
- **Tokens**: ações `auto` custam 0 além da conversa. Para o discovery do SDD, a previsão usa o tamanho do código de regra (caracteres ÷ 3,5 para leitura, mais saída das specs) com faixa ampla; **calibrar em 2 repos reais** antes de confiar, e mostrar previsto contra real depois.
- **Custo recorrente do SDD**, dito explicitamente: cada commit de spec dispara `sdd-analyze` (`claude -p`) na conta de quem commita.

### 5.5 Mudanças na skill e no relatório

- `plan` ganha pré-requisitos do SDD (`jq`, `claude`, `core.hooksPath`).
- Novo comando `plan-fix` lista as ações com ganho, esforço, tipo, tokens e pré-requisitos; `fix <ação> --dry-run | --apply` executa.
- Relatório: nova seção **"Como subir a nota"** no grupo Documentação, com o painel **"SDD: saúde"** (manifest válido? hooks ativos? specs indexadas? citações quebradas?).
- `SKILL.md`: depois do resumo, se Documentação < 100%, oferece o plano; perguntas via AskUserQuestion; confirmação com previsão antes de gastar tokens.

## 6. Arquitetura

- **Portar para TypeScript**, dentro do repo-score: `src/collectors/docs/*` (D1–D9), `src/remediation/{catalog,sdd,docs}.ts`, `src/diagram/` (fase 5), templates em `skill/assets/sdd/` (hooks bash e skill-modelo copiados do `sdd-gate-ia`, sem edição).
- **Fonte única dos templates**: script `sync-sdd-templates` copia do `sdd-gate-ia` com selo de versão e hash; um teste falha se divergirem. Ver decisão 2.
- O manifest `.sdd/manifest.json` continua sendo o contrato; o repo-score apenas lê e gera o mesmo formato, então repos já adotantes (`risk-services`) funcionam sem migração.

## 7. Fases, entregas e critérios de aceite

| Fase | Entrega | Critério de aceite | Porte |
|---|---|---|---|
| **1** Medição (sem tokens) | Coletores D1, D2, D4, D5, D6, D8; refinar D3; política nova | Fixtures com casos bom/ruim por critério; `risk-services` mede D4–D6 reais; falso positivo < 10% numa amostra de 2 repos revisada por você | M |
| **2** SDD como sinal | D7; painel "SDD: saúde"; leitura do manifest | `risk-services` (referência) tira 2 em D4–D7; `customs-ingestion` (sem SDD) tira 0; grupo Documentação passa de 50% de cobertura | M |
| **3** Remediação `auto` | Catálogo, `plan-fix`, `fix` com dry-run/apply; scaffold SDD portado; DOC-1, 2, 3, 6; SDD-1 passos 1, 3, 4 | Teste e2e em repo temporário: aplica SDD-1 (sem discovery), hooks funcionam (commit de spec é bloqueado sem análise), reanálise mostra o delta; idempotente (2ª execução não muda nada) | L |
| **4** Remediação `guided` | Discovery do SDD pela skill (subagentes), rascunho de skill de domínio, DOC-4 e DOC-5 com conteúdo; previsão e calibração de tokens | Em `customs-ingestion`: gera specs com `Arquivo:` válidos (D4 ≥ 98%), `ruleCodeGlobs` coberto (D7 ≥ 90%); tokens previstos × reais registrados | L |
| **5** Diagrama | Parser (Structurizr DSL e Mermaid C4 primeiro), D9 com checklist de 9 itens, DOC-7; módulo reutilizável por A8–A10 | Fixtures por item do checklist; diagrama-imagem não conta | L |
| **6** UI e skill | Seção "Como subir a nota", fluxo completo na skill | Percurso real no navegador e numa sessão do Claude Code, com a nota subindo | M |

Ordem sugerida: 1 → 2 → 3 entregam valor sem gastar token; 4 é o que mais consome; 5 pode andar em paralelo depois da 2.

## 8. Riscos

| Risco | Mitigação |
|---|---|
| SDD vira "teatro de citações": specs escritas só para pontuar | D7 mede cobertura real das regras, e o gate continua exigindo spec junto ao código citado; `.sdd` não é premiado por existir |
| Gate de commit trava o time | Escape `SDD_SKIP=1` documentado; ativação é pergunta separada; relatório de uso do escape fica como evolução |
| Discovery caro e de qualidade irregular | Previsão com confirmação; faixa calibrada; saída tratada como rascunho a revisar |
| Hooks pré-existentes (husky) | Detectar `core.hooksPath` e nunca sobrescrever |
| Divergência entre templates do `sdd-gate-ia` e do repo-score | Fonte única + teste de hash |
| Falso positivo em D4/D8 | Amostra revisada por humano antes de congelar (a própria rubrica exige precisão ≥ 90%) |
| Escrever no repo do dev sem querer | Dry-run padrão, aprovação por item, sem commit, árvore limpa |

## 9. Decisões que preciso de você

1. **Escopo da primeira entrega.** Fases 1+2 (medir, sem escrever nada) primeiro, ou já até a 3? *Recomendo 1+2 primeiro:* elas já corrigem o "0%" do `risk-services` e permitem validar as definições antes de gerar arquivos.
2. **Futuro do `sdd-gate-ia`.** (a) continua dono dos templates e o repo-score sincroniza; (b) o repo-score vira o dono e o wizard Python é descontinuado. *Recomendo (a) agora,* para não quebrar quem já usa, e decidir (b) depois da fase 3.
3. **Discovery dentro da skill** (a skill escreve as specs, com previsão de tokens) ou manter o fluxo atual de colar o prompt em outra sessão? *Recomendo dentro da skill,* é o ganho principal da fusão.
4. **CI do SDD.** Padrão **sem CI**, porque o guia diz que ele foi removido por causa da IP allow list. Confirma?
5. **Definição de D2** (consistente com CODEOWNERS): mantenedor preenchido + regra do CODEOWNERS cobrindo o app, e handles `@...` do OWNERS contidos nessa regra. Serve?
6. **Seções obrigatórias do README** (D1): uso a lista da seção 4 ou você tem a lista oficial da plataforma?
7. **Formato de diagrama** (fase 5): Structurizr DSL + Mermaid C4 primeiro, PlantUML depois. Serve?
8. **D7 e o perfil `rules_engine`**: repos sem o perfil recebem N/A em D7, mas ainda ganham o SDD em D4–D6. Ok? Quem declara `rules_engine` no `customs-ingestion`?
9. **Quem escreve no repo:** aceito "dry-run por padrão + aprovação por item + sem commit"? Quer também a criação automática de branch?
10. **Repos de calibração** dos tokens e da precisão: `customs-ingestion` e `risk-services`. Algum outro?

## 10. Fora de escopo (por ora)

Outros grupos da rubrica; CI do SDD; relatório de uso do `SDD_SKIP`; PlantUML; publicação no Neon Skill Hub; qualquer julgamento semântico da qualidade do texto das docs (rubrica v3).
