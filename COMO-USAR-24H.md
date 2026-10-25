# Assistente do Zap — modo 24h

## O que mudou

Antes, o programa do PC era o próprio bot: ao abrir, ele iniciava o WhatsApp
localmente; ao fechar, parava. Agora o Setup é **apenas o painel** e o bot roda
24h no **GitHub Actions**, sem precisar do PC ligado.

- **Servidor 24h:** GitHub Actions (repositório `Link-do-Zap`, workflow `zap-bot`).
- **Painel:** atalho **“Link no WhatsApp 24h”** na área de trabalho.
- **Dados/sessão:** repositório privado `linkzap-dados`.
- **Log do servidor:** publicado no repositório de dados e exibido no painel.
  O painel guarda o histórico localmente e respeita o botão **Limpar**.

## Primeira vez: parear o WhatsApp

O pareamento é a **única etapa manual** e precisa ser feito uma vez:

1. Abra o atalho **“Link no WhatsApp 24h”**.
2. Vá em **Meus Zaps** e clique no zap **Vendedor de Sites**.
3. Clique em **Conectar**. O painel busca o QR/código atual no servidor.
4. No celular: **WhatsApp → Aparelhos conectados → Conectar aparelho** e
   escaneie o QR (ou digite o código de 8 dígitos, se aparecer).
5. Quando o painel mostrar **Funcionando**, pode fechar o programa e desligar o
   PC. O bot continua no servidor.

> O QR/código expira em poucos minutos. Se expirar, abra o zap de novo para
> buscar o QR atualizado.

## No dia a dia

- **Ver status/log:** abra o atalho **“Link no WhatsApp 24h”** → **Gerenciar
  Servidor**. O terminal mostra o histórico desde a última limpeza.
- **Baixar o log completo:** botão **Baixar** no terminal.
- **Alterar configurações:** edite no painel normalmente. Ao salvar, o app
  envia as configurações para o servidor.
- **Ligar/desligar o bot:** botão **Desligar servidor / Ligar servidor** na
  tela Gerenciar Servidor.

## Onde ficam os arquivos

| Item | Caminho |
|---|---|
| Programa/painel | `D:\LinkZapApp\Link no WhatsApp.exe` |
| Dados locais (configs, log, sessão local) | `%APPDATA%\link-no-whatsapp\link-no-whatsapp` |
| Clone do repositório de dados | `%APPDATA%\link-no-whatsapp\link-no-whatsapp\server-repo` |
| Atalho | Área de trabalho → **Link no WhatsApp 24h** |

> O app antigo em `C:\Program Files\Link no WhatsApp` ainda existe, mas **não
> deve ser aberto**: ele inicia o WhatsApp no PC e disputa a sessão com o
> servidor. Use somente o atalho novo.

## Limitações do GitHub Actions

- A cada ~5 h a execução é trocada por outra; há uma janela de ~1–4 min em que
  o WhatsApp fica offline. O WhatsApp reentrega as mensagens quando a sessão
  volta.
- O agendador antigo do workflow ainda cria execuções extras; isso não impede o
  bot de funcionar, mas pode ser removido depois com um token do GitHub que
  tenha permissão de `workflow`.

## Se o bot cair

O servidor tem um watchdog que tenta reconectar sozinho a cada 60 s. Se ficar
muito tempo sem reconectar:

1. Abra **Gerenciar Servidor** e veja o log.
2. Use **Desligar servidor** e **Ligar servidor** para forçar uma nova execução.
3. Se o QR/código não aparecer, aguarde alguns minutos e abra o zap novamente.
