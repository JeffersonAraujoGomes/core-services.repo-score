---
name: {{SKILL_SLUG}}
description: 'Desenvolvimento orientado a especificacao (SDD) do dominio {{PROJECT_NAME}}. Use quando: alterar regras de negocio, mudar thresholds/constantes de dominio, ou qualquer comportamento descrito em {{SPECS_DIR}}/. Para NOVA REGRA ou ALTERACAO DE REGRA existente: o fluxo obrigatorio e spec -> codigo -> testes -> revisao de conflitos. TODO: revisar esta descricao para citar os temas de negocio reais do projeto — quanto mais especifica, melhor o Claude Code aciona esta skill automaticamente.'
---

# SDD — {{PROJECT_NAME}} (rascunho — preencha antes de usar em produção)

Esta skill orquestra mudanças usando **Spec-Driven Development**: a especificação em
`{{SPECS_DIR}}/` é a fonte de verdade funcional. Toda alteração começa pela spec e termina
com spec, código e testes sincronizados.

> ⚠️ **Este arquivo é um rascunho gerado pelo sdd-bootstrap.** As seções abaixo têm placeholders
> `TODO` — preencha com o conhecimento real do domínio antes de confiar neste gate em produção.
> O valor desta skill está inteiramente em capturar os conflitos que *este* sistema tem
> historicamente — um checklist genérico não substitui isso.

## Fonte de verdade

As specs ficam em [`{{SPECS_DIR}}/`](../../../{{SPECS_DIR}}/). Comece sempre pelo
`{{SPECS_DIR}}/README.md`.

## Mapa rápido spec → código

<!-- TODO: preencha a tabela abaixo ligando cada tema/spec aos arquivos de código reais. -->

| Tema | Arquivo(s) de código |
|------|-----------------------|
| TODO | TODO |

## Trilha obrigatória — nova regra ou alteração de regra existente

```
1. SPEC       Descrever o comportamento novo/alterado na spec relevante
      ↓            + atualizar thresholds/conjuntos no documento de glossário
2. CÓDIGO     Implementar conforme a spec, sem antecipar comportamento não descrito
      ↓
3. TESTES     Cobrir os casos obrigatórios (ver seção abaixo)
      ↓
4. CONFLITOS  Executar o checklist de conflito entre regras (ver seção abaixo)
      ↓
5. GATE       Passar o gate de saída
```

### Casos de teste obrigatórios por tipo de mudança

<!-- TODO: preencha com os cenários mínimos que este domínio exige por tipo de mudança
     (ex.: nova regra, alteração de threshold, alteração de cálculo). -->

| Tipo de mudança | Casos obrigatórios |
|------------------|---------------------|
| TODO | TODO |

## Revisão de conflitos entre regras

> Execute este checklist APÓS implementar o código e ANTES do gate de saída.
> O objetivo é garantir que a nova regra não quebre silenciosamente outra existente.

<!-- TODO: substitua pelos tipos de conflito reais do seu domínio. Exemplos do tipo de
     pergunta que deve estar aqui (adapte para o seu contexto):
     - Duas regras competem pelo mesmo campo/condição? Qual tem precedência?
     - Uma regra nova pode bloquear/alterar um fluxo de saída de estado de outra regra?
     - Configuração dependente (tabelas, mapas de produto/categoria) está completa para
       todos os valores que a nova regra pode produzir? -->

- [ ] TODO
- [ ] TODO

## Ciclo SDD (detalhado)

### 1. Localizar
Identifique a(s) spec(s) impactada(s) pela mudança usando o índice do
`{{SPECS_DIR}}/README.md`. Leia-a(s) por completo, incluindo o documento de glossário/invariantes.

### 2. Revisar a spec PRIMEIRO
Edite a spec descrevendo o **novo comportamento** antes de tocar no código. Mantenha a
rastreabilidade `Arquivo: caminho` (nível de arquivo, sem número de linha).

### 3. Refatorar o código
Implemente a spec. <!-- TODO: liste aqui as "regras de ouro" do seu domínio (invariantes que
nunca podem quebrar sem registro explícito). -->

### 4. Atualizar testes
Para cada regra/threshold alterado ou adicionado, adicione os casos da tabela acima e confirme
que os testes vizinhos ainda passam (regressão).

### 5. Executar revisão de conflitos
Execute o checklist completo da seção acima. Se um conflito for encontrado e aceito
intencionalmente, registre como `[x] intencional — <motivo>` na spec correspondente.

### 6. Validar rastreabilidade (gate de saída)
- [ ] Cada regra/threshold novo aparece na spec específica **e** no documento de glossário.
- [ ] Citações `Arquivo: caminho` conferem com o código atual.
- [ ] Casos de teste obrigatórios foram implementados e passam.
- [ ] Checklist de conflitos entre regras foi executado sem itens pendentes.

## Princípios

- **Spec antes de código.** Se a mudança não couber em nenhuma spec, crie um novo documento
  e registre no índice do README.
- **AS-IS honesto.** As specs descrevem o que o código faz hoje, não o ideal.
- **Um tópico por documento.** Não acumule temas; prefira um novo doc a inflar um existente.
- **Conflito explícito > conflito silencioso.** Se duas regras se sobrepõem intencionalmente,
  documente qual tem precedência e por quê.
