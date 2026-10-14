# Assistente do Zap no GitHub Actions — 24h sem ligar o PC (R$0, sem cartão)

O bot roda 24/7 nos runners gratuitos do GitHub Actions. Cada execução dura
~5h15 e **dispara a próxima sozinha** (cadeia); um cron de segurança
ressuscita a cadeia se ela morrer. A sessão do WhatsApp, as configs e os
históricos ficam num **repo privado** de dados que é clonado no início e
enviado de volta a cada 60s — o PC pode desligar.

**Custo:** R$0 (exige repo **público** — runners públicos são ilimitados e
grátis; repo privado teria só 2.000 min/mês, o que não dá 24/7).
**IA:** grátis (Gemini free / OpenRouter free / Groq — chaves suas).

> **AVISO DE ORDEM:** rotacione as chaves (passo 1) ANTES de deixar o repo
> público. O histórico de commits já contém as chaves antigas.

---

## Arquitetura (resumo)

| Peça | Onde vive |
|---|---|
| Código + workflows (`.github/workflows/zap-bot.yml`) | Repo **público** `Link-do-Zap` |
| Sessão do zap, `zaps.json`, `providers.json`, treinos | Repo **privado** `linkzap-dados` (exemplo) |
| Cadeia | Run N → aos ~90s dispara run N+1 (PAT) → para aos ~5h15 → dispara N+2 → ... |
| Backup | `monitor.sh` commita `data/` no repo privado a cada 60s (15s se código de pareamento mudou) |
| Redes de segurança | cron `*/15` recria a run se a cadeia morrer; `heartbeat.txt` diário mantém o cron ativo (GitHub desliga cron após 60 dias sem atividade) |
| Parada | Desative o workflow na aba Actions **ou** crie `STOP` no repo de dados |

Quedas: ~1–4 min a cada ~5h30 (troca de run). Mensagens nesse intervalo não
somem — o WhatsApp reentrega quando a sessão volta.

---

## 1. Rotacionar as chaves (ANTES de tudo)

As chaves antigas estão no histórico do git. Crie chaves novas e matas as velhas:

1. **OpenRouter:** <https://openrouter.ai/settings/keys> → Create Key.
2. **Google AI Studio:** <https://aistudio.google.com/apikey> → Create API key.

Depois, no app Windows (tela **Provedores**), cole as chaves novas nos
provedores "OpenRouter" e "Google AI Studio".

## 2. Repo privado de dados

1. No GitHub: **New repository** → nome `linkzap-dados` → **Private** (sem README).
2. No Windows, na pasta do projeto:

```powershell
.\deploy\actions\push-data.ps1 -DataRepo SEU_USUARIO\linkzap-dados
```

Ele clona o repo em `.\data` (ignorado pelo repo público), copia
`zaps.json`, `providers.json`, `trainings.json` e `trainings\`, commita e
dá push. Rode de novo sempre que mudar configs no app Windows.

> A pasta `sessions\` **não** vai junto por padrão — o pareamento acontece
> no servidor (passo 6). Para migrar um vinculo ja existente use
> `-IncludeSessions`.

## 3. Tokens de acesso (PATs)

**PAT da cadeia (`BOT_PAT`)** — Settings → Developer settings → Personal
access tokens → **Fine-grained tokens** → Generate:

- Resource owner: sua conta
- Repository: apenas `Link-do-Zap`
- Permissions: **Contents: Read and write** + **Actions: Read and write**
- Expiration: 1 ano (anote pra renovar — se expirar, a cadeia cai no cron)

**PAT dos dados (`DATA_PAT`)** — mesmo caminho:

- Repository: apenas `linkzap-dados`
- Permissions: **Contents: Read and write**

## 4. Secrets do repo público

Em `Link-do-Zap` → Settings → Secrets and variables → **Actions** → New:

| Secret | Valor |
|---|---|
| `DATA_REPO` | `SEU_USUARIO\linkzap-dados` |
| `DATA_PAT` | o PAT `DATA_PAT` do passo 3 |
| `BOT_PAT` | o PAT `BOT_PAT` do passo 3 |
| `OPENROUTER_API_KEY` | chave nova da OpenRouter |
| `GOOGLE_AI_KEY` | chave nova do Google AI Studio |

> As chaves de IA são um plano B: o servidor usa principalmente o
> `providers.json` do repo privado; o secret só entra quando o provedor
> está salvo sem chave.

## 5. Deixar o repo público (só no final)

`Link-do-Zap` → Settings → Danger Zone → **Change visibility → Public**.

O código é aberto — por isso as chaves nunca podem voltar a ser gravadas nele.

## 6. Primeira execução e pareamento

1. Abra a aba **Actions** → `zap-bot` → **Run workflow** → (deixe 310) → Run.
2. Aguarde o passo "Boot check" (~2 min). O app sobe e, como ainda não há
   sessão, **gera um código de pareamento** automaticamente (`[AUTO-PAIR]`).
3. Abra no repo **privado** `linkzap-dados` → arquivo **`pairing-codes.json`**
   → Refresh até aparecer `{ "ID_DO_ZAP": { "code": "XXXX-XXXX" } }`.
4. No celular: WhatsApp → **Aparelhos conectados** → **Conectar aparelho** →
   **Conectar com número** → digite o código. (Ele renova a cada ~3 min;
   se expirar, atualize o arquivo e use o código novo.)
5. O log da run vira `ready` e o `sessions/` é pro commit do backup.
   A partir daí **toda run seguinte reconecta sozinho** — sem QR, sem PC.

> O código **não aparece nos logs** (eles são públicos): `LINK_HIDE_CODES=1`
> mantém ele só no arquivo privado.

## 7. Operação do dia a dia

| Quero... | O que fazer |
|---|---|
| Ver o bot rodando | Actions → run mais recente → step "Monitor" (logs ao vivo) |
| Ver se conectado | Mesmo log: linhas `[AUTO]` / `ready` / `[STATUS] {...}` |
| Reiniciar agora | Actions → run atual → **Cancel** (a run pendente assume na sequência) |
| **Parar** | Actions → `zap-bot` → ⋯ → **Disable workflow** (ou crie `data/STOP` e push — a cadeia morre sozinha) |
| **Retomar** | **Enable workflow** + Run workflow |
| Mudar configs | Edite no app Windows → `push-data.ps1` → (reinicie a run) |
| Ver histórico de conversas | Repo privado: `data/conversations.json` |
| Backup local | `git clone` do repo privado (ou baixe via GitHub) |

**Limpeza de avisos:** falhas de run geram e-mail do GitHub. Se a cadeia
parar (ex.: PAT expirado), o cron tenta a cada 15 min e cada tentativa
aparece como run vermelha — corrija e limpe.

## 8. Atualizar o código

```powershell
npm test                 # deve fechar com TODOS OS TESTES PASSARAM
git add -A; git commit -m "descricao"; git push
```

A `ci` roda os testes no push. O código novo entra nas runs em **até ~2
ciclos** (a run já na fila usa o commit do momento em que foi disparada).

## 9. Limites e riscos

- **6h/execution** — por isso a cadeia troca de run antes (5h15).
- **Repo precisa ser público.** Tornou privado → 2.000 min/mês → bot morre.
- **GitHub muda regras** de Actions grátis no futuro? Possível — mesmo risco
  de qualquer tier gratuito. Backup semanal do repo privado é sua rede.
- **PAT expira** (1 ano) → renove os 2 secrets; enquanto isso o cron segura.
- **Parado >14 dias** → WhatsApp pede pareamento de novo (passo 6).
- **Risco de ban** do WhatsApp é o mesmo de sempre: conversas naturais,
  sem disparo em massa (o prompt já trabalha nisso).
- **ChatBox / janela gráfica** não existe no servidor (igual ao VPS): dá pra
  ver logs e status; campanhas em andamento continuam e retomam sozinhas.
- **Repo de dados cresce** (commits de backup a cada 60s). Se passar de
  ~200 MB, pare o workflow e faça um snapshot:

```powershell
cd data
git checkout --orphan tmp
git add -A; git commit -m "snapshot"
git branch -D main; git branch -m main
git push --force origin main
cd ..
# reative o workflow
```

## 10. Problemas comuns

| Sintoma | Causa / solução |
|---|---|
| Run falha em "Clona repo de dados" | Secret `DATA_REPO`/`DATA_PAT` ausente ou PAT sem Contents write |
| "App morreu no boot" | Veja `docker logs` na run; quase sempre: `zaps.json`/`providers.json` inválidos ou sem zap |
| `[AUTO-PAIR]` mas `pairing-codes.json` não atualiza | Demora até 15s (push urgente); confira o step Monitor no log |
| Código expirou antes de você digitar | Normal: renova a cada ~3 min — atualize o arquivo e use o último |
| Run vermelha `dispatch HTTP 401/403` | `BOT_PAT` expirou ou permissões erradas (precisa Actions: write) |
| Bot caiu e não volta | Actions ve se há run; se tudo parou: **Run workflow** manual (o cron volta sozinho em ≤15 min) |
| `Data/` apareceu no repo público | Nunca deve acontecer (`data/` está no `.gitignore`); se acontecer, remova com `git rm -r --cached data` e force push antes de tornar público |
| Cadeia parou de disparar | Veja step "Dispara proxima execucao" — se `HTTP 422`, o workflow está desativado ou a branch mudou |
| Ci (npm test) vermelha | Quebra no push; o zap-bot não é afetado até você mergear correção |
