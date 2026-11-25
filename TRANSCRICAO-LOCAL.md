# Transcrição local de áudio (whisper.cpp)

Transcrição dos áudios do WhatsApp feita **na própria VPS**, sem API, sem
créditos, sem tokens e sem cota. Um único modelo carregado atende todos os
clientes.

```
WhatsApp --> download + decrypt --> validação --> FFmpeg (WAV 16 kHz mono)
         --> cache SHA-256 --> fila justa (1 por vez) --> whisper.cpp
         --> pós-filtro de texto --> IA --> resposta no WhatsApp
```

## 1. Por que whisper.cpp

| Opção | RAM em uso | Disco | Observação |
|---|---|---|---|
| **whisper.cpp (tiny INT8)** | ~200–400 MB | ~75 MB modelo + binário | escolhido: C++, sem runtime extra |
| faster-whisper (Python) | 400–600 MB+ | ~2 GB de dependências | inviável em 2 GB com Electron + Chromium |
| faster-whisper (CTranslate2) | ~350 MB | ~500 MB | depende de Python e de download de modelo |

A VPS alvo é **2 GB de RAM / 1 vCPU / 50 GB**. O bot (Electron + Chromium do
WhatsApp) já consome a maior parte; o motor de STT precisa caber no resto.

O modelo `tiny` multilingual é o único que deixa margem confortável em 1 vCPU.
Se a qualidade não bastar, `base` é o próximo passo — mas só depois de medir
(ver seção 7), porque dobra o consumo e o tempo.

## 2. Arquitetura

```
src/core/stt/
  config.js           variáveis LINK_STT_* com defaults para 2 GB / 1 vCPU
  audio-processor.js  FFmpeg -> WAV 16 kHz mono, duração, volume médio, SHA-256
  cache.js            cache em disco por sha256+modelo+idioma (só texto)
  gate.js             admissão justa: 1 por vez, 1 por Zap, round-robin, aging
  resource-guard.js   pausa a admissão com pouca RAM/disco/load
  metrics.js          contadores persistidos + percentis e taxas em memória
  engine-http.js      cliente do whisper-server (modelo carregado 1x)
  engine-cli.js       whisper-cli por tarefa (benchmark / plano B)
  engine.js           seletor de motor (local/cli, preparado para remoto)
  manager.js          orquestra validação, cache, guarda, fila, motor, fallback
  index.js            montagem única (wiring) usada pelo main.js
```

Pontos de integração:

- `main.js` cria o sistema **uma vez por processo** (`getSttSystem()`), no boot e
  antes do primeiro áudio. Nada de instância por cliente.
- `src/core/audio/pipeline.js` continua sendo a **única fila persistente**
  (`data/audio-tasks.json`). O STT não cria uma segunda fila.
- O scheduler de download passou a cobrir **só o download**; a transcrição tem
  o seu próprio controle (`SttGate`), então uma tarefa esperando o modelo não
  ocupa a vaga de download de outro cliente.
- `LINK_STT_ENGINE=api` restaura exatamente o comportamento antigo.
- `LINK_STT_CANARY_ZAPS=id1,id2` libera o motor local só para esses Zaps.
- A conversão final usa um WAV temporário em `data/stt/tmp/` para garantir
  cabeçalhos RIFF válidos; o arquivo é apagado ao final de cada tarefa.

### Isolamento entre clientes

Cada chamada carrega `zapId`, `msgId` e `msgKey`; o texto retorna para a mesma
tarefa que o pediu. Não existe estado global de "último texto". O cache é
endereçado por conteúdo: dois clientes que recebam **exatamente o mesmo áudio**
compartilham o texto (é o mesmo conteúdo), mas o resultado nunca é entregue a
uma tarefa de outro Zap.

## 3. Instalação na VPS

```bash
cd /opt/assistente-zap
sudo bash scripts/install-stt.sh            # tiny (padrão)
sudo LINK_STT_MODEL=base bash scripts/install-stt.sh
```

O script é idempotente e **não derruba o bot se falhar**: compila o
`whisper.cpp`, baixa o modelo, grava o `.env`, instala o serviço systemd e faz um
teste real de inferência (HTTP 200).

O que ele cria:

| Caminho | Conteúdo |
|---|---|
| `vendor/whisper.cpp/build/bin/whisper-server` | servidor que mantém o modelo na RAM |
| `vendor/whisper.cpp/build/bin/whisper-cli` | modo alternativo/benchmark |
| `models/ggml-tiny.bin` | modelo (~75 MB) |
| `data/stt/tmp/` | WAVs temporários (apagados por tarefa) |
| `data/stt/cache/` | transcrições em texto (LRU + TTL) |
| `data/stt/metrics.json` | contadores acumulados |
| `/etc/systemd/system/assistente-zap-stt.service` | serviço do motor |

Limites do serviço (`deploy/assistente-zap-stt.service`):

```
Nice=10  CPUQuota=70%  MemoryHigh=550M  MemoryMax=700M
MemorySwapMax=256M  OOMScoreAdjust=500  IOWeight=50
```

Se o kernel precisar matar algo, mata o worker — nunca o bot ou o WhatsApp.

## 4. Configuração (`.env`)

```bash
# motor: local | remote | cli | api   (api = comportamento antigo)
LINK_STT_ENGINE=local
LINK_STT_MODEL=tiny
LINK_STT_LANG=pt
LINK_STT_THREADS=1
LINK_STT_CONCURRENCY=1
LINK_STT_MAX_QUEUE_WAIT_MS=90000
LINK_STT_JOB_TIMEOUT_BASE_MS=30000
LINK_STT_JOB_TIMEOUT_FACTOR=3
LINK_STT_JOB_TIMEOUT_MAX_MS=300000
LINK_STT_MIN_FREE_MB=180
LINK_STT_MIN_FREE_DISK_MB=1024
LINK_STT_CACHE_MB=128
LINK_STT_CACHE_TTL_H=168
LINK_STT_FALLBACK_API=0
LINK_STT_WORKER_URL=http://127.0.0.1:8191
```

Notas:

- `LINK_STT_THREADS` acima de 1 não deixa a transcrição mais rápida em 1 vCPU;
  só rouba CPU do bot. Meça antes de mudar.
- `LINK_STT_CONCURRENCY` acima de 1 multiplica o pico de RAM do worker.
- Timeout por tarefa = `base + fator × duração`, limitado ao máximo. Áudio de
  5 min não morre no timeout fixo antigo.
- `LINK_STT_FALLBACK_API=1` usa a API externa **apenas** quando o motor local
  está fora do ar. Áudio inválido ou sem fala nunca gasta API.
- `LINK_STT_REMOTE_URL=https://outra-vps:8191` aponta para um worker remoto
  (escala futura), preservando o mesmo contrato.

## 5. Operação

```bash
systemctl status assistente-zap-stt
journalctl -u assistente-zap-stt -f
systemctl restart assistente-zap-stt
systemctl show assistente-zap-stt -p MemoryCurrent
```

Diagnóstico pela API (token do painel):

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  https://seu.dominio/api/v1/transcription/status | jq .transcription
```

Campos úteis: `enabled`, `engine.healthy`, `engine.lastError`, `config.model`,
`queue.active`, `queue.waiting`, `queue.byZap`, `cache.files`, `cache.mb`,
`totals.received/completed/failed/cached`, `timing.stt.p50/p95`,
`timing.queue.p50/p95`, `rates.arrivalPerMin`, `resources`. O mesmo bloco vai
em `/api/v1/server/status` e aparece como a linha **Áudio** no balão de status.

### Áudio corrompido, vazio ou sem fala

- Falha de download/validação: classificada (`auth`, `expired`, `corrupt`,
  `limit`) e vai para a DLQ sem repetir 5 vezes à toa.
- Silêncio/ruído (volume médio abaixo de `LINK_STT_SILENCE_DB`, padrão −55 dB):
  não chega ao modelo e o cliente recebe "não consegui ouvir".
- Texto vazio devolvido pelo modelo: tratado como falha do áudio, não como
  resposta.
- Nada disso derruba o serviço: o manager converte em erro de tarefa.

### Reinício

- Bot reiniciado: `recoverAudioTasks` retoma o que estava `QUEUED`/`RETRYING`.
  Tarefa em `AI_PROCESSING` vai para a DLQ (evita resposta duplicada).
- Worker reiniciado: as próximas chamadas recebem `defer` e a tarefa volta para
  `RETRYING` **sem consumir tentativa** (até `LINK_STT_MAX_DEFERS`, padrão 10).
- Contadores de métricas sobrevivem (arquivo atômico a cada 30 s).

## 6. Testes automatizados

```bash
node test/stt.js     # 20 casos: config, M4A, cache, gate, guarda, métricas,
                     # HTTP/CLI, manager, rajada, canary, fallback e defer
npm test             # suíte completa (inclui test/stt.js)
```

Os testes não dependem do modelo, do FFmpeg nem da VPS: motor e conversão são
injetados. Eles cobrem o contrato, não a qualidade da transcrição.

## 7. Medição real (obrigatória antes de prometer número)

Nada aqui é estimado. Rode na VPS, com áudios reais em pt-BR:

```bash
mkdir -p /opt/assistente-zap/benchmark-audio
# copie 5–10 áudios reais (curto, médio, longo, com ruído, com sotaque)
sudo bash scripts/stt-benchmark.sh
```

Saída: tempo por áudio, **RTF** (tempo real fator), chars, RSS do worker, CPU
consumida e vazão. CSV em `benchmark-stt-<data>.csv`.

### Resultado medido nesta VPS (25/11/2026)

Benchmark com 8 áudios M4A reais, total de 207,78 s de fala, modelo `tiny`,
1 thread e 1 inferência por vez:

- RTF médio: **0,10** (10% do tempo real);
- tempo médio por áudio: **2,55 s**;
- CPU do worker: **14,38 s** para 20,41 s de parede;
- RSS final do worker: **303 MB** (limite systemd: 700 MB);
- falhas: **0**;
- vazão medida: **23,5 áudios/min**.

CSV: `/opt/assistente-zap/benchmark-stt-20261125-114255.csv`.

Para comparar modelos, um de cada vez (nunca dois carregados):

```bash
sudo LINK_STT_MODEL=tiny bash scripts/install-stt.sh && sudo bash scripts/stt-benchmark.sh
sudo LINK_STT_MODEL=base bash scripts/install-stt.sh && sudo bash scripts/stt-benchmark.sh
```

### Carga pelo caminho real do bot

```bash
node test/stress/stt-load.js --audio amostra.ogg --jobs 50 --zap A,B,C
node test/stress/stt-load.js --audio amostra.ogg --jobs 20 --concurrency 1
```

Esse script usa o manager de verdade (FFmpeg + cache + fila + motor) e imprime
p50/p95 por tarefa, tempo de fila, tempo de STT, cache hits, vazão e falhas.
Variar `--jobs` de 1 a 100 cobre o cenário de rajada.

### Stress medido nesta VPS (25/11/2026)

50 tarefas com o mesmo M4A real, 3 Zaps, concorrência 1:

- concluídas: **50/50**, falhas **0**;
- parede total: **208,7 s**;
- STT p50/p95: **3,97 s / 4,29 s**;
- fila p50/p95: **100,6 s / 196,0 s**;
- RAM disponível ao final: **749 MB**;
- load1 ao final: **1,05**.

A fila longa é esperada em 1 vCPU: o sistema serializa FFmpeg e inferência
para não criar um processo por áudio nem derrubar o WhatsApp.

## 8. Limites conhecidos

- **Qualidade**: `tiny` erra mais em áudio ruidoso, sotaque forte e nomes
  próprios. Ele é o que cabe em 2 GB com folga; `base` é o próximo passo.
- **1 vCPU**: uma transcrição por vez. Com 20 áudios na fila, o último espera.
  A fila é justa, mas o tempo total é o somatório.
- **Idioma**: padrão `pt`. `LINK_STT_LANG=auto` existe, mas custa uma passada
  extra de detecção.
- **Cache**: guarda texto, nunca áudio. Limite `LINK_STT_CACHE_MB` com LRU.
- **Sem GPU**: a VPS alvo não tem. Se um dia houver, o caminho é trocar o motor
  (`engine.js`) sem mudar fila, backend nem fluxo de mensagens.

## 9. Solução de problemas

| Sintoma | Verificar |
|---|---|
| `engine.healthy=false` | `systemctl status assistente-zap-stt`, `journalctl -u assistente-zap-stt -n 80` |
| Áudios parados em `RETRYING` | worker fora do ar ou `LINK_STT_MIN_FREE_MB` acima da RAM livre |
| `defer` constante | fila grande / `LINK_STT_MAX_QUEUE_WAIT_MS` baixo / CPU saturada |
| Texto vazio em áudio com fala | volume baixo, modelo `tiny`; testar `base` |
| Worker morto por OOM | reduzir concorrência, conferir `MemoryMax`, aumento de swap |
| Transcrição "antiga" aparecendo | cache: mesmo conteúdo já transcrito antes (esperado) |
| Quer voltar ao comportamento antigo | `LINK_STT_ENGINE=api` e reiniciar |

Rollback completo em um passo:

```bash
sudo sed -i 's/^LINK_STT_ENGINE=.*/LINK_STT_ENGINE=api/' /opt/assistente-zap/.env
sudo systemctl restart assistente-zap
```

O serviço `assistente-zap-stt` pode continuar rodando sem uso, ou ser parado
com `sudo systemctl disable --now assistente-zap-stt`.
