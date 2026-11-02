FINANCE OS v1.9.2 — UNKNOWN BALANCE FIX
Build: 2026-11-02.01

Substitua os 9 arquivos do repositório pelos arquivos deste pacote.
O GitHub Actions já configurado publica automaticamente após o commit.

CORREÇÃO PRINCIPAL
- Saldo desconhecido não é mais tratado como R$ 0,00.
- Registros antigos 0/negativos sem reconciliação explícita viram “saldo não informado”.
- Sem saldo informado, o card principal mostra somente o valor ainda a pagar.
- Ao pagar uma conta sem saldo informado, “A pagar” e o card principal caem juntos; não nasce saldo negativo fictício.
- Só um saldo explicitamente reconciliado passa a ser atualizado por entradas, gastos, parcelas e faturas.
- Saldo R$ 0,00 continua válido quando o usuário o confirma explicitamente.

REGRESSÃO-ALVO
Antes: A pagar 4.744,86; saldo não informado interpretado como 0; pagar 21 gerava saldo -21 e hero continuava 4.744,86.
Agora: sem saldo confirmado, pagar 21 leva A pagar/hero para 4.723,86.
Depois de reconciliar um saldo real, pagamentos reduzem saldo e dívida simultaneamente, preservando corretamente a posição líquida.
