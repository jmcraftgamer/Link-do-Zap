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

### 3.1 HTTPS (obrigatório)

Com HTTP puro a senha do painel viaja sem criptografia. Compre um domínio,
crie um registro **A** apontando para o IP da VPS e rode:

```bash
DOMAIN=zap.seudominio.com EMAIL=voce@email.com sudo bash scripts/setup-https.sh
```

O script instala o `certbot`, emite o certificado Let's Encrypt, liga o redirect
HTTP→HTTPS, abre a porta 443 e deixa a renovação automática ativa.

Depois disso, use no Setup: `LINK_API_URL=https://zap.seudominio.com`.

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

## 5. Dados: a VPS começa vazia

Não há nada a migrar. Todos os Zaps/dados do seu PC são de teste; o servidor
começa com `data/` vazia e você cadastra/pareia os Zaps do zero pelo painel.

O que o servidor cria sozinho no primeiro boot:

| Arquivo | Conteúdo |
|---|---|
| `data/backend-auth.json` | hash da senha e segredo dos tokens |
| `data/pairing-codes.json` | códigos de pareamento gerados |
| `data/sessions/<zapId>/` | sessão do WhatsApp de cada Zap |
| `data/zaps.json`, `contacts.json`, ... | criados conforme o uso |

> Nunca copie `.env`, `backend-auth.json` ou `data/sessions/` do PC: são
> específicos da máquina e da sessão de WhatsApp.

---

## 6. Apontar o Setup para o servidor

**Pela interface (mais simples):** abra o Setup → card **“Servidor na VPS (API)”**
→ informe `https://seu.dominio` → entre com a senha admin. A tela salva sozinha em
`data/remote-server.json`.

**Por variável de ambiente** (antes de abrir o app):

```
LINK_API_URL=https://seu.dominio
LINK_API_PREFIX=/api/v1
```

Depois disso, **cadastre e pareie os Zaps** no painel remoto (o servidor está com
`LINK_AUTO_PAIR=1`, então o código aparece no painel). O passo a passo está em
**[MANUAL-OPERACAO.md](MANUAL-OPERACAO.md)**.

---

## 7. Validar o serviço

```bash
curl -s https://seu.dominio/health
systemctl status assistente-zap
journalctl -u assistente-zap -n 80 --no-pager
```

Checklist:

- [ ] `/health` responde OK
- [ ] Login no Setup funciona por HTTPS
- [ ] O Zap de teste aparece no painel
- [ ] O código de pareamento é gerado (Zap com telefone cadastrado)
- [ ] Envio de mensagem de texto funciona
- [ ] Áudio é gerado (ffmpeg instalado)
- [ ] Status/terminal atualizam ao vivo (WebSocket `/ws`)
- [ ] Backup diário agendado e teste de restauração passou

---

## 8. Rotina de operação

```bash
# Logs ao vivo
journalctl -u assistente-zap -f

# Reiniciar
systemctl restart assistente-zap

# Backup manual (para o serviço, copia e volta a subir)
bash /opt/assistente-zap/scripts/backup.sh

# Backup criptografado (recomendado: os dados têm conversas de clientes)
BACKUP_PASSPHRASE='frase-longa-e-secreta' bash /opt/assistente-zap/scripts/backup.sh

# Restaurar um backup (o .enc pede a mesma frase)
bash /opt/assistente-zap/scripts/restore.sh /opt/assistente-zap/backups/arquivo.tar.gz
BACKUP_PASSPHRASE='frase-longa-e-secreta' bash /opt/assistente-zap/scripts/restore.sh /opt/assistente-zap/backups/arquivo.tar.gz.enc
```

Backup automático: o `install.sh` já agenda às **03:00**, com criptografia e
parando o serviço durante a cópia (`/etc/cron.d/assistente-zap-backup`).

Para verificar se o mecanismo funciona (cria, decifra, extrai e valida):

```bash
BACKUP_PASSPHRASE="$(grep '^BACKUP_PASSPHRASE=' /opt/assistente-zap/.env | cut -d= -f2-)" \
  bash /opt/assistente-zap/scripts/verify-backup.sh
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
| `scripts/backup.sh` | backup dos dados (criptografia opcional via `BACKUP_PASSPHRASE`) |
| `scripts/restore.sh` | restauração de um backup (`.tar.gz` ou `.tar.gz.enc`) |
| `scripts/verify-backup.sh` | testa o mecanismo: cria, decifra, extrai e valida |
| `scripts/setup-https.sh` | domínio + certificado Let's Encrypt + redirect HTTPS |
| `.env.example` | referência de todas as variáveis do backend |
| `backend/electron-entry.js` | ponto de entrada do modo servidor |

Não há PM2 neste projeto: o serviço é gerenciado por `systemctl`.

---

## 11. Operar o serviço

O dia a dia (cadastrar cliente, parear, re-parear, rotina, queda de Zap, backup
e monitor) está em **[MANUAL-OPERACAO.md](MANUAL-OPERACAO.md)**.

Modelo de contrato de prestação de serviço: **[CONTRATO-MODELO.md](CONTRATO-MODELO.md)**
(revisar com advogado antes de usar).
