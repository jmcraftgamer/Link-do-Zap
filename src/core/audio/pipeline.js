'use strict';

// Orquestrador do processamento de audio.
//
// Fluxo de uma tarefa:
//   QUEUED -> DOWNLOADING -> VALIDATING -> TRANSCRIBING -> COMPLETED
//                    \-> RETRYING (backoff)  \-> DEAD_LETTER (sem reenvio)
//
// O download e a transcricao sao injetados (handlers), o que mantem este
// modulo independente de Electron/WhatsApp e permite testar cada falha.
// Nada aqui inventa endpoints: os handlers usam os mecanismos reais do
// projeto (CDN+mediaKey, DownloadManager da pagina, Whisper/Gemini).

const { classifyAudioError, errorText } = require('./errors');
const { validateAudio } = require('./validator');
const { normalizeTranscript, isUsableTranscript } = require('./transcript');

const DEFAULT_CONFIG = {
  downloadAttempts: 4,
  transcribeAttempts: 2,
  baseDelayMs: 700,
  maxDelayMs: 8000,
  jitterRatio: 0.25,
  downloadTimeoutMs: 60000,
  // Audios longos no motor local nao podem morrer no timeout fixo antigo.
  transcribeTimeoutMs: 180000,
  // Falha de infraestrutura (motor fora do ar, fila cheia, pouca RAM) nao
  // consome tentativa: a tarefa volta para RETRYING. Depois deste limite ela
  // passa pelo fluxo normal (e pode ir para a DLQ) para nao girar para sempre.
  maxTranscribeDefers: 10,
  minTextChars: 2,
  maxTextChars: 8000
};

function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const err = new Error(`${label || 'operacao'} excedeu ${ms}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise).then(
      (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } },
      (err) => { if (!done) { done = true; clearTimeout(timer); reject(err); } }
    );
  });
}

function cleanText(value) {
  return normalizeTranscript(value);
}

// Handlers antigos devolvem string; o motor local devolve tambem metadados
// (engine, model, tempo, sha256). Aceitar os dois mantem compatibilidade.
function normalizeTranscribeResult(raw) {
  if (raw && typeof raw === 'object' && typeof raw.text === 'string') {
    const { text, ...meta } = raw;
    return { text, meta };
  }
  return { text: raw == null ? '' : String(raw), meta: {} };
}

class AudioPipeline {
  constructor(options = {}) {
    if (!options.store) throw new Error('AudioPipeline: store obrigatorio');
    this.store = options.store;
    this.scheduler = options.scheduler || null;
    this.logger = typeof options.logger === 'function' ? options.logger : () => {};
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.sleep = typeof options.sleep === 'function'
      ? options.sleep
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    this.random = typeof options.random === 'function' ? options.random : Math.random;
    this.config = { ...DEFAULT_CONFIG, ...(options.config || {}) };
    this.snapshot = { processed: 0, completed: 0, deadLetters: 0, retries: 0, deferred: 0 };
  }

  begin(meta) {
    const result = this.store.begin(meta);
    if (!result.duplicate) {
      this.logger('info', 'audio recebido', {
        zapId: result.task.zapId,
        msgId: result.task.msgId,
        chatId: result.task.chatId,
        key: result.task.key
      });
    }
    return result;
  }

  backoffMs(attempt) {
    const exp = Math.min(
      this.config.maxDelayMs,
      this.config.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1))
    );
    const jitter = exp * this.config.jitterRatio * this.random();
    return Math.round(exp + jitter);
  }

  async run(taskKey, handlers = {}) {
    const task = this.store.get(taskKey);
    if (!task) throw new Error(`tarefa de audio nao encontrada: ${taskKey}`);
    if (typeof handlers.download !== 'function') throw new Error('AudioPipeline.run: handlers.download obrigatorio');
    if (typeof handlers.transcribe !== 'function') throw new Error('AudioPipeline.run: handlers.transcribe obrigatorio');

    const startedAt = this.now();

    // O scheduler protege o DOWNLOAD (varios Chromium/rede ao mesmo tempo).
    // A transcricao tem o seu proprio controle no motor local (SttGate), com
    // concorrencia 1. Assim uma tarefa esperando o modelo nao segura a vaga de
    // download de outro cliente.
    const work = async () => {
      const download = () => this._download(task, handlers);
      const audio = this.scheduler
        ? await this.scheduler.run(task.zapId, download)
        : await download();
      if (!audio.ok) return audio;
      const text = await this._transcribe(task, audio, handlers);
      if (!text.ok) return text;
      const totalMs = this.now() - startedAt;
      this.store.update(task.key, {
        state: 'TRANSCRIBED',
        text: text.text.slice(0, this.config.maxTextChars),
        method: audio.method || task.method,
        bytes: audio.size,
        mime: audio.mimetype,
        durationMs: totalMs,
        sttMs: text.sttMs || 0,
        queueWaitMs: text.queueWaitMs || 0,
        engine: text.engine || '',
        model: text.model || '',
        sha256: text.sha256 || '',
        deferCount: 0
      });
      this.snapshot.processed++;
      this.snapshot.completed++;
      this.logger('success', 'audio processado', {
        zapId: task.zapId,
        msgId: task.msgId,
        method: audio.method || '',
        engine: text.engine || '',
        cached: !!text.cached,
        attempts: audio.attempts,
        transcribeAttempts: text.attempts,
        bytes: audio.size,
        mime: audio.mimetype,
        durationMs: totalMs,
        sttMs: text.sttMs || 0,
        queueWaitMs: text.queueWaitMs || 0,
        textChars: text.text.length
      });
      return {
        ok: true,
        text: text.text,
        size: audio.size,
        mimetype: audio.mimetype,
        method: audio.method || '',
        engine: text.engine || '',
        model: text.model || '',
        cached: !!text.cached,
        sttMs: text.sttMs || 0,
        queueWaitMs: text.queueWaitMs || 0,
        downloadAttempts: audio.attempts,
        transcribeAttempts: text.attempts,
        durationMs: totalMs
      };
    };

    try {
      return await work();
    } catch (e) {
      // Falha de infraestrutura (ex.: backpressure/fila cheia). Mantem a tarefa
      // viva em RETRYING para o proximo ciclo, sem marcar falha definitiva.
      const cls = classifyAudioError(e);
      this.store.recordAttempt(task.key, { state: task.state, kind: cls.kind, message: errorText(e) });
      this.store.transition(task.key, 'RETRYING', { lastError: errorText(e) });
      this.logger('warning', 'audio adiado para nova tentativa', {
        zapId: task.zapId,
        msgId: task.msgId,
        error: errorText(e),
        kind: cls.kind
      });
      return { ok: false, retryLater: true, error: errorText(e), kind: cls.kind };
    }
  }

  async _download(task, handlers) {
    const cfg = this.config;
    let last = null;
    let lastKind = '';
    for (let attempt = 1; attempt <= cfg.downloadAttempts; attempt++) {
      this.store.transition(task.key, 'DOWNLOADING', { downloadAttempts: attempt });
      const t0 = this.now();
      try {
        const raw = await withTimeout(
          handlers.download(task, { attempt, refresh: attempt > 1 }),
          cfg.downloadTimeoutMs,
          'download de audio'
        );
        if (!raw) throw new Error('download retornou vazio');
        const buf = raw.buffer || raw.data || raw;
        const expectedMime = raw.mimetype || task.mimetype;
        const check = validateAudio(buf, { mimetype: expectedMime });
        if (!check.ok) {
          const err = new Error(check.reason || 'audio invalido');
          err.validationKind = check.kind;
          throw err;
        }
        const method = raw.method || raw.via || `attempt-${attempt}`;
        const elapsed = this.now() - t0;
        this.store.transition(task.key, 'VALIDATING', {
          bytes: check.size,
          mime: check.mimetype,
          method,
          downloadAttempts: attempt
        });

        let prepared = { buffer: check.buffer, mimetype: check.mimetype, size: check.size };
        if (typeof handlers.prepare === 'function') {
          prepared = await withTimeout(
            handlers.prepare(prepared, task),
            cfg.downloadTimeoutMs,
            'preparacao do audio'
          ) || prepared;
          if (!prepared.buffer || !prepared.buffer.length) throw new Error('preparacao retornou audio vazio');
        }

        this.logger('info', 'audio baixado e validado', {
          zapId: task.zapId,
          msgId: task.msgId,
          attempt,
          method,
          bytes: prepared.size,
          mime: prepared.mimetype,
          durationSec: prepared.durationSec || 0,
          converted: !!prepared.converted,
          durationMs: elapsed
        });
        return {
          ok: true,
          data: prepared.buffer.toString('base64'),
          buffer: prepared.buffer,
          mimetype: prepared.mimetype,
          size: prepared.size,
          durationSec: prepared.durationSec || 0,
          method,
          attempts: attempt
        };
      } catch (e) {
        const cls = e && e.validationKind
          ? { kind: e.validationKind, retryable: e.validationKind !== 'limit' && e.validationKind !== 'unsupported', refresh: false }
          : classifyAudioError(e);
        last = e;
        lastKind = cls.kind;
        this.snapshot.retries++;
        this.store.recordAttempt(task.key, {
          state: 'DOWNLOADING',
          kind: cls.kind,
          method: `attempt-${attempt}`,
          message: errorText(e)
        });
        this.logger('warning', 'tentativa de download falhou', {
          zapId: task.zapId,
          msgId: task.msgId,
          attempt,
          maxAttempts: cfg.downloadAttempts,
          kind: cls.kind,
          retryable: cls.retryable,
          error: errorText(e)
        });
        if (!cls.retryable) break;
        if (attempt < cfg.downloadAttempts) {
          this.store.transition(task.key, 'RETRYING');
          await this.sleep(this.backoffMs(attempt));
        }
      }
    }
    return this._deadLetter(task, 'download', last, lastKind);
  }

  async _transcribe(task, audio, handlers) {
    const cfg = this.config;
    let last = null;
    let lastKind = '';
    for (let attempt = 1; attempt <= cfg.transcribeAttempts; attempt++) {
      this.store.transition(task.key, 'TRANSCRIBING', { transcribeAttempts: attempt });
      try {
        const raw = await withTimeout(
          handlers.transcribe(audio, task, { attempt }),
          cfg.transcribeTimeoutMs,
          'transcricao de audio'
        );
        const parsed = normalizeTranscribeResult(raw);
        const text = cleanText(parsed.text);
        if (!isUsableTranscript(text) || text.length < cfg.minTextChars) {
          const err = new Error('transcricao vazia ou inutilizavel');
          err.validationKind = 'empty';
          throw err;
        }
        this.logger('info', 'audio transcrito', {
          zapId: task.zapId,
          msgId: task.msgId,
          attempt,
          engine: parsed.meta.engine || '',
          chars: text.length
        });
        return {
          ok: true,
          text: text.slice(0, cfg.maxTextChars),
          attempts: attempt,
          ...parsed.meta
        };
      } catch (e) {
        // Falha de infraestrutura do motor local: nao e falha do audio.
        // Volta para a fila sem gastar tentativa, ate o limite de adiamentos.
        if (e && e.defer && !e.validationKind) {
          const defers = Number(task.deferCount || 0) + 1;
          this.store.update(task.key, { deferCount: defers });
          this.snapshot.deferred++;
          this.store.recordAttempt(task.key, {
            state: 'TRANSCRIBING',
            kind: e.kind || 'infra',
            method: 'transcribe',
            message: errorText(e)
          });
          if (defers <= cfg.maxTranscribeDefers) {
            this.store.transition(task.key, 'RETRYING', { lastError: errorText(e) });
            this.logger('warning', 'transcricao adiada (infraestrutura)', {
              zapId: task.zapId,
              msgId: task.msgId,
              defer: defers,
              maxDefers: cfg.maxTranscribeDefers,
              kind: e.kind || 'infra',
              error: errorText(e)
            });
            return {
              ok: false,
              retryLater: true,
              kind: e.kind || 'infra',
              defer: defers,
              error: errorText(e)
            };
          }
          this.logger('warning', 'limite de adiamentos de transcricao atingido', {
            zapId: task.zapId,
            msgId: task.msgId,
            defer: defers
          });
        }

        const cls = e && e.validationKind
          ? { kind: e.validationKind, retryable: e.validationKind !== 'limit' }
          : classifyAudioError(e);
        last = e;
        lastKind = cls.kind;
        this.store.recordAttempt(task.key, {
          state: 'TRANSCRIBING',
          kind: cls.kind,
          method: 'transcribe',
          message: errorText(e)
        });
        this.logger('warning', 'tentativa de transcricao falhou', {
          zapId: task.zapId,
          msgId: task.msgId,
          attempt,
          maxAttempts: cfg.transcribeAttempts,
          kind: cls.kind,
          retryable: cls.retryable,
          error: errorText(e)
        });
        if (!cls.retryable) break;
        if (attempt < cfg.transcribeAttempts) {
          this.store.transition(task.key, 'RETRYING');
          await this.sleep(this.backoffMs(attempt));
        }
      }
    }
    return this._deadLetter(task, 'transcribe', last, lastKind);
  }

  _deadLetter(task, stage, error, kind) {
    this.snapshot.deadLetters++;
    this.store.recordAttempt(task.key, {
      state: 'DEAD_LETTER',
      kind: kind || 'unknown',
      method: stage,
      message: errorText(error)
    });
    this.store.transition(task.key, 'DEAD_LETTER', {
      lastError: errorText(error),
      failureStage: stage
    });
    this.logger('error', 'audio na fila de falhas definitivas', {
      zapId: task.zapId,
      msgId: task.msgId,
      stage,
      kind: kind || 'unknown',
      error: errorText(error)
    });
    return {
      ok: false,
      deadLetter: true,
      stage,
      kind: kind || 'unknown',
      error: errorText(error)
    };
  }

  // Marca o resultado da etapa seguinte (IA/resposta) sem reabrir o audio.
  mark(taskKey, state, extra = {}) {
    return this.store.transition(taskKey, state, extra);
  }

  complete(taskKey, extra = {}) {
    return this.store.transition(taskKey, 'COMPLETED', extra);
  }

  failAI(taskKey, reason) {
    const task = this.store.get(taskKey);
    if (!task) return null;
    this.store.recordAttempt(taskKey, { state: 'AI_PROCESSING', kind: 'ai', message: reason || 'falha na IA' });
    return this.store.transition(taskKey, 'COMPLETED', { responseReason: String(reason || '').slice(0, 200) });
  }

  // Reabre uma tarefa da fila de falhas definitivas. Usado quando o operador
  // corrige a causa (chave de API, formatos) e quer reprocessar sem esperar
  // o cliente reenviar o audio.
  retryDeadLetter(taskKey) {
    const task = this.store.get(taskKey);
    if (!task || task.state !== 'DEAD_LETTER') return null;
    this.store.recordAttempt(taskKey, {
      state: 'DEAD_LETTER',
      kind: 'manual-retry',
      message: 'reprocessamento manual solicitado'
    });
    return this.store.transition(taskKey, 'QUEUED', {
      failureStage: '',
      lastError: ''
    });
  }

  // Tarefas retomaveis apos reinicio. Nao retoma quem ja estava na IA.
  recoverable(maxAgeMs = 24 * 60 * 60 * 1000) {
    const now = this.now();
    return this.store.pending().filter((t) => {
      if (now - t.createdAt > maxAgeMs) return false;
      return t.state !== 'AI_PROCESSING' && t.state !== 'RESPONDING';
    });
  }

  stats() {
    return { ...this.snapshot, store: this.store.stats(), scheduler: this.scheduler ? this.scheduler.stats() : null };
  }
}

module.exports = { AudioPipeline, DEFAULT_CONFIG, withTimeout, cleanText, normalizeTranscribeResult };
