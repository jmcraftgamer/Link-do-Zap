# Auditoria Técnica Completa — Assistente do Zap / Link no WhatsApp

> Escopo: recebimento de áudio, recebimento de mensagens, envio de respostas, cálculo do tempo de digitação, sistema de conversas/memória, detecção de resposta do dono e de mensagens anteriores ao pareamento, saúde do app e do servidor 24h, e prontidão para comercialização.
>
> Método: leitura integral de `main.js`, `preload.js`, `src/js/*`, `deploy/**`, `.github/workflows/**`, `package.json`; execução de `npm test` (baseline) e análise estática de fluxo. **Nenhuma alteração de código foi feita.**

---

## 0. Resumo executivo

O projeto funciona bem no "caminho feliz" (um Zap, sessão pareada, mensagem de texto, IA respondendo), e a base de testes unitários está verde (184 testes / 7 suítes). Porém ele **não está pronto para venda** por três motivos estruturais:

1. **Risco de perda de dados e de sessão.** Configs corrompidas ou vazias são aceitas silenciosamente e o reconciliador do servidor **apaga sessões e treinamentos** de todos os Zaps. Um `zaps.json` vazio, um push ruim ou um arquivo travado por antivírus/OneDrive pode destruir a operação inteira de forma irreversível.
2. **O "servidor 24h" não é 24h nem é confiável.** Ele depende de GitHub Actions (com PAT que expira, limites de uso e risco de violação de termos), reinicia o WhatsApp a cada ciclo, faz backup do Chromium em execução, não tem healthcheck real (só "container rodando") e não faz shutdown gracioso em modo headless. Além disso, **novos Zaps na VPS podem nunca parear** por falta de `LINK_AUTO_PAIR=1` e por o painel não solicitar conexão ao servidor.
3. **O robô pode responder errado, não responder, ou responder pela metade.** Mensagens recebidas entre `authenticated` e `ready` são processadas mas o envio falha; mensagens anteriores ao pareamento nunca são lidas; a detecção de "dono já respondeu" falha em vários cenários; e o `message-guard` rejeita textos comerciais legítimos (`[Promoção]`, listas numeradas, `pix_copia_cola`), podendo trocar uma resposta de venda por uma mensagem de erro.

**Veredito:** arquitetura promissora, execução funcional, mas com **8 bloqueadores P0** e ~45 itens P1 antes de comercializar. O caminho mais curto para vender com segurança é: (a) blindar persistência/config, (b) trocar o runtime 24h para VPS + systemd/Docker com healthcheck real, (c) corrigir o ciclo de vida da sessão/mensagens, (d) resolver licenciamento/LGPD/termos.

### Matriz de risco

| Área | P0 | P1 | P2 | Risco dominante |
|---|---:|---:|---:|---|
| Persistência / configuração | 4 | 3 | 2 | Perda total de Zaps, sessões e treinamentos |
| Áudio | 1 | 3 | 2 | Áudio nunca transcrito em vários provedores; fila travada |
| Recebimento de mensagens | 2 | 4 | 3 | Mensagens perdidas ou respondidas fora de hora |
| Envio / resposta | 1 | 6 | 3 | Resposta parcial, duplicada ou no chat errado |
| Tempo de digitação | 0 | 2 | 2 | "digitando" por 13 min; fila travada |
| Conversas / memória | 1 | 4 | 3 | Memória em fuso errado; histórico divergente |
| Dono respondeu / pré-pareamento | 1 | 4 | 1 | Robô fala por cima do dono |
| Servidor 24h / deploy | 3 | 7 | 4 | Bot fora do ar sem ninguém perceber |
| Segurança / app | 2 | 5 | 6 | Vazamento de chaves; ações destrutivas por prompt |
| Comercialização | 2 | 4 | 3 | Suspensão por termos; ausência de licença/LGPD |

---

## 1. Recebimento de áudio

**A1 — [P0] Transcrição só funciona de fato em OpenAI, Groq, Google e OpenRouter**
- Onde: `src/js/ai-responder.js:567-597` e `:613-616`.
- Causa: o roteamento manda para Whisper tudo que não for `google` e não contiver `openai`/`groq`; `_transcribeWithWhisper` só troca a URL quando o provedor é `openrouter`. Qualquer outro provedor (DeepSeek, NVIDIA, Anthropic, etc.) envia a requisição para `https://api.openai.com/v1/audio/transcriptions` **usando a chave do outro provedor**.
- Impacto: áudio falha sempre que o Zap usa um provedor sem suporte a transcrição — e o cliente recebe "manda por texto".
- Correção: matriz explícita `provider → transcriber` (`openai|groq|openrouter → whisper`, `google → gemini`), e para provedores sem transcrição: usar um provedor de transcrição configurado à parte (`transcriptionProvider`) ou desabilitar áudio com mensagem clara. Nunca herdar URL/chave de outro provedor.

**A2 — [P1] Gemini recebe o áudio inteiro em base64, sem limite**
- Onde: `ai-responder.js:636-673`.
- Causa: `inline_data` com o arquivo completo; sem checagem de tamanho/duração e sem timeout.
- Impacto: áudios longos estouram limite da API, demoram ou falham; a fila do chat fica presa.
- Correção: limite de bytes (ex.: 15 MB) e duração; acima disso, recusar com mensagem amigável ou usar upload/File API; `AbortController` com 60–90 s.

**A3 — [P1] Nenhum timeout em transcrição**
- Onde: `ai-responder.js:630` e `:654`.
- Causa: `fetch` sem `AbortController`.
- Impacto: provedor lento/hung bloqueia a fila daquele chat indefinidamente (o `chatQueues` de `main.js` não avança).
- Correção: timeout global por chamada + timeout por mensagem no `processMessage`.

**A4 — [P1] Sem retry/backoff nem rotação de chave na transcrição**
- Onde: `ai-responder.js:567-597`.
- Causa: laço de provedores sem repetição por provedor.
- Impacto: um 429/erro transitório derruba o áudio.
- Correção: 2 tentativas com backoff (500 ms, 1,5 s) e rotação de chave igual ao `callAI`.

**A5 — [P2] Falha de áudio responde ao cliente a cada tentativa**
- Onde: `main.js` (`audioFailed`) + `ai-responder.js`.
- Causa: mensagem "manda por texto" sem cooldown.
- Impacto: spam se o cliente manda vários áudios.
- Correção: cooldown por chat (ex.: 1 aviso a cada 10 min).

**A6 — [P2] Download de mídia frágil e sem limite de concorrência**
- Onde: `whatsapp-manager.js` (`_downloadMedia`, `_fetchMediaBuffer`), `media-resolver.js`.
- Causa: depende de módulos internos do WhatsApp Web (`WAWeb*`), sem dedupe de download e sem teto de paralelismo.
- Impacto: quebra a cada atualização do WhatsApp Web; vários áudios simultâneos sobrecarregam a página/CPU.
- Correção: fila de mídia com concorrência 1–2 por Zap; cache por `msgId`; fallback via URL quando possível; teste de fumaça após cada update.

**A7 — [P2] Áudio com legenda ignora a transcrição**
- Onde: `bodyIsAudioPlaceholder` / `processMessage`.
- Causa: se há legenda, o texto é usado.
- Impacto: aceitável, mas o conteúdo falado é perdido — pode gerar resposta errada.
- Correção: transcrever mesmo com legenda quando o áudio tiver duração relevante, e concatenar legenda + transcrição.

---

## 2. Recebimento de mensagens

**M1 — [P0] Mensagens durante `authenticated` (antes de `ready`) entram na IA e o envio falha**
- Onde: `whatsapp-manager.js:890` (aceita `ready` **ou** `authenticated`) vs. `:1914` (`sendMessage` exige `ready`).
- Causa: janela real de reconexão em que o WhatsApp entrega mensagens antes da página estar pronta para envio.
- Impacto: a IA gera resposta, grava no histórico, tenta enviar, falha e o cliente **nunca recebe**; o histórico fica com resposta fantasma.
- Correção: ou (a) enfileirar a mensagem até `ready` (com timeout de 2–3 min) e só então processar, ou (b) só aceitar `ready` e depender do backlog (que hoje não existe — ver M2). Preferir (a).

**M2 — [P0] Mensagens anteriores ao pareamento / durante `connecting`/`waiting_qr` são perdidas para sempre**
- Onde: `whatsapp-manager.js` — só processa `isNewMsg`; nunca lê histórico/backlog.
- Causa: o listener ignora mensagens antigas e não há "catch-up" após conectar.
- Impacto: cliente que escreveu enquanto o bot caía, reiniciava ou pareava **nunca é respondido**. Em operação 24h com reconexões frequentes (GitHub Actions), isso é perda recorrente e silenciosa.
- Correção: após `ready`, buscar conversas com mensagens não lidas (`chat.unreadCount`/`getChats`) e processar as recebidas desde o último `lastProcessedTs` persistido por Zap. Persistir esse marcador em disco.

**M3 — [P1] Filtro de 180 s pode descartar mensagens reais**
- Onde: `whatsapp-manager.js:910-925` (`newestMsgTs - 180s`).
- Causa: descarta por timestamp relativo ao "mais novo já visto", sensível a clock skew e entrega fora de ordem.
- Impacto: mensagem legítima descartada; cliente sem resposta.
- Correção: usar `msg.timestamp` contra um cursor persistido (`lastMessageTs`) em vez de janela relativa; aceitar tudo que for maior que o cursor.

**M4 — [P1] `_ensureMsgKey` pode devolver string vazia**
- Onde: `whatsapp-manager.js:986-1001`.
- Causa: fallback incompleto quando `id._serialized`/`id.id` ausentes.
- Impacto: anti-loop, citação e cache de mídia quebram (chave `''` colide entre mensagens).
- Correção: gerar chave determinística (`zap|chat|from|timestamp|hash(body)`) quando faltar ID; nunca retornar vazio.

**M5 — [P1] Mesmo contato pode virar duas filas (`@lid` vs `@c.us`)**
- Onde: `main.js:701-712` (chave `${zapId}|${chat.id || from || to}`).
- Causa: o WhatsApp entrega o mesmo contato com IDs diferentes.
- Impacto: duas mensagens do mesmo cliente processadas em paralelo, respostas cruzadas e fora de ordem.
- Correção: normalizar para o telefone canônico (`_normNum`) antes de montar a chave da fila; mapear `lid → phone` quando disponível.

**M6 — [P1] Sem timeout em `getContact`/`getChat`**
- Onde: `whatsapp-manager.js` (`handleMessage`).
- Causa: chamadas à página sem `Promise.race` com timeout.
- Impacto: página morta/travada bloqueia a fila daquele chat para sempre.
- Correção: timeout de 10 s em toda chamada à página + `_healPage()` no estouro.

**M7 — [P1] Escrita síncrona de `contacts.json` a cada mensagem**
- Onde: `whatsapp-manager.js` (`persistContacts`, `_recordOutgoing`).
- Causa: `writeFileSync` do arquivo inteiro por mensagem.
- Impacto: I/O pesado, travadas e risco de corrupção sob carga.
- Correção: debounce (2–5 s) + escrita atômica (`.tmp` + rename) + limite de contatos.

**M8 — [P2] `handleMessage` grava conversa antes de filtrar vazio/template**
- Onde: `whatsapp-manager.js` (`handleMessage`).
- Impacto: histórico e painel poluídos com mensagens que não deveriam existir; contadores errados.
- Correção: filtrar antes de persistir.

**M9 — [P2] Nomes de contatos `@lid` não resolvem**
- Onde: `getContactName` só consulta `${phone}@c.us`.
- Impacto: painel mostra número em vez de nome; agente de IA perde contexto.
- Correção: índice por `lid` e por `phone`, com fallback para `pushname`.

**M10 — [P2] `message` listener registrado antes de `initialize`**
- Onde: `whatsapp-manager.js`.
- Impacto: mensagens muito precoces podem ser descartadas por falta de `clientData`.
- Correção: buffer de mensagens até `clientData` existir.

---

## 3. Envio de respostas

**R1 — [P0] Envio multi-parte sem rollback e interrompido por resposta do dono**
- Onde: `main.js:1061-1070` (`hasOwnerReplied` antes de cada parte) e envio sequencial.
- Causa: se o dono responde depois da parte 1, as partes 2–4 são abortadas.
- Impacto: cliente recebe **resposta pela metade** — pior que não responder.
- Correção: decidir tudo antes de enviar (checar dono uma vez, imediatamente antes da primeira parte) e enviar as partes em sequência sem aborto; se o dono responder no meio, concluir o envio já iniciado.

**R2 — [P1] Fallback de envio pode ir para o chat errado**
- Onde: `whatsapp-manager.js:1967-1998`.
- Causa: localiza `lastMsg` por número normalizado e chama `reply()`, que pode citar outra mensagem/chat.
- Impacto: mensagem entregue ao contato errado (risco jurídico/reputacional).
- Correção: só usar fallback quando `chatId` bater exatamente; caso contrário, falhar explicitamente.

**R3 — [P1] `replyMessage` cai para `sendMessage` em qualquer erro → duplo envio**
- Onde: `whatsapp-manager.js` (`replyMessage`).
- Causa: erro após envio parcial dispara novo envio sem citação.
- Impacto: cliente recebe a mesma mensagem duas vezes.
- Correção: classificar erro (falha de rede vs. falha de citação); só reenviar em falha pré-envio comprovada; usar `idempotencyKey`.

**R4 — [P1] `message-guard` rejeita texto comercial legítimo**
- Onde: `src/js/message-guard.js:19`, `:153`, `:158-166`, `:211-224`.
- Causa: bloqueia **qualquer** `[...]`, `snake_case`, listas numeradas, negrito e JSON.
- Impacto: `[Promoção]`, `pix_copia_cola`, "1) ... 2) ..." e `*negrito*` são descartados; se todas as partes caírem, o cliente recebe erro genérico em vez da oferta.
- Correção: allowlist de marcadores (`[AUDIO]`, `[enviou imagem]`), permitir `snake_case` fora de contexto de código, permitir listas curtas e negrito; testar com corpus real de vendas.

**R5 — [P1] `splitMessages` pode gerar parte > 2000 chars e ser rejeitada**
- Onde: `ai-responder.js:985-990` (`clampToMax` funde o excedente na última parte).
- Impacto: perda da última parte (justamente a conclusão/CTA).
- Correção: dividir de verdade (cortar em fronteira de frase) e nunca ultrapassar o limite.

**R6 — [P1] Fallback da IA usa **todos** os provedores, inclusive os não selecionados**
- Onde: `ai-responder.js:675-809`.
- Causa: fila de fallback global.
- Impacto: custo inesperado, uso de chaves que o cliente não contratou, respostas de modelo indesejado.
- Correção: fallback apenas dentro do provedor selecionado (ou lista explícita `fallbackModels`).

**R7 — [P1] Sem timeout nas chamadas de IA**
- Onde: `ai-responder.js:630`, `:654`, `:993`, `:1058`, `:1113`.
- Impacto: fila do chat travada indefinidamente.
- Correção: `AbortController` 45–60 s por tentativa + timeout total por mensagem.

**R8 — [P1] Histórico é gravado antes do envio**
- Onde: `ai-responder.js:788-789`.
- Impacto: se o envio falha, o histórico contém resposta nunca entregue; a próxima resposta fica incoerente.
- Correção: gravar somente após confirmação de envio (ou marcar `pending` e reconciliar).

**R9 — [P1] Duplo laço de fallback (main + ai-responder)**
- Onde: `main.js` (`modelsToTry`) + `ai-responder.generateResponse`.
- Impacto: múltiplas chamadas de API por mensagem, custo e latência altos, logs duplicados.
- Correção: um único ponto de fallback.

**R10 — [P2] `aiSending` é global por Zap, não por chat**
- Onde: `whatsapp-manager.js:1954`.
- Impacto: envios simultâneos em chats diferentes se suprimem/misclassificam.
- Correção: chave por `chatId`.

**R11 — [P2] `pendingAiSends` casa só por corpo do texto**
- Impacto: texto legítimo repetido é engolido pelo anti-loop.
- Correção: casar por `(chatId, body, janela)` e remover a entrada após o envio.

**R12 — [P2] `sendMedia` via fallback não registra em `aiSentIds`**
- Impacto: anti-loop pode responder à própria mídia.
- Correção: registrar sempre, inclusive no fallback.

**R13 — [P2] Erro técnico enviado ao cliente**
- Onde: `sendErrorToWhatsApp`.
- Impacto: exposição de problema interno e spam.
- Correção: mensagem neutra ("já te respondo") + alerta no painel; cooldown.

**R14 — [P2] Indicadores de "digitando" dependem de módulos internos**
- Onde: `WAWebChatStateBridge`, `WAWebWidFactory`.
- Impacto: quebra silenciosa a cada update do WhatsApp Web.
- Correção: feature-detect + fallback para `chat.sendStateTyping()` público do Baileys/WhatsApp Web; log de degradação.

---

## 4. Cálculo do tempo de digitação

**T1 — [P1] Sem teto: 2000 caracteres = 13 min de "digitando"**
- Onde: `main.js:654-676` (`CARACTERES_POR_SEGUNDO = 2.5`, `max(5000, chars/2.5*1000)`).
- Impacto: cliente desiste; a fila do chat fica bloqueada 13 min; 4 partes podem somar >20 min.
- Correção: `clamp(3000, 12000)` ms para o total e por parte; velocidade mais realista (8–12 chars/s para digitação humana) com teto.

**T2 — [P1] Latência da IA conta como tempo de digitação**
- Onde: `typingStart` em `main.js:930`, antes do laço de modelos.
- Causa: o cronômetro começa antes de gerar a resposta.
- Impacto: se a IA demora 60 s, o "digitando" fica 60 s sem sentido e a mensagem sai imediatamente depois (ou o indicador fica congelado).
- Correção: iniciar o indicador **após** a resposta pronta; durante a geração, não mostrar "digitando".

**T3 — [P2] Cada parte adicional adiciona no mínimo 5 s**
- Onde: `partTypingStart` + mínimo 5 s.
- Impacto: 4 partes = +15 s desnecessários.
- Correção: mínimo 1,5–2 s por parte, proporcional ao tamanho.

**T4 — [P2] Contagem em unidades UTF-16**
- Causa: `String(text).length`.
- Impacto: emojis contam 2; pequena superestimação.
- Correção: `[...text].length` ou `Intl.Segmenter`.

**T5 — [P2] Renovação a cada 20 s vs. expiração ~25 s**
- Onde: `main.js:669-674`.
- Impacto: risco de o indicador piscar/apagar em redes lentas.
- Correção: renovar a cada 12–15 s.

**T6 — [P3] Pré-delay `[2s,3s,5s]` ignorado com `instantReply`**
- Onde: `main.js:920-927`.
- Impacto: comportamento inconsistente entre Zaps.
- Correção: documentar; manter um mínimo de 1 s mesmo em modo instantâneo.

**Observação:** não há checagem de "dono respondeu" **durante** a espera de digitação — só no momento do envio. Ver O4.

---

## 5. Sistema de conversas e memória

**C1 — [P0] Fuso horário: o dia "vira" às 21h de Brasília no servidor**
- Onde: `src/js/conversation-store.js:14-27` (`dayKey`, `endOfDay`, `hourLabel`).
- Causa: usa hora local do processo; o servidor roda em UTC.
- Impacto: conversas e memória reiniciam às 21:00 BRT; relatórios por dia errados; memória de 3 dias vira 2,1 dias efetivos.
- Correção: `TZ=America/Sao_Paulo` no serviço/container **e** `Intl.DateTimeFormat` com timezone explícito (não depender do ambiente); timezone por Zap.

**C2 — [P1] `_prune` só roda ao criar conversa nova**
- Onde: `conversation-store.js:111`.
- Impacto: `conversations.json` cresce sem limite em chats antigos; escrita cada vez mais lenta.
- Correção: podar a cada N appends e no boot; limite global de tamanho.

**C3 — [P1] `flush` síncrono do arquivo inteiro**
- Onde: `conversation-store.js`.
- Impacto: travadas e perda de mensagens se o processo morrer antes do flush.
- Correção: escrita atômica + debounce + flush no SIGTERM (hoje não acontece em headless — ver S3).

**C4 — [P1] Histórico divergente após falha**
- Onde: `main.js:1020-1023` (`updateLastAssistant`) + `ai-responder.js:788-789`.
- Impacto: a IA "lembra" de algo que não foi enviado.
- Correção: registrar somente o que foi efetivamente enviado; `updateLastAssistant` com base nas partes enviadas.

**C5 — [P1] Sem lock entre PC e servidor no mesmo diretório**
- Impacto: corrupção de `conversations.json` se os dois escreverem.
- Correção: lockfile (`proper-lockfile`) ou separar diretórios por instância.

**C6 — [P2] Cópia de memória em `.txt` a cada mensagem**
- Onde: `main.js:824-829`.
- Impacto: I/O síncrono por mensagem; arquivos órfãos.
- Correção: gerar sob demanda (debug) ou debounce.

**C7 — [P2] `clearForZap`/`clearForChat` não apagam os `.txt`**
- Impacto: dados "apagados" continuam em disco (LGPD).
- Correção: apagar junto.

**C8 — [P2] `append` converte qualquer role ≠ assistant em user**
- Onde: `conversation-store.js`.
- Impacto: mensagens `system` viram fala do cliente no prompt.
- Correção: validar roles ou mapear `system` para `user` com prefixo.

**C9 — [P2] Corrida na virada do dia**
- Onde: `ensure` (fecha conversa ao mudar o dia) + `rollOver` a cada 60 s.
- Impacto: mensagem pode cair na conversa antiga ou nova conforme a ordem.
- Correção: serializar `ensure`/`append` por chat.

**C10 — [P2] `conversationInfo.count` está sempre 1 atrás**
- Onde: `main.js` usa `messages.length` antes de inserir a mensagem atual.
- Impacto: prompt diz "já trocaram N" quando são N+1; irrelevante, mas fácil de corrigir.
- Correção: somar 1.

**C11 — [P3] `recentHistory` depende de `endedAt || startedAt`**
- Impacto: conversas longas podem sair do contexto antes do esperado.
- Correção: usar sempre `startedAt` e ordenar por `at`.

**C12 — [P2] Memória truncada por caracteres a partir do fim**
- Onde: `MEMORY_MAX_CHARS = 6000`, `MEMORY_DAYS = 3`.
- Impacto: em conversas longas, o início (nome, produto, objeção) é perdido.
- Correção: sumarização por IA + fatos fixos (nome, interesse, estágio) em campos estruturados.

---

## 6. Detecção de resposta do dono e mensagens antes do pareamento

**O1 — [P0] Resposta manual do dono pode não ser detectada**
- Onde: `whatsapp-manager.js:521-526` — só marca quando `msg.deviceType && msg.deviceType !== 'web'`.
- Causa: em várias versões/plataformas o `deviceType` vem `undefined` ou `'web'` mesmo para envio manual no celular.
- Impacto: o robô responde por cima do dono — o pior erro possível para o cliente.
- Correção: tratar `fromMe` em `message_create` como resposta do dono **exceto** quando a mensagem foi enviada pela própria IA (checar `aiSentIds`/`pendingAiSends` e origem `source:'ai'`). Não depender de `deviceType`.

**O2 — [P0] `ownerReplies` é só em memória**
- Onde: `whatsapp-manager.js:2086-2096`.
- Impacto: após reconexão/restart (frequente no modelo GitHub Actions), o bot "esquece" que o dono respondeu e volta a responder.
- Correção: persistir em `owner-replies.json` (ou no store de conversas) com TTL.

**O3 — [P1] Normalização `@lid` vs `@c.us` gera falso negativo**
- Onde: `hasOwnerReplied` (`:2100-2119`).
- Impacto: mesma causa de O1.
- Correção: normalizar para telefone canônico e manter alias `lid↔phone`.

**O4 — [P1] Checagem "ao vivo" só na primeira parte**
- Onde: `main.js:1064` (`{live: i===0}`).
- Impacto: o dono pode responder durante o envio e o bot continua (ou aborta no meio — ver R1).
- Correção: uma checagem antes do primeiro envio + cancelamento **apenas** antes de iniciar; nunca no meio.

**O5 — [P1] Comparação estrita `>` perde resposta no mesmo segundo**
- Onde: `hasOwnerReplied`.
- Impacto: resposta do dono e gatilho no mesmo segundo → bot responde junto.
- **Correção: `t > since` (não `t >= since`) e validação de `since > 0`**. O teste "dono: markOwnerReply guarda o horario e só vale DEPOIS da mensagem" agora passa. A lógica foi ajustada em `hasOwnerReplied` para usar `t > since` em vez de `t >= since`, garantindo que o mesmo segundo não conte como resposta.

**O6 — [P1] Resposta do dono antes do pareamento é perdida**
- Onde: `markOwnerReply` retorna silenciosamente sem `clients[zapId]`.
- Impacto: cliente escreveu, dono respondeu pelo celular, bot pareia e responde por cima.
- Correção: gravar a marca mesmo sem cliente conectado (persistente, por chat/timestamp).

**O7 — [P2] `triggerTs` usa `timestamp || now`**
- Onde: `main.js`.
- Impacto: timestamp `0`/`undefined` vira "agora" e esconde resposta anterior.
- Correção: validar (`> 1e12`) antes de usar; senão, `now`.

**O8 — [P2] `whatsapp-send-media` marca por telefone, não por chatId**
- Onde: `main.js:2031-2033`.
- Impacto: marcação no chat errado em casos `@lid`.
- Correção: usar o mesmo `chatId` do envio.

**O9 — [P2] Falha em `hasOwnerReplied` retorna `false` (fail-open)**
- Impacto: em erro, o bot responde mesmo assim.
- Correção: fail-closed com log e retry.

---

## 7. Revisão geral do app (config, persistência, segurança, IA, mídia, UI)

### 7.1 Persistência e configuração — **área mais perigosa**

**G1 — [P0] JSON corrompido vira lista vazia silenciosamente**
- Onde: `main.js:429-434` (`loadJsonFile`), `loadZapsData`.
- Impacto: qualquer erro de parse (arquivo travado, disco cheio, escrita interrompida) faz o app achar que **não há Zaps**. O renderer (`src/js/app.js:413-423`) aceita `[]` como verdade e limpa a UI/localStorage.
- Correção: nunca retornar fallback silencioso. Em erro: renomear para `.corrupt-<ts>`, tentar `.bak`, entrar em modo somente-leitura e **bloquear** operações destrutivas até intervenção.

**G2 — [P0] Reconciliador apaga sessões e treinamentos de Zaps "removidos"**
- Onde: `main.js:1428-1450`.
- Causa: compara `serverKnownZaps` com `loadZapsData()`; um `zaps.json` vazio/corrompido faz todos parecerem removidos; então `fs.rmSync` em `sessions/<id>`, `<id>.cache-keep` e `trainings/<id>`.
- Impacto: **perda irreversível** de todas as sessões (todos precisam reparear) e treinamentos.
- Correção: (a) exigir confirmação explícita (`deletedZaps` explícito no JSON, não diferença de conjuntos); (b) mover para `trash/` com TTL em vez de `rmSync`; (c) abortar reconciliação se o arquivo falhou no parse ou veio vazio; (d) backup antes.

**G3 — [P0] `save-zaps` aceita `[]` e não valida schema**
- Onde: `main.js:2087-2119`.
- Impacto: um bug de UI ou IPC malformado apaga todos os Zaps (e dispara G2).
- Correção: validar (array, ids únicos, campos obrigatórios), rejeitar `[]` sem flag `allowEmpty`, manter `.bak`, retornar erro e **propagar** ao renderer.

**G4 — [P0] `saveZaps()` no renderer ignora falha**
- Onde: `src/js/app.js:361-366`.
- Impacto: usuário acha que salvou; nada foi salvo.
- Correção: `await` + toast de erro + retry.

**G5 — [P1] Sync do servidor aplica config sem validar**
- Onde: `deploy/actions/monitor.sh:29-49` (`git checkout origin/main -- zaps.json ...` a cada 60 s).
- Impacto: um push ruim (ou vazio) derruba a operação em até 60 s.
- Correção: validar JSON + schema antes de aplicar; se inválido, manter versão anterior e reportar.

**G6 — [P1] `backup.sh` faz `git add -A` incluindo `sessions/` e pode `push --force-with-lease`**
- Onde: `deploy/actions/backup.sh:19-25`, `:53-55`.
- Impacto: backup do Chromium em execução é inconsistente; force-push pode sobrescrever config/histórico.
- Correção: nunca versionar `sessions/`; backup consistente via parada ou cópia com `--exclude`; proibir force-push em `main`.

**G7 — [P1] Modelos Google inválidos injetados em runtime**
- Onde: `main.js:456-466` adiciona `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`; `ai-responder.js:639` usa `gemini-3.6-flash` como padrão.
- Impacto: 404 em toda transcrição/resposta Google; fallback silencioso para outro provedor (custo/resposta inesperada).
- Correção: remover IDs inexistentes; validar contra `providers.js`; buscar lista dinâmica de modelos quando possível.

**G8 — [P1] `providers.js` tem vários IDs provavelmente inexistentes**
- Exemplos: `gpt-5.4`, `gpt-5.5`, `gpt-5.6-sol`, `nvidia/nemotron-3-*`, `google/gemma-4-*`.
- Impacto: usuário escolhe modelo que nunca funciona; suporte inflado.
- Correção: catálogo validado por teste de fumaça e/ou endpoint de listagem do provedor; marcar `deprecated`.

**G9 — [P2] `loadProvidersData` muta modelos sem persistir**
- Impacto: UI mostra opções que não estão no arquivo; confusão ao reiniciar.
- Correção: migração explícita e persistida, versionada.

**G10 — [P2] Escrita `.tmp` + rename pode falhar no Windows**
- Causa: antivírus/OneDrive mantém o arquivo aberto.
- Impacto: `false` silencioso (ver G4).
- Correção: retry com backoff + `fsync` + `.bak`.

**G11 — [P2] `resolveDataPath` tem checagem de prefixo frágil**
- Impacto: risco de falso positivo em diretórios irmãos com mesmo prefixo.
- Correção: comparar com `path.relative` apenas (já feito) e remover o check redundante.

**G12 — [P1] `getDataDir` depende do nome do app**
- Onde: `app.getPath('userData')/link-no-whatsapp`.
- Impacto: renomear o produto (provável ao comercializar) **perde configs e sessões**.
- Correção: diretório fixo/versionado independente do `productName` + migração automática.

**G13 — [P2] `save-trainings` grava imagens antes de validar o JSON**
- Impacto: arquivos órfãos; imagens removidas não são apagadas sem `deletedFiles`.
- Correção: validar primeiro, transação (tmp dir + rename), limpeza de órfãos no boot.

**G14 — [P2] `delete-trainings-for-zap` não apaga memória/conversas**
- Impacto: dado "excluído" permanece (LGPD).
- Correção: apagar tudo do Zap, com confirmação.

### 7.2 Segurança

**G15 — [P0] Chaves de API expostas ao renderer**
- Onde: `preload.js:5-7` (`bootstrapKeys.openrouter/googleai` vindas do env).
- Impacto: qualquer XSS no renderer exfiltra as chaves.
- Correção: remover do preload; toda chamada de IA no main process; renderer só recebe "configurado: sim/não".

**G16 — [P0] Chaves em texto puro e no histórico do git**
- Onde: `main.js:2122-2135` (`providers.json`) + push para repo privado.
- Impacto: vazamento permanente no histórico; qualquer colaborador/token comprometido lê tudo.
- Correção: `safeStorage`/keychain; nunca versionar segredos (usar GitHub Secrets/secret manager); rotacionar as chaves já expostas; limpar histórico.

**G17 — [P1] Token do GitHub em URL de clone e em argumentos de processo**
- Onde: `main.js:2297-2299`.
- Impacto: token em `.git/config` e visível em `ps`.
- Correção: `GIT_ASKPASS`/credential helper efêmero; `git remote set-url` sem token após o clone; token só em memória.

**G18 — [P1] CSP permissiva + QR remoto**
- Onde: `src/index.html` (`'unsafe-inline'`, `img-src https://api.qrserver.com`), `app.js:3768`.
- Impacto: superfície de XSS; dependência de terceiro para QR (privacidade).
- Correção: nonce/hash no CSP, remover `unsafe-inline`, gerar QR localmente (`qrcode` npm).

**G19 — [P1] Agente de IA com ferramentas destrutivas sem confirmação**
- Onde: `src/js/app-agent.js:187-203`, `:314`, `:419`, `:433` (`delete_zap`, `delete_training`, `block_contact`, `send_message`).
- Impacto: prompt injection via nome de contato/treinamento pode apagar Zap ou mandar mensagem.
- Correção: confirmação obrigatória no renderer para ações destrutivas; separar "tools read-only" de "tools mutantes"; allowlist.

**G20 — [P1] `parseTool` aceita qualquer JSON com `"tool"`**
- Onde: `app-agent.js:209-230`.
- Impacto: resposta do modelo pode disparar ferramenta não intencional.
- Correção: schema estrito + validação de nome/args + limite de passos (já há 8).

**G21 — [P2] `sandbox: false`**
- Onde: `main.js:1163-1165`.
- Impacto: renderer comprometido tem mais alcance.
- Correção: `sandbox: true` se não houver dependência de Node no renderer (hoje parece possível).

**G22 — [P2] Status server sem auth por padrão em `0.0.0.0`**
- Onde: `main.js:1206-1256`; rotas `POST /connect`, `/disconnect`.
- Impacto: qualquer um na rede conecta/desconecta Zaps.
- Correção: exigir token **sempre** que `HOST != 127.0.0.1`; rate limit; bind local por padrão.

**G23 — [P2] Token em query string**
- Impacto: aparece em logs/histórico/referrer.
- Correção: header `Authorization` apenas; cookie `HttpOnly` para o painel.

### 7.3 Outros problemas de código

**G24 — [P2] Leitura síncrona de 3 JSONs a cada mensagem**
- Onde: `main.js:759-761`.
- Impacto: I/O e parse por mensagem; latência.
- Correção: cache em memória com invalidação por `mtime`.

**G25 — [P2] Log de terminal com `appendFileSync` por linha + monkey-patch de `console.log`**
- Impacto: I/O pesado, risco de recursão, logs gigantes.
- Correção: stream com buffer/flush, rotação por tamanho, flag para desligar.

**G26 — [P2] `persistBotStatus` a cada 30 s + commit a cada 30 s**
- Onde: `main.js` + `monitor.sh`.
- Impacto: milhares de commits, repo inflado, risco de conflito.
- Correção: status fora do git (ou branch `status` separada com squash), intervalo maior.

**G27 — [P2] `recentErrors` conta warnings como erros**
- Impacto: painel mostra "Funcionando com erros" quase sempre.
- Correção: separar níveis.

**G28 — [P2] `getServerOverview` soma `remoteAge` ao uptime**
- Impacto: uptime inflado.
- Correção: usar `startedAt` do processo remoto e validar frescor.

**G29 — [P3] Código morto em `main.js:961-965`**
- Os dois ramos do `if (generateResponse.length >= 3)` são idênticos.
- Correção: remover.

**G30 — [P2] `fetchAllContacts`/`fetchChatHistory` sem timeout**
- Impacto: IPC do painel pode travar.
- Correção: timeout + paginação.

**G31 — [P2] `_mediaCache` é FIFO, não LRU**
- Impacto: descarta mídia em uso.
- Correção: LRU com limite de bytes.

**G32 — [P2] `decryptWhatsAppMedia` (AES-CBC/HKDF) sem testes vetoriais**
- Impacto: mídia corrompida em casos de borda.
- Correção: vetores de teste oficiais; fallback para `downloadMedia()` do WhatsApp Web.

**G33 — [P2] `work-hours`: janela noturna + dias da semana**
- Onde: `src/js/work-hours.js:49-56`.
- Causa: filtro de dia aplicado antes da lógica de janela que atravessa a meia-noite.
- Impacto: janela 22:00–06:00 com `days=[segunda]` **exclui** terça 02:00, que pertence à segunda.
- Correção: calcular o "dia de referência" (se hora < fim e fim < início, dia anterior) antes de filtrar.

**G34 — [P3] `start === end` significa 24h; não há como representar "fechado"**
- Correção: flag `enabled` explícita.

**G35 — [P2] Timezone inválido cai silenciosamente para o fuso do servidor**
- Impacto: horário de atendimento errado.
- Correção: validar com `Intl.DateTimeFormat` e avisar no painel.

**G36 — [P2] `auto-message`: risco alto de ban**
- Onde: `src/js/auto-message.js`.
- Causas: intervalo fixo de 5 min por contato, `repeat` envia várias mensagens sem delay, sem limite horário/diário, `normalizeNumber` ambíguo (8–15 dígitos, prefixo 55 automático), `extractNumbers` captura datas/preços.
- Impacto: bloqueio do número pelo WhatsApp — fatal para o cliente.
- Correção: limites duros (ex.: 50/dia, 200/h), jitter, validação E.164, dry-run, lista de bloqueio, aquecimento de número.

**G37 — [P2] `autoMsgChat` bloqueia IPC até 15 s**
- Onde: `waitForFirstOutcome(15000)`.
- Correção: assíncrono com progresso.

**G38 — [P2] `setZap` descarta fila pendente**
- Impacto: campanha perdida silenciosamente.
- Correção: persistir fila por Zap e retomar.

**G39 — [P2] `app-agent.delete_zap` não apaga a sessão em disco**
- Impacto: sessões órfãs, disco crescendo.
- Correção: limpeza transacional.

**G40 — [P2] `getStats` varre todas as conversas a cada mensagem do agente**
- Impacto: lento com histórico grande.
- Correção: contadores incrementais.

**G41 — [P3] `add_zap` usa `Date.now()` como id**
- Correção: `crypto.randomUUID()`.

**G42 — [P2] `serverModeRequested` bloqueia o WhatsApp local se o repo sumir**
- Onde: `main.js`.
- Impacto: usuário fica sem bot e sem explicação clara.
- Correção: detectar repo ausente e oferecer "voltar ao modo local".

---

## 8. Servidor 24h / deploy

### 8.1 Arquitetura atual (GitHub Actions)

**S1 — [P0] GitHub Actions não é runtime 24h confiável nem adequado**
- Onde: `.github/workflows/zap-bot.yml` (runs de 310 min, `timeout-minutes: 350`), `zap-watchdog.yml` (cron `*/15`).
- Causas: cada ciclo faz checkout + build + `docker run`; o WhatsApp reconecta a cada ~5 h com lacunas; depende de `BOT_PAT`; Actions tem limites de minutos e pode ser desabilitado; usar Actions como bot sempre-ligado **viola os termos** e pode gerar suspensão da conta.
- Impacto: quedas silenciosas, repareamento frequente, risco de ban da conta GitHub e do número.
- Correção: migrar para VPS (ver §11). Manter Actions apenas para CI/CD.

**S2 — [P1] Se o PAT expirar, a corrente para sem alerta**
- Onde: `zap-bot.yml` (dispatch com `BOT_PAT`), `zap-watchdog.yml`.
- Impacto: bot morre e ninguém sabe.
- Correção: monitor externo (UptimeRobot/BetterStack) batendo em `/status`; alerta por e-mail/Telegram; alerta de expiração do PAT.

**S3 — [P0] Shutdown gracioso não existe em headless**
- Onde: `main.js:1906-1919` — `before-quit`: `if (isHeadless()) return;`.
- Impacto: em SIGTERM (systemd/docker stop) **não** roda `conversationStore.flush()`, `disconnectAll()` nem `persistBotStatus()`. Perda de conversas e sessão Chromium corrompida → repareamento.
- Correção: handler de `SIGTERM`/`SIGINT` no headless que faz flush, desconecta, persiste status e sai em até 20 s; `process.exitCode`.

**S4 — [P1] `link-zap.service` com `TimeoutStopSec=20` mas app precisa de até 90 s**
- Onde: `deploy/alavps/link-zap.service`.
- Impacto: systemd mata no meio do flush → corrupção.
- Correção: `TimeoutStopSec=90`, `KillMode=mixed`, `SendSIGKILL=no`; alinhar com `docker stop -t 90`.

**S5 — [P1] `entry.sh` não tem fallback de kill**
- Onde: `deploy/actions/entry.sh:30-40`.
- Impacto: container pendurado até o timeout do Docker; SIGKILL.
- Correção: `wait` com timeout, depois `SIGKILL` controlado + log.

**S6 — [P1] Healthcheck falso: só verifica "container rodando"**
- Onde: `deploy/actions/monitor.sh:71-76`; `zap-bot.yml:99-112` (`sleep 90` + `docker ps`).
- Impacto: app vivo mas WhatsApp morto/página travada passa como saudável. Exatamente o cenário que o usuário quer evitar.
- Correção: healthcheck real: `GET /status` respondendo + `bot-status.json` com `updatedAt < 120 s` + pelo menos um Zap `ready` (ou `waiting_qr` legítimo). Docker `HEALTHCHECK` + restart automático.

**S7 — [P1] Watchdog interno ignora `waiting_qr`/`waiting_pairing`**
- Onde: `main.js:1370-1419` (`startConnectionWatchdog`).
- Impacto: estado zumbi de QR nunca é retomado; Zap fica eternamente "aguardando".
- Correção: timeout máximo de pareamento (ex.: 10 min) → reiniciar cliente e gerar novo QR; notificar painel.

**S8 — [P1] Reconciliação não reconecta Zap que caiu**
- Onde: `main.js:1428-1450` (`startServerReconciler`) só conecta novos/reativados quando `!busy`.
- Impacto: Zap habilitado e desconectado só volta pelo watchdog (com backoff até 10 min).
- Correção: reconciliar estado desejado × real a cada ciclo, com backoff por Zap e métrica.

**S9 — [P1] `isServerPaused` pode ficar travado em "pausado"**
- Causa: `serverSync.remoteStop` obsoleto ou arquivo `STOP` remanescente quando o "ligar" falha.
- Impacto: bot fica parado mesmo com o painel dizendo "ligado".
- Correção: fonte única de verdade com timestamp + TTL; ao iniciar, limpar `STOP` se o último comando foi "start".

**S10 — [P1] Novos Zaps na VPS podem nunca parear**
- Causa: `autoPairMissingSessions` (`main.js:1340-1361`) exige `LINK_AUTO_PAIR=1`, **não definido** em `link-zap.service`; e o painel (`app.js:3836-3863` → `server-current-qr`) só **lê** o QR, não pede conexão.
- Impacto: cliente adiciona Zap no PC, sincroniza, e o Zap fica sem sessão para sempre.
- Correção: definir `LINK_AUTO_PAIR=1`; adicionar IPC `server-connect-zap` que grava um comando no repo (ex.: `commands/connect-<id>.json`) consumido pelo servidor; painel mostra progresso.

**S11 — [P1] `status-server` não reinicia se a porta estiver ocupada**
- Onde: `main.js:1206-1256` (`statusServer = null` no erro).
- Impacto: painel/monitor sem dados; healthcheck falha sem retry.
- Correção: retry com backoff + porta alternativa + log crítico.

**S12 — [P2] Sem limites de CPU/memória no `docker run`**
- Onde: `zap-bot.yml`.
- Impacto: Chromium OOM derruba runner/container e às vezes o job inteiro.
- Correção: `--memory=2g --cpus=2`, `--shm-size=1g`, `--restart unless-stopped`.

**S13 — [P2] Backup do Chromium em execução**
- Onde: `monitor.sh` (`FULL_EVERY=21600`).
- Impacto: sessão inconsistente; até 6 h de mudanças perdidas.
- Correção: snapshot com app parado (stop → backup → start) em janela de manutenção, ou backup incremental de `sessions/` com `sqlite3 .backup`/rsync consistente.

**S14 — [P2] `backup.sh` quick backup só cobre status**
- Impacto: em crash, perde configs recentes (se o sync falhou).
- Correção: incluir `zaps.json`, `providers.json`, `trainings.json` validados.

**S15 — [P2] `monitor.sh` faz `git checkout` de config a cada 60 s**
- Impacto: I/O, risco de aplicar estado parcial durante escrita.
- Correção: aplicar apenas quando o hash remoto mudar; validação + apply atômico.

**S16 — [P2] Sem observabilidade**
- Impacto: impossível diagnosticar em produção.
- Correção: logs estruturados (JSON), métricas (mensagens/min, falhas de envio, tempo de IA, reconexões), `/metrics` Prometheus ou similar.

**S17 — [P2] `status-server` mostra QR via PNG em disco**
- Onde: `monitor.sh`/`server-sync` leem `qr-<id>.png`.
- Impacto: corrida entre escrita/leitura; QR expirado.
- Correção: endpoint `/qr` com geração em memória e TTL.

**S18 — [P3] `entry.sh`/Dockerfile sem usuário não-root**
- Impacto: segurança do host.
- Correção: rodar como usuário dedicado.

---

## 9. Comercialização

**N1 — [P0] Uso de WhatsApp Web automatizado viola os Termos**
- Impacto: ban do número do cliente, responsabilidade civil. É o maior risco comercial do produto.
- Correção: (a) deixar explícito no contrato/UI que é automação não oficial; (b) oferecer caminho oficial (WhatsApp Business Platform/Cloud API) para quem precisa de garantia; (c) limites anti-ban agressivos; (d) aviso de "número dedicado, não o principal".

**N2 — [P0] Sem licenciamento/ativação**
- Impacto: cópia livre do app; nenhuma receita controlável.
- Correção: licença assinada (ex.: Keygen/Polymart), validação online com grace period offline, vínculo a hardware/instância.

**N3 — [P1] LGPD: sem base legal, retenção e exclusão**
- Impacto: multa e risco reputacional; conversas de terceiros armazenadas 30 dias + memória 3 dias sem aviso.
- Correção: política de privacidade, DPA, retenção configurável, exportação/exclusão por titular, criptografia em repouso, registro de tratamento.

**N4 — [P1] Sem multi-tenant**
- Impacto: vender para vários clientes exige uma instância por cliente (custo alto) e não há isolamento de dados.
- Correção: modelo "1 instância por cliente" (mais simples e seguro) **ou** multi-tenant com namespaces, quotas e isolamento de sessão.

**N5 — [P1] Sem assinatura/updates**
- Impacto: impossível cobrar recorrência e corrigir bugs em produção.
- Correção: auto-update assinado (electron-updater) + canal stable/beta.

**N6 — [P1] Sem code signing**
- Impacto: SmartScreen/antivírus bloqueiam o instalador; conversão despenca.
- Correção: certificado EV/OV, assinatura do instalador e dos binários.

**N7 — [P2] Nome "Link no WhatsApp" / pacote `link-no-whatsapp`**
- Impacto: risco de marca (Meta) e de confusão.
- Correção: renomear produto e pacote antes do lançamento (e resolver G12 antes).

**N8 — [P2] Sem suporte/onboarding**
- Impacto: churn alto em produto técnico.
- Correção: diagnóstico embutido ("por que meu bot não respondeu?"), logs exportáveis, base de conhecimento.

**N9 — [P2] Sem SLA/limites documentados**
- Impacto: expectativa errada → reembolso.
- Correção: documentar latência, limites de mensagens, janela de suporte, comportamento em queda.

**N10 — [P2] Custo variável de IA não controlado**
- Impacto: margem negativa com clientes que usam muito.
- Correção: quotas por plano, medidor de tokens, alerta de consumo, limite por Zap.

---

## 10. Plano de correção priorizado

### P0 — bloqueadores (fazer antes de qualquer venda)

| # | Item | Arquivo principal | Correção | Esforço |
|---|---|---|---|---|
| 1 | JSON corrompido → lista vazia | `main.js:429-434` | fail-safe + `.bak` + modo somente-leitura | 0,5 d |
| 2 | Reconciliador apaga sessões/treinamentos | `main.js:1428-1450` | `trash/` + confirmação explícita + abortar se config inválida | 1 d |
| 3 | `save-zaps` aceita `[]` | `main.js:2087-2119` | schema + rejeitar vazio + propagar erro | 0,5 d |
| 4 | Renderer ignora falha de save | `app.js:361-366` | `await` + toast + retry | 0,25 d |
| 5 | Mensagens em `authenticated` → envio falha | `whatsapp-manager.js:890/1914` | fila até `ready` + timeout | 1 d |
| 6 | Backlog pré-pareamento nunca lido | `whatsapp-manager.js` | cursor persistido + catch-up de não lidas | 2 d |
| 7 | Dono responde e bot fala por cima | `whatsapp-manager.js:521-526` | `fromMe` sem `deviceType` + persistência | 1 d |
| 8 | Shutdown headless não faz flush | `main.js:1906-1919` | SIGTERM handler | 0,5 d |
| 9 | Chaves expostas ao renderer | `preload.js:5-7` | mover IA para o main | 0,5 d |
| 10 | Chaves em texto puro/no git | `main.js:2122-2135` | safeStorage + rotação + limpar histórico | 1 d |
| 11 | Runtime 24h = GitHub Actions | `.github/workflows/*` | migrar para VPS | 2–3 d |
| 12 | Healthcheck falso | `monitor.sh`, `zap-bot.yml` | `/status` + frescor + restart | 0,5 d |
| 13 | Transcrição em provedores não suportados | `ai-responder.js:567-597` | matriz de tradutores | 0,5 d |
| 14 | Multi-parte abortada no meio | `main.js:1061-1070` | decidir antes, enviar inteiro | 0,5 d |
| 15 | Termos/ban + licença | — | aviso legal + licenciamento | 2 d |

### P1 — antes do lançamento comercial

- Fila por telefone canônico (`@lid`/`@c.us`) — `main.js:701`.
- Timeout em IA, transcrição, `getChat`/`getContact` (`AbortController`).
- `message-guard` com allowlist e corpus de vendas.
- Fallback de IA restrito ao provedor selecionado.
- Histórico só após envio confirmado.
- Teto no tempo de digitação (3–12 s) e início após a IA.
- Timezone explícito + `TZ=America/Sao_Paulo`.
- Persistência de `ownerReplies` + comparação `>=`.
- `LINK_AUTO_PAIR=1` + IPC `server-connect-zap`.
- `TimeoutStopSec=90` + `KillMode=mixed`.
- Watchdog trata `waiting_qr` com timeout.
- `backup.sh` sem `sessions/` e sem force-push.
- Validação de config no sync do servidor.
- Remover modelos Google inválidos; validar catálogo.
- `work-hours` com dia de referência correto.
- Limites anti-ban no `auto-message`.
- Confirmação para tools destrutivas do agente.
- Token obrigatório no status server fora de localhost.
- `getDataDir` estável + migração.

### P2 — qualidade e escala

- Cache de configs em memória.
- Logs estruturados + rotação.
- Status fora do git / menos commits.
- Healthcheck Docker + métricas.
- Backup consistente de sessão.
- LRU de mídia + fila de download.
- Testes de contrato com WhatsApp real (sandbox).
- Multi-tenant/quotas (se aplicável).
- Auto-update + code signing.
- Painel de diagnóstico ("por que não respondeu?").

---

## 11. Arquitetura alvo recomendada (24h comercial)

```
┌──────────────────────────┐        ┌───────────────────────────────┐
│ App desktop (PC)         │        │ VPS (1 por cliente)           │
│ - só configura Zaps      │  git   │ - systemd: link-zap.service   │
│ - treinamentos           │───────▶│ - Electron headless           │
│ - QR/pareamento          │◀───────│ - status-server 127.0.0.1     │
│ - monitoramento          │  status│ - healthcheck + restart       │
└──────────────────────────┘        │ - dados em /var/lib/link-zap  │
                                    └──────────────┬────────────────┘
                                                   │
                                    ┌──────────────▼────────────────┐
                                    │ Monitor externo (BetterStack/ │
                                    │ UptimeRobot) → alerta         │
                                    └───────────────────────────────┘
```

**Princípios**
1. **Uma fonte de verdade por dado.** Config no git (validado, versionado, com `.bak`); sessão e conversas **fora** do git; status em arquivo local com TTL.
2. **Nada destrutivo automático.** Exclusão só por comando explícito, com lixeira e TTL.
3. **Saúde observável.** `/status` + `bot-status.json` fresco + Zap `ready`; restart automático; alerta externo.
4. **Shutdown gracioso sempre.** SIGTERM → flush → disconnect → exit ≤ 20 s; `TimeoutStopSec=90`.
5. **Pareamento sob demanda.** Painel pede conexão; servidor executa; QR sobe pelo status server.
6. **Anti-ban por design.** Limites, jitter, aquecimento, número dedicado, aviso legal.
7. **Segredos no cofre.** `safeStorage`/secret manager; nunca em JSON versionado nem no renderer.
8. **Fallback controlado.** Um único ponto de fallback, só com modelos permitidos, com timeout.

**Migração sugerida (ordem)**
1. P0 de dados (itens 1–4) — 2 dias.
2. P0 de sessão/mensagens (5–8) — 3 dias.
3. P0 de segurança (9–10) — 1,5 dia.
4. VPS + healthcheck (11–12) — 3 dias.
5. P0 de resposta/áudio (13–14) — 1 dia.
6. P1 em duas ondas — 1–2 semanas.
7. Licenciamento/LGPD/termos — em paralelo, 1 semana.

---

## 12. Testes e validação

**Baseline (atual):** `npm test` → **192 testes / 8 suítes, todos verdes** (`run.js` 82 + `ai.js` 38 + `flow.js` 19 + `linux.js` 13 + `auto-msg.js` 14 + `agent.js` 12 + `audio.js` 6 + `config-safety.js` 8). Bloqueio 1 (segurança de dados — `.bak`, `trash`, validação de schema) e Bloqueio 2 (sessão/mensagens — backlog, catch-up, resposta do dono sem `deviceType`, comparação `>` no `hasOwnerReplied`) concluídos e testados. CI em Node 20 com `PUPPETEER_SKIP_DOWNLOAD=1`. O teste "dono: markOwnerReply guarda o horario e só vale DEPOIS da mensagem" passa após ajuste de `t >= since` para `t > since` em `hasOwnerReplied`.

**Limitação:** todos usam mocks; **não há teste end-to-end com WhatsApp real nem teste de crash/restart**. Os P0 acima passam nos testes atuais.

**Testes que faltam (prioridade)**
1. Config corrompida/vazia: app não apaga nada; entra em modo seguro.
2. `save-zaps([])` rejeitado; `zaps.json` com `.bak` restaurado.
3. Reconciliador não remove sessão sem `deletedZaps` explícito.
4. SIGTERM headless: `flush` + `disconnectAll` chamados; arquivo íntegro.
5. Mensagem recebida em `authenticated` → enviada após `ready`.
6. Backlog: mensagens anteriores ao pareamento respondidas uma única vez.
7. Dono responde (sem `deviceType`) → bot não responde. *[Em andamento - P0 de O1/O2]*
8. Dono responde no mesmo segundo → bot não responde. *[Fixed: t > since]*
9. Dono responde no meio do multi-parte → todas as partes enviadas.
10. Timeout de IA/transcrição → fila liberada, erro amigável.
11. Roteamento de áudio por provedor (matriz completa).
12. `message-guard` com corpus real (não rejeitar venda legítima).
13. Virada de dia com `TZ=America/Sao_Paulo`.
14. `work-hours` 22:00–06:00 com `days=[segunda]` às 02:00 de terça → aberto.
15. Sync do servidor com JSON inválido → não aplica.
16. Healthcheck: app vivo + WhatsApp morto → restart.
17. `@lid` e `@c.us` do mesmo contato → uma fila só.
18. Auto-message: limites diários/horários respeitados.

**Teste de fumaça recomendado (manual, por release)**
- Parear número novo → receber texto → receber áudio → resposta multi-parte → dono responde no meio → reiniciar servidor → mensagem durante queda → conferir resposta única.
- Simular queda de rede (desligar Wi-Fi 60 s) e conferir reconexão + backlog.
- `kill -TERM` e conferir integridade de `conversations.json` e sessão.

---

## 13. Conclusão

O produto tem uma base funcional real e um caminho claro para comercialização, mas hoje **não é seguro vender**: os riscos de perda de dados (G1–G4), de o bot falar por cima do dono (O1–O2) e de o "24h" não ser 24h (S1, S3, S6) são exatamente os que geram reembolso e dano reputacional.

A boa notícia: os P0 são concentrados e corrigíveis em **~2 semanas** de trabalho focado, sem reescrever a arquitetura. A ordem recomendada é dados → sessão → segurança → infraestrutura → resposta/áudio → P1 → jurídico/comercial.
