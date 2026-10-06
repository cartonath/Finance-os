FINANCE OS v1.9.1 — COMPACT HOME + ANALYSIS HIERARCHY
Build: 2026-10-06.02

SUBSTITUA OS 9 ARQUIVOS DA RAIZ DO REPOSITÓRIO:
- README_UPLOAD.txt
- app.js
- core.js
- icon-192.png
- icon-512.png
- index.html
- manifest.webmanifest
- styles.css
- sw.js

GitHub Pages:
O repositório já usa o workflow customizado de GitHub Actions. Depois do commit na main, o deploy deve rodar automaticamente.

BASE v1.9.0 PRESERVADA

AJUSTES v1.9.1

- Home mais compacta: hero, métricas, cartões e linhas de contas ocupam menos altura sem perder informação.
- Análises reorganizada: Resumo → 30/60/90 → Cofres → “E se?” → Fechamento → Agenda → Entradas.
- Agenda detalhada saiu do topo do planejamento para não empurrar as ferramentas de decisão para baixo.
- Nenhuma mudança no motor financeiro da v1.9.0; patch visual/arquitetura de informação.

1. Cofres / metas
   - dinheiro reservado continua dentro do saldo real, mas deixa de ser considerado livre;
   - Home passa a mostrar Saldo hoje / A pagar / Reservado / Pago no mês;
   - Livre de verdade = saldo hoje - contas abertas - cofres.

2. Reconciliação do saldo
   - ao ajustar o saldo, o app mostra quanto o cálculo interno difere do saldo real;
   - mantém histórico das últimas reconciliações em metadados do backup.

3. Projeção de 30 / 60 / 90 dias
   - soma compromissos ainda abertos;
   - mostra agenda compacta com próximos vencimentos.

4. Simulador “e se?”
   - gasto à vista;
   - entrada extra;
   - compra no cartão em 1x ou parcelada;
   - não salva nada, apenas mostra impacto.

5. Fechamento do mês
   - meses passados podem ser congelados;
   - resumo e compromissos ficam preservados;
   - alterações naquele mês ficam bloqueadas até reabrir.

6. Backup mais visível
   - Ajustes informa quando foi o último backup;
   - alerta quando está ficando antigo.

7. Mantidas as correções anteriores
   - ciclo de cartão por vencimento/fechamento;
   - status de fatura sincronizado com a data real;
   - fatura paga com valor congelado;
   - saldo vivo no IndexedDB;
   - compras avulsas fora da Home;
   - cartões arquivados preservam histórico;
   - restore atômico e auditor de integridade.

IMPORTANTE
- Os dados continuam locais neste aparelho.
- Faça backup antes de qualquer reinstalação/limpeza de dados do navegador.
- Trocar os arquivos no GitHub não apaga o IndexedDB local do Finance OS.
