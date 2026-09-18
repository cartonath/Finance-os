FINANCE OS v1.7.5 — SALDO VIVO
Build: 2026-09-18.02

Substitua os 9 arquivos do repositório pelos arquivos deste ZIP.

Correção principal:
- Depois que “Disponível agora” é definido, novas entradas somam automaticamente ao saldo.
- Gastos/pagamentos à vista, débito, Pix e outros meios não-cartão descontam automaticamente.
- Compras no crédito NÃO descontam o saldo na compra; a saída ocorre quando a fatura é marcada como paga.
- Desmarcar pagamento de conta/fatura desfaz a alteração correspondente no saldo.
- Editar/excluir lançamentos criados após a última reconciliação desfaz o efeito antigo e aplica o novo.
- Reajustar manualmente “Disponível agora” cria uma nova base e impede que lançamentos anteriores sejam reaplicados depois.

IMPORTANTE AO MIGRAR DA 1.7.3:
A 1.7.3 não registrava quando o saldo manual foi definido. Por segurança, a 1.7.5 não tenta recalcular retroativamente lançamentos antigos, pois isso poderia duplicar dinheiro. Faça uma única reconciliação manual do saldo real após atualizar; daí em diante ele acompanha as novas movimentações sozinho.
