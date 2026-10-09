# Padrão das specs do SDD

Este é o contrato que a descoberta segue ao criar specs e que `repo-score sdd lint` verifica. Vale para qualquer repo, inclusive um que nem tenha a pasta `docs/`.

## 1. Onde ficam

`docs/specs/` na **raiz** do repo (ou do monorepo). É a presença dessa pasta que o repo-score usa para decidir que o SDD existe. Um `README.md` nela é o índice; cada spec está listada no índice.

## 2. Template: 4 blocos, sempre

Todo documento tem os quatro blocos, nesta ordem. Nenhum é omitido; cada um traz informação relevante, e quando não há nada a dizer o bloco diz isso e o que foi verificado.

```markdown
# NN.k — [BUS] Título da regra

> Parte de: [NN — Tema](./NN-tema.md)

## O que a regra faz
2 a 5 frases com o comportamento ATUAL, em linguagem de produto (veja a seção 3).

## Parâmetros
Tabela com limiares, constantes, enums e entradas que mudam o resultado, com o valor atual.
Sem parâmetros: escreva "Sem parâmetros:" e diga por quê.

## Contexto
Por que existe, ligação com outras specs (links), ⚠️ Risco onde há fragilidade, decisões conhecidas.

---

## Referências técnicas

Arquivo: caminho/do/arquivo.ext
```

## 3. Marcação [BUS] / [ENG] e linguagem

Cada spec é de **negócio** ou **técnica**, e isso aparece no nome do arquivo e no título:

- `NN.k-BUS-tema.md`, título `# NN.k — [BUS] Tema`: **regra de negócio**. Escrita como documentação de produto, para o time inteiro.
- `NN.k-ENG-tema.md`, título `# NN.k — [ENG] Tema`: **componente técnico** (leitura de arquivos, consultas, workers, integrações, filas). Linguagem de engenharia.
- No nome do arquivo a marcação vai **sem colchetes**: `[` e `]` são curingas de glob e quebram pathspec do git, `.gitignore` e os globs do manifest. Os colchetes ficam só no título.
- O script decide a marcação pelo nome e pelo caminho do código (ex.: `*Rule`, `*Handler` de domínio e serviços de cálculo = BUS; `*Reader`, `*Repository`, `*Worker`, `Infra.*`, envio e rastreio = ENG). Uma spec nunca mistura os dois públicos. Se o conteúdo mostrar que a marcação está errada, troque o nome (`git mv`) e os links.
- O índice (`README.md`) lista primeiro as specs BUS e depois as ENG.

**Em `## O que a regra faz` de uma spec [BUS]:** descreva o que acontece com o cliente, o contrato ou a operação e em que condições. **Não cite** nomes de classes, métodos, variáveis, campos, interfaces, enums nem arquivos, e não use código entre crases. O detalhe técnico entra em `## Parâmetros` (nome de negócio primeiro, nome técnico entre parênteses) e em `## Contexto`. O `lint` avisa (`linguagem`) quando encontra termos técnicos nesse bloco.

## 4. Curta e pontual

- **Uma regra por documento.** Alvo de **80 linhas**; máximo de **120**. Acima disso o `lint` acusa erro e a spec deve ser quebrada.
- Regra complexa vira **várias specs ligadas entre si**: uma spec de orquestração curta (a visão do fluxo, com links) e uma sub-spec por regra (`NN.1`, `NN.2`…), cada uma apontando de volta com "Parte de".
- **Arquivo grande de código** (acima de ~450 linhas) é dividido em partes por grupo de métodos (~300 linhas cada), uma spec por parte.
- **Documento existente grande** é convertido em várias specs, por grupos de seções. Um documento pequeno é absorvido por, no máximo, uma spec de código; os demais viram specs próprias.
- No máximo **4 arquivos de código** por spec de regra.

## 5. Ponteiros para o código (pré-requisito do SDD)

Cada spec tem pelo menos uma linha `Arquivo: caminho`, **só** no bloco "Referências técnicas":

- caminho relativo à **raiz do repo**, de um arquivo que existe;
- **nível de arquivo, sem número de linha** (linha envelhece a cada refactor);
- uma por linha, texto puro: o gate de commit lê essas linhas para saber quais arquivos a spec protege.

## 6. Proibido

Marcadores `TODO`/`TBD`, número de linha nos ponteiros, ponteiros para arquivos inexistentes, descrever o comportamento ideal em vez do atual (as specs são **as-is**), e copiar segredos ou dados pessoais do código.
