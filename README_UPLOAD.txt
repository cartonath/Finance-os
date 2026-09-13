Finance OS v1.6.6 — GitHub Mobile READY
Build: 2026-09-13.9
Canal: Stable

Substitua TODOS os 9 arquivos da raiz do repositório GitHub Pages pelos arquivos deste pacote.
Os dados financeiros permanecem no IndexedDB do aparelho/navegador.

Mudanças principais:
- A Home virou um retrato do mês selecionado: pago, a pagar, atrasado e a definir aparecem juntos.
- Verde = pago; vermelho = atrasado; neutro = a pagar; amarelo = a definir.
- Parcelas futuras não invadem o mês atual.
- Se você cadastrar que a próxima parcela vence no futuro e é N/total, a parcela N-1 já vencida é inferida como paga automaticamente.
- Removido o checkbox “já paguei a parcela anterior”.
- Início volta para o mês atual; setas em “Contas de…” permitem consultar outros meses.
- Cache sincronizado com v1.6.6 build 2026-09-13.9.
