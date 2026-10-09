# Divergências encontradas no documento v2.3

Pontos em que o texto do rascunho se contradiz. O motor segue a **tabela de critérios (seção 5)**; cada item
precisa de decisão do time antes do congelamento da rubrica.

| # | Onde | O que o texto diz | O que a tabela diz | Como o motor trata |
|---|------|-------------------|--------------------|--------------------|
| 1 | V11 | 2 PII em logs em 40 KLOC = 0,05/KLOC → **2 pontos** | S4: 2 pts = 0; 1 pt = ≤ 0,5/KLOC → 0,05 vale **1 ponto** | Tabela (1 ponto). Corrigir V11 ou o limiar de S4. |
| 2 | V02, V03 | "58 critérios em 2" | Há 71 critérios (menos os N/A por perfil) | Os testes usam todos os critérios aplicáveis, sem fixar 58. |
| 3 | 4.4 | Segurança com "nove critérios" (S1–S9, máx. 42) | A dimensão Segurança tem 13 critérios (S1–S13, máx. 54) | O exemplo é testado com rubrica sintética de 9 critérios; a rubrica real usa 13. |
| 4 | 4.4 | Total do exemplo = 76,2 | Com 83,33 exato o total é 76,17 (o documento arredonda 83,3 antes de ponderar) | Testado como 76,17 → B. |
| 5 | S10 | "≤1 (só NetworkPolicy)" no limiar de 1 ponto | Mistura contagem com um estado | O motor aplica `count ≤ 1`; o coletor deve mapear "só NetworkPolicy" para um valor que dê 1 ponto. |
| 6 | S1 e o gate | "Segredo versionado ... limita a nota a C" (princípio 5) | S1: 0 achados = 2 pts, ≤ 1 = 1 pt. O gate só dispara com 0 pontos, ou seja, com **2 ou mais** segredos | Tabela: um único segredo vale 1 ponto e não aciona o gate. Se a intenção é gate com qualquer segredo, S1 precisa de limiar de 1 ponto = 0 (mesmo vale para S3 e S6). |
