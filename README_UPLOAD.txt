FINANCE OS v1.9.3 — CONTROLE POR OCORRÊNCIA
Build: 2026-11-13.01

Substitua os 9 arquivos do repositório pelos arquivos deste pacote.
O GitHub Actions já configurado publica automaticamente após o commit.

CORREÇÕES PRINCIPAIS
- Qualquer parcela pode ser removida individualmente sem apagar o parcelamento inteiro.
- Conta recorrente pode ter somente um mês removido, preservando os demais.
- Pagamentos já marcados também oferecem “Excluir só esta parcela/mês”.
- Parcelas/meses removidos podem ser restaurados pelos gerenciadores em Ajustes.
- Reduzir um parcelamento de 12 para 11 remove ocorrências acima do novo total, impedindo estados impossíveis como 12/11.
- A migração corrige automaticamente ocorrências antigas acima do total de parcelas.
- Ao aumentar novamente o total, ocorrências removidas automaticamente pela redução podem ser recuperadas.
- Formulários novos usam por padrão o mês que está sendo visualizado, evitando salvar em novembro enquanto a tela está em dezembro.
- “Gastei agora” deixa explícito que vai para o Histórico; “Tenho que pagar” deixa explícito que aparece na Home.

REGRESSÕES-ALVO
- Empréstimo 11/11 em novembro não pode gerar 12/11 em dezembro.
- Excluir parcela N não altera N-1 ou N+1.
- Desmarcar pagamento volta a parcela para planejada; excluir a ocorrência não volta.
- Excluir mês de recorrência não exclui a regra.
- Um lançamento criado enquanto se visualiza outro mês nasce naquele mês por padrão.
