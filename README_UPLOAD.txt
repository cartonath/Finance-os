FINANCE OS v1.9.4 — VALOR POR PARCELA
Build: 2026-11-25.01

Substitua os 9 arquivos do repositório pelos arquivos deste pacote.
O GitHub Actions já configurado publica automaticamente após o commit.

CORREÇÕES PRINCIPAIS
- Ao editar uma parcela pela Home, o Finance OS pergunta onde aplicar o novo valor:
  • Só esta parcela;
  • Todas as parcelas.
- Parcelas individuais podem ter valores diferentes sem alterar o restante do parcelamento.
- Exemplo: Asad Julia 2/5 pode ficar R$ 104,00 e 3/5, 4/5 e 5/5 continuarem em R$ 52,00.
- Para parcelamentos antigos que já tiveram o valor global sobrescrito, o app tenta recuperar o valor normal pela parcela anterior já paga.
- Quando não existe histórico suficiente para descobrir o valor antigo, o app pergunta uma vez qual valor deve permanecer nas demais parcelas.
- Editar o parcelamento pelo gerenciador continua sendo uma alteração global.
- Exclusão/restauração por parcela da v1.9.3 continua preservada.

REGRESSÕES-ALVO
- Override em 2/5 não altera 3/5, 4/5 ou 5/5.
- Alteração global limpa overrides anteriores e aplica o novo padrão.
- Backup/restore preserva valores especiais por parcela.
- Redução de quantidade continua removendo ocorrências impossíveis acima do total.
