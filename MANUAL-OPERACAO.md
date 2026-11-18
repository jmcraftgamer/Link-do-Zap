# Manual de operação

Como você (operador) cadastra, pareia e mantém os Zaps dos clientes.
O cliente **só usa o WhatsApp** — ele não acessa painel.

---

## 0. Papel de cada parte

| Quem | O que faz |
|---|---|
| **Você** | acessa o Setup (painel) apontando para o servidor, cria e gerencia os Zaps |
| **Servidor (VPS)** | roda o WhatsApp 24h, a IA, os áudios e guarda os dados |
| **Cliente** | pareia o número uma vez e usa o atendimento; pede ajustes a você |

---

## 1. Cadastrar um cliente novo

1. Abra o Setup apontando para o servidor (`https://seu.dominio`).
2. Vá em **Zaps → novo Zap**.
3. Preencha:
   - **Nome**: nome da empresa/cliente.
   - **Telefone**: número do WhatsApp **com DDI e DDD, só dígitos**.
     Exemplo Brasil: `5511999999999`.
   - Ícone (opcional).
4. Salve.

> O telefone é o campo mais importante: sem ele o servidor **não gera o código
> de pareamento**. Com `LINK_AUTO_PAIR=1`, o código é criado sozinho e gravado
> em `data/pairing-codes.json`; o painel exibe para você.

---

## 2. Parear o WhatsApp do cliente

No celular do cliente:

1. **WhatsApp → Configurações → Dispositivos conectados**
2. **Conectar um dispositivo**
3. **Conectar com número de telefone**
4. Digite o **código de 8 caracteres** que aparece no painel.

Aguarde o status mudar para **`ready`** no painel.

- Se o código expirar, gere outro no painel.
- Se o cliente não estiver com você, mande o código por WhatsApp; ele tem
  poucos minutos para usar.

---

## 3. Configurar o que o cliente quer

Com o Zap conectado:

1. **IA**: provedor, chave e modelo.
2. **Treinamento**: textos da empresa, tom de voz, o que pode e o que não pode
   responder.
3. **Mensagens automáticas** e horário de atendimento.
4. **Contatos**: lista e comportamento com números desconhecidos.
5. **Áudio**: teste uma resposta em áudio (confirma o `ffmpeg`).

Faça um teste real: mande uma mensagem de outro número e confira a resposta.

---

## 4. Re-parear (celular trocado, sessão caiu, número novo)

1. No painel, abra o Zap e use a opção de **gerar novo código** (o painel grava
   `connect-requests.json`, o servidor **apaga a sessão antiga** e cria outra).
2. O cliente repete o passo 2.

> Enquanto não re-parear, o Zap fica `disconnected` e não responde.

---

## 5. Rotina

| Frequência | O que conferir |
|---|---|
| **Diário** | status dos Zaps (`ready` / `disconnected`), erros no log |
| **Semanal** | espaço em disco (`df -h`), backups gerados, Zaps conectados |
| **Mensal** | atualizar o sistema, revisar treinamentos, acompanhar RAM |

Comandos úteis no servidor:

```bash
systemctl status assistente-zap          # servico no ar?
journalctl -u assistente-zap -n 100      # ultimos eventos
journalctl -u assistente-zap -f          # acompanhar ao vivo
df -h                                    # espaco em disco
free -h                                  # memoria
```

---

## 6. Quando um Zap cai

1. Veja o status no painel:
   - `disconnected` → sessão caiu ou celular sem internet.
   - `auth_failure` → sessão invalidada (cliente deslogou, trocou de aparelho).
2. Confira o log:

```bash
journalctl -u assistente-zap -n 150 --no-pager
```

3. `auth_failure` ou sessão expirada → **re-parear** (passo 4).
4. Se **todos** os Zaps caíram, verifique o serviço e `/health`:

```bash
curl -s https://seu.dominio/health
systemctl status assistente-zap
```

---

## 7. Monitor externo (servidor caiu)

O aviso interno não existe (o alerta ficará no seu app mobile). Enquanto isso,
use um monitor externo gratuito — ele avisa mesmo se o servidor inteiro cair:

1. Crie uma conta no **UptimeRobot** (ou similar).
2. Novo monitor **HTTP(s)**: `https://seu.dominio/health`
3. Intervalo: **5 minutos**.
4. Alerta: e-mail e/ou push no celular.

Quando o app mobile existir, ele pode consultar `GET /api/v1/server/status`
para mostrar o estado dos Zaps.

---

## 8. Backup e restauração

O `install.sh` já agenda um backup **diário às 03:00**, parando o serviço durante
a cópia e **criptografando** o arquivo.

- A frase de criptografia fica em `/opt/assistente-zap/.env` na variável
  `BACKUP_PASSPHRASE`. **Guarde-a fora da VPS** (gerenciador de senhas).
- Sem essa frase, o backup é inútil.

```bash
# backup manual
BACKUP_PASSPHRASE='a-frase-do-.env' bash /opt/assistente-zap/scripts/backup.sh

# restaurar
BACKUP_PASSPHRASE='a-frase-do-.env' bash /opt/assistente-zap/scripts/restore.sh /opt/assistente-zap/backups/arquivo.tar.gz.enc

# testar o mecanismo (cria, decifra, extrai e valida)
BACKUP_PASSPHRASE='a-frase-do-.env' bash /opt/assistente-zap/scripts/verify-backup.sh
```

> Faça um teste de restauração **antes** de entrar o primeiro cliente pagante.

---

## 9. Atualizar o sistema

```bash
cd /opt/assistente-zap
BACKUP_PASSPHRASE='a-frase-do-.env' bash scripts/backup.sh
git pull
npm ci
systemctl restart assistente-zap
```

Atualize fora do horário de atendimento.

---

## 10. Capacidade

Cada Zap abre um **Chromium próprio** (o WhatsApp Web inteiro). Medição real
com o mesmo Chrome do projeto:

| Item | Consumo |
|---|---|
| 1 Zap ocioso (só conectado) | **~150–190 MB** de RAM |
| 1 Zap ativo (conversas carregadas) | ~250–300 MB |
| Perfil em disco por Zap | ~26 MB (cresce com mídia) |
| Node + Electron + sistema | ~1 GB |

Com as otimizações já aplicadas (fila de conexão, reciclagem noturna e teto de
memória), **30 Zaps cabem numa VPS de 12 GB** com tráfego leve/moderado:

- **12 GB**: 30 Zaps, sem 30 contas recebendo áudio/IA ao mesmo tempo.
- **16 GB**: 30 Zaps com folga para pico.
- **8 GB**: até ~15 Zaps.

Sinais de hora de uma 2ª VPS: RAM acima de ~85% constante, swap sendo usado
todo dia, pareamento lento, demora no envio.

### Ajustes de capacidade (`.env`)

```bash
LINK_CONNECT_CONCURRENCY=2   # Chromium subindo ao mesmo tempo (padrao 2)
LINK_CONNECT_GAP_MS=2000     # intervalo entre inicios (ms)
LINK_RECYCLE_HOUR=4          # reciclagem diaria; "off" desativa
LINK_RECYCLE_GAP_MS=120000   # 2 min entre um Zap e o proximo
```

A **reciclagem noturna** reconecta um Zap por vez às 04:00 preservando a sessão
(não pede código de novo) para devolver a memória que o WhatsApp Web acumula
em execuções longas. Com 30 Zaps leva cerca de 1 hora.

### Ver a memória do servidor

```bash
curl -s https://seu.dominio/health | jq .resources
```

Retorna `ram` (total, livre, % em uso), `swap`, memória do processo, `loadavg`
e número de CPUs. O `/api/v1/server/status` (com token) traz o mesmo bloco —
é o que o app mobile futuro vai consumir para alertar.

### Áudio (transcrição)

O áudio do WhatsApp é baixado, descriptografado e enviado para Whisper
(OpenAI/Groq) ou Gemini. **Não roda nada localmente** — não há ffmpeg nem
modelo na VPS; só rede e memória.

O que segura o consumo de RAM:

- **O base64 do áudio não fica no histórico.** Ele existe só durante a
  transcrição e é liberado logo depois. A interface baixa a mídia sob demanda.
- **Fila de transcrição** (`LINK_TRANSCRIBE_CONCURRENCY`, padrão 2): no máximo
  dois áudios sobem para a IA ao mesmo tempo. Os demais esperam alguns segundos.
- **Timeout** (`LINK_TRANSCRIBE_TIMEOUT_MS`, padrão 60 s): provedor travado é
  abandonado e a próxima opção da lista assume, em vez de pendurar a conversa.

```bash
LINK_TRANSCRIBE_CONCURRENCY=2
LINK_TRANSCRIBE_TIMEOUT_MS=60000
```

Se chegar uma rajada de áudios, a resposta atrasa (fila), mas nada trava nem
consome memória proporcional ao número de áudios ao mesmo tempo.

---

## 11. O que não prometer ao cliente

- **Não é a API oficial do WhatsApp** — o número pode ser bloqueado.
- **Não há painel para o cliente** (por enquanto é você quem opera).
- **Suporte é você** — combine canal e horário no contrato.
- **Não há garantia de 100% de disponibilidade.**

Veja também `CONTRATO-MODELO.md` e `DEPLOY_VPS.md`.
