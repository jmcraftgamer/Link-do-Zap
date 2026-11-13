# Deploy na VPS (Hostinger) — Assistente do Zap

Guia único e definitivo para colocar o sistema no ar.

**Como funciona:** o **Setup** (app no seu PC) é só o painel — ele conversa com o
**backend** que roda 24h na VPS. WhatsApp, IA, mensagens, áudio, vencimento e
memória ficam todos no servidor. Você pode fechar o PC que o serviço continua.

```
PC (Setup)  ──HTTP──►  VPS: Nginx :80  ──►  backend :3000 (Electron headless + Xvfb)
                                              └─ WhatsApp (wwebjs) + dados em /opt/assistente-zap/data
```

---

## 0. Pré-requisitos

- VPS **Hostinger KVM 2**: 2 vCPU, 8 GB RAM, 100 GB NVMe (comporta ~5–7 Zaps com folga).
- **Ubuntu 24.04 LTS** (ou 22.04 / Debian 12).
- Acesso **root** por SSH (senha ou chave).
- Repositório: `https://github.com/jmcraftgamer/Link-do-Zap.git`.
- No seu PC, **envie os commits antes** (o servidor vai puxar do GitHub):

```powershell
git push origin main --tags
```

> Se o repositório for privado, use um token: `https://SEU_TOKEN@github.com/jmcraftgamer/Link-do-Zap.git`
> ou configure uma deploy key no GitHub. Sem isso, use a Opção B do passo 2.

---

## 1. Contratar e preparar a VPS

1. Painel Hostinger → **VPS** → escolha o plano KVM 2.
2. Template/SO: **Ubuntu 24.04 LTS** (limpo, sem painel).
3. Defina a **senha de root** ou cadastre sua **chave SSH**.
4. Anote o **IP** da VPS.
5. Teste a conexão:

```bash
ssh root@SEU_IP
```

> Não é preciso abrir porta no painel da Hostinger além da 22 (SSH) e 80 (HTTP).
> O `install.sh` já libera 22/80 no `ufw` do próprio servidor.

---

## 2. Colocar o código no servidor

### Opção A (recomendada) — clonar do GitHub

```bash
apt-get update && apt-get install -y git
git clone https://github.com/jmcraftgamer/Link-do-Zap.git /opt/assistente-zap
```

### Opção B — enviar do PC (sem GitHub)

No PowerShell, dentro da pasta do projeto:

```powershell
tar -czf "$env:TEMP\assistente-zap.tar.gz" --exclude=node_modules --exclude=.git --exclude=data --exclude=dist --exclude=build .
scp "$env:TEMP\assistente-zap.tar.gz" root@SEU_IP:/tmp/
```

No servidor:

```bash
mkdir -p /opt/assistente-zap
tar -xzf /tmp/assistente-zap.tar.gz -C /opt/assistente-zap
# Corrige quebras de linha CRLF que o Windows possa ter colocado nos scripts:
sed -i 's/\r$//' /opt/assistente-zap/scripts/*.sh /opt/assistente-zap/deploy/*.service /opt/assistente-zap/deploy/*.conf
chmod +x /opt/assistente-zap/scripts/*.sh
```

---

## 3. Rodar o instalador

```bash
cd /opt/assistente-zap
sudo bash scripts/install.sh
```

O script é **idempotente** (pode rodar de novo para atualizar sem apagar dados) e faz:

| Etapa | O que acontece |
|---|---|
| Pacotes | Xvfb, ffmpeg, libs do Chromium/Electron |
| Node | instala Node.js 20 se não houver |
| Usuário | cria o usuário de serviço `zap` |
| Fuso | `America/Sao_Paulo` (vencimento/carência dependem disso) |
| Swap | cria 4 GB (protege os 8 GB de RAM com vários Zaps) |
| Código | clona do `REPO_URL` se a pasta ainda estiver vazia |
| Dependências | `npm ci` (inclui Electron, que é devDependency) |
| `.env` | gera senha admin e `JWT_SECRET` aleatórios; **preserva** um `.env` existente |
| systemd | instala e habilita `assistente-zap.service` |
| Nginx | publica na porta 80 com proxy de `/api/v1` e do WebSocket `/ws` |
| Firewall | libera 22/80 (e a porta da API se `SKIP_NGINX=1`) |
| Health | espera `http://127.0.0.1:3000/health` responder |

Variações úteis:

```bash
SKIP_NGINX=1 bash scripts/install.sh     # API direto na porta 3000 (HOST=0.0.0.0)
SWAP_SIZE=8G bash scripts/install.sh     # swap maior
PORT=3000 NODE_MAJOR=20 bash scripts/install.sh
```

No fim ele imprime a URL do painel, o caminho do `.env` e os comandos de log/backup.

---

## 4. Senha do painel

```bash
grep '^ADMIN_PASSWORD=' /opt/assistente-zap/.env
```

Para trocar depois: edite `ADMIN_PASSWORD` no `.env` e reinicie:

```bash
nano /opt/assistente-zap/.env
systemctl restart assistente-zap
```

> O backend ajusta o hash automaticamente no boot. Se `ADMIN_PASSWORD` estiver
> vazio, ele gera uma senha aleatória e grava em `data/ADMIN_PASSWORD.txt`.

---

## 5. Migrar os dados do PC para a VPS

### 5.1 Copiar (do seu PC, dentro da pasta do projeto)

```powershell
$IP = "SEU_IP"
scp data/zaps.json data/contacts.json data/providers.json data/conversations.json data/trainings.json root@${IP}:/opt/assistente-zap/data/
scp -r data/trainings data/memorias root@${IP}:/opt/assistente-zap/data/
# Opcional (estado de mensagens automáticas e status do bot):
scp data/auto-msg-state.json data/bot-status.json root@${IP}:/opt/assistente-zap/data/
```

### 5.2 Ajustar permissões (no servidor)

```bash
chown -R zap:zap /opt/assistente-zap/data
chmod 600 /opt/assistente-zap/data/*.json
systemctl restart assistente-zap
```

### 5.3 O que **não** copiar (e por quê)

| Item | Motivo |
|---|---|
| `remote-server.json`, `server-repo.json` | configuração do modo cliente local; no servidor não se aplica |
| `.env`, `backend-auth.json`, `ADMIN_PASSWORD.txt` | o servidor gera os próprios segredos/senha |
| `link-no-whatsapp/`, `.wwebjs_cache/` | sessão do WhatsApp/Chromium — **pareie de novo** na VPS |
| `Cache/`, `Code Cache/`, `GPUCache/`, `DawnCache/`, `blob_storage/`, `Session Storage/`, `Local Storage/`, `Network/` | caches do navegador embutido |
| `qr-*.png`, `*.log` | QR antigos e logs de desenvolvimento |

> `providers.json` contém as **chaves de IA**. Copiá-lo já leva as chaves.
> Se preferir não migrá-las, copie o arquivo e recadastre as chaves no painel.

---

## 6. Apontar o Setup para o servidor

**Pela interface (mais simples):** abra o Setup → card **“Servidor na VPS (API)”**
→ informe `http://SEU_IP` → entre com a senha admin. A tela salva sozinha em
`data/remote-server.json`.

**Por variável de ambiente** (antes de abrir o app):

```
LINK_API_URL=http://SEU_IP
LINK_API_PREFIX=/api/v1
```

Depois disso, **pareie os Zaps** no painel remoto (QR ou código de pareamento —
o servidor está com `LINK_AUTO_PAIR=1`, então o código aparece no painel).

---

## 7. Validar o serviço

```bash
curl -s http://SEU_IP/health
systemctl status assistente-zap
journalctl -u assistente-zap -n 80 --no-pager
```

Checklist:

- [ ] `/health` responde OK
- [ ] Login no Setup funciona
- [ ] Os Zaps migrados aparecem no painel
- [ ] QR/código de pareamento é gerado
- [ ] Envio de mensagem de texto funciona
- [ ] Áudio é gerado (ffmpeg instalado)
- [ ] Status/terminal atualizam ao vivo (WebSocket `/ws`)
- [ ] Vencimento e carência batem (fuso `America/Sao_Paulo`)

---

## 8. Rotina de operação

```bash
# Logs ao vivo
journalctl -u assistente-zap -f

# Reiniciar
systemctl restart assistente-zap

# Backup manual (para o serviço, copia e volta a subir)
bash /opt/assistente-zap/scripts/backup.sh

# Restaurar um backup
bash /opt/assistente-zap/scripts/restore.sh /opt/assistente-zap/backups/arquivo.tar.gz
```

Backup automático diário às 3h (guarda os 7 últimos):

```bash
crontab -e
# adicione:
0 3 * * * BACKUP_STOP_SERVICE=1 /opt/assistente-zap/scripts/backup.sh >/var/log/zap-backup.log 2>&1
```

Atualizar o sistema depois de novos commits:

```bash
cd /opt/assistente-zap && git pull && npm ci && systemctl restart assistente-zap
```

---

## 9. Problemas comuns

| Sintoma | Causa provável | Solução |
|---|---|---|
| 502 Bad Gateway no Nginx | backend não subiu | `journalctl -u assistente-zap -n 120` |
| Backend morre no boot | falta de libs/display | confira `xvfb` instalado; rode `install.sh` de novo |
| Login recusado | senha diferente do `.env` | `grep ADMIN_PASSWORD .env` e reinicie |
| QR não aparece | pareamento automático desligado | `LINK_AUTO_PAIR=1` no `.env` |
| Erro de permissão em `data/` | arquivos copiados como root | `chown -R zap:zap data/` |
| Consumo alto de RAM | muitos Zaps ativos | reduza Zaps ou aumente swap/plano |
| `npm ci` falha | `package-lock.json` divergente | `npm install` e faça commit do lock |
| Scripts não executam | CRLF vindo do Windows | `sed -i 's/\r$//' scripts/*.sh` |

---

## 10. Estrutura oficial de deploy

Este é o único caminho de produção (os rascunhos antigos de PM2 e os docs
duplicados foram removidos do repositório):

| Arquivo | Função |
|---|---|
| `scripts/install.sh` | instalação/atualização completa (idempotente) |
| `deploy/assistente-zap.service` | unit do **systemd** que roda o backend 24h |
| `deploy/nginx-assistente-zap.conf` | proxy HTTP + WebSocket na porta 80 |
| `scripts/backup.sh` | backup diário dos dados |
| `scripts/restore.sh` | restauração de um backup |
| `.env.example` | referência de todas as variáveis do backend |
| `backend/electron-entry.js` | ponto de entrada do modo servidor |

Não há PM2 neste projeto: o serviço é gerenciado por `systemctl`.
