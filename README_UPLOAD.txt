FINANCE OS v1.8.1 — CARD CLOSING SYNC + ENGINE HARDENING
Build 2026-10-01.03

Substitua os 9 arquivos da raiz do repositório pelos arquivos deste ZIP.
O GitHub Actions já configurado deve publicar automaticamente após o commit.

O que mudou nesta versão:
- Saldo disponível saiu do localStorage e passou para o IndexedDB/meta, junto dos dados financeiros.
- Backup v3 inclui o saldo disponível e metadados; restore é atômico (tudo ou nada).
- Pagamentos de fatura congelam valor/data pagos para o histórico não mudar depois.
- Desmarcar fatura/pagamento continua reversível e respeita a base atual do saldo.
- Cartão "excluído" agora é arquivado: dívidas e histórico não desaparecem.
- Alterar fechamento/vencimento do cartão mantém histórico de termos e não reescreve ciclos antigos.
- Limite disponível considera faturas/parcelas ainda comprometidas em vários ciclos.
- Corrigidas recorrências de 1ª segunda-feira antes do início e depois da data final.
- Compra avulsa fica no Histórico e não polui a lista de Contas da Home.
- Investimentos ficam separados de contas recorrentes comuns.
- Textos do usuário são escapados na renderização para evitar quebra/injeção de HTML.
- Ajuste de fatura usa o ciclo do vencimento; inclui migração do bug v1.7.5 (valor indo para o mês seguinte).
- Tela inicial redesenhada com semântica explícita: saldo hoje, a pagar e pago no mês.
- Mês futuro mostra previsão de contas, sem pedir "saldo de novembro".
- Adicionada verificação de integridade dentro de Ajustes.

Compatibilidade:
- Migra dados existentes da série 1.7.x automaticamente.
- Importa saldo vivo antigo do localStorage apenas na migração normal do aparelho.
- Backups antigos v1/v2 continuam aceitos, desde que tenham todas as coleções obrigatórias.
- Compra parcelada no cartão agora gera um registro resumido no Histórico sem duplicar o valor da fatura.
- Editar/excluir essa compra mantém Histórico e parcelamento sincronizados.

Correção v1.8.1:
- Status ABERTA/FECHADA agora é calculado pela data real de fechamento do ciclo.
- Alterar 'fecha dia' sincroniza imediatamente o status da fatura atual quando o ciclo atual é afetado.
- Flags booleanas antigas de 'fatura fechada' deixaram de forçar status incorreto após editar o cartão.
- Ajustar o valor da fatura não a marca mais como fechada.
- Entrada manual pelo fluxo 'fatura fechada' continua podendo marcar fechamento manual explicitamente.
- Cards agora exibem a data de fechamento e vencimento lado a lado.
