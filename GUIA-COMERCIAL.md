# Guia comercial — vender atendimento por número

Modelo escolhido: **você opera a VPS e vende por Zap** (1 Zap = 1 cliente).
O cliente só usa o WhatsApp; quem entra no painel é você.

> Guia operacional. Não é parecer jurídico — contrato e LGPD devem ser revisados
> por um advogado.

---

## 1. Capacidade e custo

| Item | Valor |
|---|---|
| VPS KVM 2 (2 vCPU / 8 GB / 100 GB) | custo fixo mensal (**C**) |
| Zaps confortáveis por VPS | **5 a 7** (comece com 5 e acompanhe a RAM) |
| Ponto de equilíbrio | **C ÷ preço por Zap** |

Exemplo (preencha com seus números): se a VPS custa **R$ 70** e você cobra
**R$ 250** por Zap, **1 cliente** já paga a infraestrutura; com 5 clientes a
margem bruta é de **R$ 1.180/mês** antes de impostos e seu tempo.

Sinais de que é hora da 2ª VPS: uso de RAM acima de ~80% de forma constante,
travamentos no pareamento ou lentidão no envio.

## 2. Como precificar (estrutura sugerida)

Monte 3 pacotes e diferencie pelo que dá **trabalho**, não pelo que é fácil:

| Pacote | Inclui | Observação |
|---|---|---|
| **Básico** | 1 Zap, mensagens automáticas, contatos, horários | menor preço, pouca configuração |
| **Atendimento** | Básico + IA com treinamento + áudio + transbordo humano | pacote principal |
| **Completo** | Atendimento + campanhas + relatórios + ajustes mensais | preço maior, exige acompanhamento |

Cobre **setup** (pareamento + configuração inicial) separado da mensalidade.
Pareamento e treinamento consomem tempo real seu.

## 3. Onboarding de um cliente (passo a passo)

1. Contrato assinado + dados do responsável.
2. Criar o Zap no painel (nome, telefone, ícone).
3. Parear o WhatsApp com o celular do cliente (QR ou código de pareamento).
4. Configurar IA: provedor/chave, treinamento (textos da empresa), persona.
5. Configurar mensagens automáticas e horário de atendimento.
6. Configurar a cobrança: dia de vencimento, carência e valor mensal.
7. Teste de fumaça: mande mensagem de outro número, teste áudio e transbordo.
8. Entregar um resumo de 1 página + canal de suporte.

## 4. Ciclo de cobrança (já implementado)

Cada Zap tem um plano de cobrança com:

- `dueDay` — dia do vencimento
- `graceDays` — dias de carência
- `monthlyAmount` — valor mensal
- `paidMonths` — meses marcados como pagos

Regra aplicada pelo sistema:

| Situação | Comportamento |
|---|---|
| Sem plano configurado | ativo |
| Mês pago | ativo |
| Antes do vencimento | ativo |
| Vencido, dentro da carência | ativo |
| Vencido, passou da carência | **suspenso: o bot para de responder** |
| “Uso próprio” (`disabledForOwnUse`) | sempre ativo |

Rotina mensal sugerida:

1. **Dia (vencimento − 3):** envie o lembrete de cobrança.
2. **Dia do vencimento:** confira o panorama (`/billing/overview`) e marque os pagos.
3. **Após a carência:** o sistema suspende sozinho — não precisa bloquear na mão.
4. Registre comprovantes fora do sistema (planilha ou financeiro).

> O bloqueio suspende **respostas automáticas**. O cliente continua com o número
> dele e o histórico no painel.

## 5. Contrato — cláusulas que não podem faltar

- **Objeto:** automação de atendimento via WhatsApp. Deixe claro que **não** é a
  API oficial do WhatsApp e que existe risco de bloqueio do número.
- **Preço, vencimento, carência e suspensão:** descreva exatamente a regra acima.
- **Responsabilidades do cliente:** conteúdo enviado, lista de contatos, base
  legal para contatar as pessoas, uso permitido (sem spam).
- **Limite de uso justo:** mensagens/mês ou número de atendimentos, para proteger
  a VPS.
- **Risco de bloqueio:** isenção de garantia de disponibilidade do WhatsApp.
- **Suporte:** canal, horário e prazo de resposta.
- **Dados:** quem é o titular, retenção após cancelamento (ex.: 30 dias) e
  exportação mediante pedido.
- **Confidencialidade, rescisão e foro.**

## 6. LGPD na prática

Você vai guardar **conversas e contatos de clientes dos seus clientes**. Mínimo:

- Colete só o necessário e informe no atendimento que pode haver automação.
- Defina **prazo de retenção** (ex.: 90 dias de conversas) e apague o que venceu.
- Tenha um caminho para **excluir dados** de um titular quando pedirem.
- Acesso restrito: senha forte, **HTTPS** e ninguém além de você no painel.
- **Backup criptografado** (veja abaixo) — o `.tar.gz` puro contém conversas.
- Se usar IA de terceiro, lembre que as mensagens saem para o provedor: escolha
  um provedor com política compatível e avise no contrato.

Backup criptografado:

```bash
BACKUP_PASSPHRASE='uma-frase-longa-e-secreta' bash scripts/backup.sh
# restauração:
BACKUP_PASSPHRASE='uma-frase-longa-e-secreta' bash scripts/restore.sh backups/arquivo.tar.gz.enc
```

Guarde a frase **fora** da VPS (gerenciador de senhas). Sem ela o backup é inútil.

## 7. Risco do WhatsApp (comunique sempre)

O sistema usa automação **não oficial**. Isso significa:

- O número pode ser bloqueado pelo WhatsApp, principalmente com disparo em massa.
- Números novos devem ser “aquecidos” (pouco volume no começo).
- Não prometa “sem risco” nem “100% estável” no contrato ou na venda.

## 8. Checklist antes do 1º cliente pagante

- [ ] Domínio + **HTTPS** ativos (`scripts/setup-https.sh`)
- [ ] Senha admin forte e guardada
- [ ] Backup **criptografado** agendado no cron
- [ ] **Teste de restauração** feito uma vez (backup que nunca foi restaurado não é backup)
- [ ] Alerta de queda no `/health` (ex.: monitor externo a cada 5 min)
- [ ] Contrato assinado com cláusula de bloqueio do WhatsApp
- [ ] Cobrança configurada no Zap do cliente
- [ ] Uma semana de teste com um cliente amigo
- [ ] Procedimento de pareamento escrito (você vai repetir isso sempre)

## 9. Operação do dia a dia

| Frequência | O que fazer |
|---|---|
| Diário | conferir se o serviço está no ar e se os Zaps estão conectados |
| Semanal | ler os logs, conferir espaço em disco, olhar os backups |
| Mensal | cobrança, revisar treinamentos, medir RAM/uso |
| Por demanda | parear novo cliente, restaurar backup, atualizar o sistema |

Atualização:

```bash
cd /opt/assistente-zap && git pull && npm ci && systemctl restart assistente-zap
```

> Atualize fora do horário comercial e faça backup antes.

## 10. Crescimento

- **5 clientes:** uma VPS, operação manual de cobrança.
- **6–7 clientes:** monitorar RAM; provavelmente hora de abrir a 2ª VPS.
- **2+ VPS:** mantenha um painel por servidor (cada Setup aponta para um IP/domínio)
  e um controle financeiro único por fora.

Não tente vender “painel para o cliente” nessa fase: isso é multi-tenant e é outro
projeto. O que você vende aqui é **o atendimento funcionando**, não o software.
