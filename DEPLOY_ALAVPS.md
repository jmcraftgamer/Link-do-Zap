# Assistente do Zap no AlaVPS — 24h sem ligar o PC

Guia completo para deixar o sistema rodando o tempo todo num servidor Linux
grátis (AlaVPS), com QR Code e status acessíveis pelo navegador via túnel SSH.

**O que você ganha:** o assistente responde 24h/7 dias, seu notebook pode
desligar, e o serviço se reconecta sozinho se o servidor reiniciar.

---

## 1. Criar a VPS no AlaVPS

1. Acesse <https://manage.alavps.com> e cadastre-se com seu e-mail.
2. No catálogo, escolha **Free VPS** (KVM, 2 vCPU, até 8 GB RAM, 128 GB NVMe).
3. Sistema operacional: **Ubuntu 22.04 LTS ou 24.04 LTS** (só Linux no plano grátis).
4. Região: a mais próxima do Brasil (ou a única disponível).
5. Em alguns minutos você recebe por e-mail o **IP**, o **usuário root** e a **senha**.

> **Aviso:** o plano grátis do AlaVPS é *promocional* (o site deles fala em
> ~120 dias / 1–3 meses, com aviso antes de expirar). Anote a data do cadastro.
> As páginas deles divergem sobre exigir cartão — confirme no seu cadastro.
>
> Especificações mínimas para o assistente: ~1 GB de RAM livre (Electron +
> Chromium do WhatsApp). Com 4–8 GB você fica tranquilo.

---

## 2. Conectar via SSH (Windows)

Abra o PowerShell e conecte (troque `IP_DA_VPS` pelo IP do e-mail):

```powershell
ssh root@IP_DA_VPS
```

- Aceite a impressão digital (`yes`).
- Troque a senha recebida: `passwd`
- Para sair: `exit`

---

## 3. Copiar o sistema para a VPS

No PowerShell, **dentro da pasta do projeto** (onde fica o `package.json`):

```powershell
ssh root@IP_DA_VPS "mkdir -p /opt/link-zap"
tar czf app.tar.gz --exclude=node_modules --exclude=.git .
scp app.tar.gz root@IP_DA_VPS:/opt/link-zap/
Remove-Item app.tar.gz
```

> Não copie a pasta `node_modules` — o setup instala as dependências **dentro
> da VPS** (versão do Linux). O `tar` já respeita isso pelo `--exclude` e, se
> você criar arquivos novos no projeto, eles entram sozinhos.
>
> Alternativa sem tar (copie também quaisquer arquivos novos da raiz):
> `scp -r package.json package-lock.json main.js preload.js src test deploy DEPLOY_ALAVPS.md root@IP_DA_VPS:/opt/link-zap/`

---

## 4. Rodar o setup (instala tudo e testa)

```powershell
ssh root@IP_DA_VPS
cd /opt/link-zap
tar xzf app.tar.gz && rm app.tar.gz
bash deploy/alavps/setup.sh
```

O script faz, nesta ordem:

1. Instala as bibliotecas do Electron + Xvfb (apt).
2. Instala o Node.js 20 (se não houver).
3. Descompacta os arquivos em `/opt/link-zap` (`tar xzf app.tar.gz -C /opt/link-zap && rm app.tar.gz`).
4. `npm install` (baixa o Electron do Linux).
5. **Roda todos os testes (`npm test`) — se falhar, o serviço NÃO é instalado.**
6. Instala e habilita o serviço `link-zap` (systemd).

---

## 5. Iniciar e escanear o QR Code

Na sessão SSH da VPS:

```bash
systemctl start link-zap
systemctl status link-zap --no-pager | tail -n 8
```

Agora, **no seu notebook**, abra o túnel SSH (mantenha esta janela aberta):

```powershell
ssh -L 8123:localhost:8123 root@IP_DA_VPS
```

E no navegador: <http://localhost:8123>

Na página de status:

1. Clique em **Conectar (QR)** ao lado do zap.
2. Em até ~30s o **QR Code aparece na própria página**.
3. No celular: WhatsApp → **Aparelhos conectados** → **Conectar aparelho** →
   escaneie o QR.
4. A página passa a mostrar **pronto** (verde) e os logs confiram a conexão.

A partir daí a sessão fica salva em `/opt/link-zap/data/sessions/` e o app
**reconecta sozinho** toda vez que o serviço/VPS reiniciar (log `[AUTO]`).

> O túnel SSH é a única porta de acesso: o servidor de status escuta apenas em
> `127.0.0.1` da VPS, então ninguém de fora consegue ver o QR ou os logs.
> Se quiser, adicione senha com a env `LINK_HTTP_TOKEN=sua-senha` no arquivo
> `/etc/systemd/system/link-zap.service` (linha `Environment=`) + `systemctl restart link-zap`.

---

## 6. Configurar zaps, provedores e treinamentos

A interface gráfica (janela do app) **não existe no servidor** — a configuração
é feita nos arquivos JSON da pasta `/opt/link-zap/data/`.

**Caminho mais fácil (recomendado):** configure tudo primeiro no Windows
(zaps, provedores de IA, treinamentos) e depois copie:

```powershell
$origem = "$env:APPDATA\link-no-whatsapp\link-no-whatsapp"
scp "$origem\zaps.json" "$origem\providers.json" "$origem\trainings.json" root@IP_DA_VPS:/opt/link-zap/data/
scp -r "$origem\trainings" root@IP_DA_VPS:/opt/link-zap/data/   # so se usar imagens de treinamento
```

Depois reinicie o serviço na VPS:

```bash
systemctl restart link-zap
```

**Alternativa:** edite direto no servidor (`nano /opt/link-zap/data/zaps.json`).

> Chaves de API dos provedores ficam em `providers.json` — ele também é copiado,
> então você **não refaz** nenhuma configuração.

---

## 7. Operação do dia a dia

| Quero... | Comando / ação |
|---|---|
| Ver status e QR | Túnel SSH + <http://localhost:8123> (atualiza sozinho a cada 5s) |
| Ver o serviço | `systemctl status link-zap --no-pager` |
| Ver logs ao vivo | `journalctl -u link-zap -f` (sair com Ctrl+C) |
| Reiniciar | `systemctl restart link-zap` |
| Parar | `systemctl stop link-zap` |
| Conectar sem QR (pareamento) | `curl -X POST http://localhost:8123/connect -H "Content-Type: application/json" -d '{"zap":"ID_DO_ZAP","method":"pairing","phone":"5532999999999"}'` (com o túnel aberto) e digite o código de 8 dígitos no celular |

O serviço tem `Restart=always`: se o app morrer ou o VPS reiniciar, ele volta
sozinho em ~5 segundos e reconecta os zaps com sessão salva.

---

## 8. Atualizar o sistema

1. No notebook: copie só o que mudou (mesmos comandos do passo 3).
2. Se o `package.json` mudou: `ssh root@IP` → `cd /opt/link-zap && npm install`
3. Rode os testes: `npm test` (deve fechar com `TODOS OS TESTES PASSARAM`)
4. Reinicie: `systemctl restart link-zap`

---

## 9. Backup

Tudo importante está em `/opt/link-zap/data/` (config + sessão do WhatsApp +
histórico de conversas). Para guardar no notebook:

```powershell
ssh root@IP_DA_VPS "cd /opt/link-zap && tar czf /tmp/backup.tar.gz data"
scp root@IP_DA_VPS:/tmp/backup.tar.gz .\backup-zap-$(Get-Date -Format yyyyMMdd).tar.gz
```

Para restaurar: pare o serviço, extraia o tarball em `/opt/link-zap/`, inicie.

---

## 10. Avisos importantes

- **Uma vez só:** não deixe o assistente rodando **ao mesmo tempo** no PC e na
  VPS com o mesmo número — as duas instâncias responderiam em duplicidade.
  Feche o app do Windows quando usar a VPS (é o caminho normal: testa no PC,
  depois migra pra VPS).
- **Celular:** o WhatsApp exige que o aparelho conecte a cada **14 dias**.
  Enquanto o serviço estiver ativo isso acontece sozinho. Se você parar a VPS
  por mais de 2 semanas, será preciso escanear o QR de novo.
- **Expiração do plano grátis:** ~120 dias (site AlaVPS). Faça backup do
  `data/` antes; se você assinar um plano pago, os dados são preservados.
- **Limite de recursos:** sem mineração, sem spam (regra de fair-use deles).
- **Risco de banimento:** automatizar WhatsApp sempre carrega risco — mesmo
  usando o bot no notebook. Mantenha conversas naturais (o prompt já trabalha
  nisso) e evite disparos em massa.

---

## 11. Problemas comuns

| Sintoma | Causa / solução |
|---|---|
| `systemctl status` mostra `failed` | `journalctl -u link-zap -n 50` e leia o erro |
| Página não abre no túnel | Serviço parado? `systemctl start link-zap`. Túnel aberto? Porta 8123 ok? |
| QR não aparece | Espere 30s e recarregue; veja os logs; clique em Conectar de novo |
| Ficou "connecting" pra sempre | Reinicie (`systemctl restart link-zap`); se persistir, pare e apague `data/sessions/ID_DO_ZAP` para gerar sessão nova |
| "port already in use" | Outro processo na 8123: mude `LINK_HTTP_PORT` na unit + `systemctl daemon-reload && systemctl restart link-zap` |
| O serviço liga mas não responde mensagens | Veja se o zap está `ready` na página e se `autoReply` está ligado no `zaps.json` |
| Setup falhou nos testes | **Nada foi instalado de propósito.** Rode `npm test` na VPS e me mande a saída — os mesmos testes rodam em qualquer SO |

---

## 12. Validação (opcional, com Docker no Windows)

O projeto inclui um teste real de Linux via Docker:

```powershell
powershell -File deploy\test-linux.ps1
```

Ele builda uma imagem Ubuntu com Electron/Xvfb, roda **todos os testes dentro
do Linux** e faz um smoke test subindo o app headless e batendo no
`/status`. Requer o Docker Desktop funcionando. Sem Docker, os mesmos testes
rodam automaticamente no `setup.sh` (passo 5) direto na VPS.
