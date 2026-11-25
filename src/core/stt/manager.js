'use strict';

// Orquestrador do servico de transcricao local.
//
// Recebe o audio JA BAIXADO e VALIDADO pelo pipeline existente, aplica cache,
// guarda de recursos, fila justa, motor local e pos-filtro de texto. E o unico
// ponto que o restante do sistema conhece.
//
// Isolamento multiusuario: cada chamada carrega zapId/msgId, nao existe estado
// global de "ultimo texto". O texto volta para a mesma tarefa de origem.

const { validateAudio, toBuffer } = require('../audio/validator');
const { normalizeTranscript, isUsableTranscript } = require('../audio/transcript');

function sttError(message, options = {}) {
  const err = new Error(message);
  err.kind = options.kind || 'unknown';
  err.defer = !!options.defer;
  if (options.code) err.code = options.code;
  return err;
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(sttError(`${label || 'stt'} excedeu ${ms}ms`, { kind: 'timeout', defer: true, code: 'STT_TIMEOUT' }));
    }, Math.max(1000, ms));
    if (typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise).then(
      (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } },
      (err) => { if (!done) { done = true; clearTimeout(timer); reject(err); } }
    );
  });
}

class SttManager {
  constructor(options = {}) {
    this.config = options.config;
    if (!this.config) throw new Error('SttManager: config obrigatorio');
    this.engine = options.engine;
    this.cache = options.cache;
    this.gate = options.gate;
    this.guard = options.guard;
    this.metrics = options.metrics;
    this.processor = options.processor;
    this.fallback = typeof options.fallback === 'function' ? options.fallback : null;
    this.logger = typeof options.logger === 'function' ? options.logger : () => {};
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
  }

  get model() {
    return `${this.config.model}:${this.config.lang}`;
  }

  // Canary: quando LINK_STT_CANARY_ZAPS esta definido, so esses zaps usam o
  // motor local; os demais seguem no caminho antigo (API) sem alteracao.
  enabledFor(zapId) {
    if (!this.config.enabled) return false;
    if (this.config.engine === 'api') return false;
    const canary = this.config.canaryZaps || [];
    if (canary.length && !canary.map(String).includes(String(zapId))) return false;
    return true;
  }

  timeoutFor(durationSec) {
    const base = Number(this.config.jobTimeoutBaseMs) || 30000;
    const factor = Number(this.config.jobTimeoutFactor) || 3;
    const max = Number(this.config.jobTimeoutMaxMs) || 300000;
    const dur = Math.max(0, Number(durationSec) || 0);
    return Math.min(max, Math.max(base, base + Math.round(factor * dur * 1000)));
  }

  cacheKey(hash) {
    return `${hash}:${this.config.model}:${this.config.lang}`;
  }

  async selfCheck() {
    try {
      const health = await this.engine.health(true);
      this._lastHealth = health;
      if (health.ok) {
        this.logger('info', `motor local pronto (${this.engine.describe}, modelo ${this.config.model})`);
      } else {
        this.logger('error', `motor local indisponivel: ${health.error || 'sem resposta'}. Audios ficarao na fila ate o servico subir (sem gastar API). Para usar a API externa: LINK_STT_ENGINE=api no .env.`);
      }
      return health;
    } catch (e) {
      this.logger('error', `verificacao do motor local falhou: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  // Processa uma tarefa. Devolve { text, engine, model, cached, sttMs, ... }.
  // Erros com `defer=true` significam "tente depois, nao e falha do audio".
  async transcribe(input = {}) {
    const zapId = String(input.zapId || '');
    if (!zapId) throw sttError('zapId obrigatorio na transcricao', { kind: 'permanent' });
    if (!this.config.enabled || this.config.engine === 'api') {
      throw sttError('motor local desligado', { kind: 'permanent', defer: true, code: 'STT_DISABLED' });
    }

    const startedAt = this.now();
    this.metrics.recordReceived(zapId);

    const buffer = toBuffer(input.buffer);
    const check = validateAudio(buffer, { mimetype: input.mimetype });
    if (!check.ok) {
      const err = sttError(`audio invalido: ${check.reason}`, { kind: check.kind || 'corrupt', defer: false });
      this.metrics.recordFailed({ zapId, kind: err.kind });
      throw err;
    }

    const hash = this.processor.sha256(check.buffer);
    const key = this.cacheKey(hash);

    const hit = this.cache.get(key);
    if (hit) {
      const sttMs = 0;
      const queueWaitMs = 0;
      this.metrics.recordCompleted({ zapId, sttMs, queueWaitMs, cached: true });
      this.logger('info', 'transcricao reutilizada do cache', {
        zapId,
        msgId: input.msgId || '',
        sha256: hash.slice(0, 12),
        chars: hit.text.length
      });
      return {
        text: hit.text,
        engine: hit.engine || 'cache',
        model: hit.model || this.config.model,
        lang: hit.lang || this.config.lang,
        cached: true,
        sttMs,
        queueWaitMs,
        sha256: hash,
        durationSec: 0
      };
    }

    try {
      return await this._runLocal({ input, zapId, buffer: check.buffer, mimetype: check.mimetype, hash, key, startedAt });
    } catch (e) {
      const original = e || sttError('falha desconhecida');

      // Fallback externo: so quando explicitamente habilitado e somente para
      // falha de infraestrutura (motor fora do ar). Audio invalido/sem fala
      // nao deve gastar API.
      if (original.defer && this.config.fallbackApi && this.fallback) {
        try {
          this.logger('warning', 'motor local indisponivel; tentando fallback externo', {
            zapId,
            motivo: original.message
          });
          const text = normalizeTranscript(await this.fallback({
            buffer: check.buffer,
            mimetype: check.mimetype,
            zapId,
            msgId: input.msgId || ''
          }));
          if (!isUsableTranscript(text)) throw sttError('fallback externo devolveu texto vazio', { kind: 'empty' });
          this.cache.set(key, {
            text,
            engine: 'api',
            model: 'external',
            lang: this.config.lang,
            sha256: hash,
            sttMs: 0
          });
          const result = {
            text,
            engine: 'api-fallback',
            model: 'external',
            lang: this.config.lang,
            cached: false,
            fallback: true,
            sttMs: this.now() - startedAt,
            queueWaitMs: 0,
            sha256: hash,
            durationSec: 0
          };
          this.metrics.recordCompleted({ zapId, sttMs: result.sttMs, queueWaitMs: 0, cached: false });
          return result;
        } catch (fbErr) {
          original.fallbackError = fbErr.message;
        }
      }

      if (!original.defer) {
        this.metrics.recordFailed({ zapId, kind: original.kind || 'unknown' });
      }
      throw original;
    }
  }

  async _runLocal(ctx) {
    const { input, zapId, buffer, mimetype, hash, key, startedAt } = ctx;

    const guard = this.guard.check();
    if (!guard.ok) {
      throw sttError(`recursos insuficientes para transcrever: ${guard.reason}`, {
        kind: 'resource',
        defer: true,
        code: 'STT_RESOURCE'
      });
    }

    const acquiredAt = this.now();
    const release = await this.gate.acquire({ zapId, jobKey: key });
    const queueWaitMs = this.now() - acquiredAt;

    let prepared;
    let result;
    try {
      // Outra tarefa com o mesmo conteudo pode ter terminado enquanto esta
      // esperava a vaga. Reconfere o cache antes de gastar CPU com FFmpeg.
      const hitAfterWait = this.cache.get(key);
      if (hitAfterWait) {
        this.metrics.recordCompleted({ zapId, sttMs: 0, queueWaitMs, cached: true });
        this.logger('info', 'transcricao reutilizada do cache apos espera', {
          zapId,
          msgId: input.msgId || '',
          queueWaitMs,
          chars: hitAfterWait.text.length
        });
        return {
          text: hitAfterWait.text,
          engine: hitAfterWait.engine || 'cache',
          model: hitAfterWait.model || this.config.model,
          lang: hitAfterWait.lang || this.config.lang,
          cached: true,
          sttMs: 0,
          queueWaitMs,
          sha256: hash,
          durationSec: Number(input.durationSec) || 0
        };
      }

      try {
        prepared = await this.processor.process(buffer, mimetype, { durationSec: input.durationSec });
      } catch (e) {
        const unavailable = /ENOENT|EACCES|spawn .* (ffmpeg|ffprobe)|command not found/i.test(String(e.message || ''));
        throw sttError(e.message, {
          kind: unavailable ? 'infra' : (e.kind || 'corrupt'),
          defer: !!e.defer || unavailable,
          code: e.code
        });
      }

      if (prepared.silent) {
        throw sttError(`audio sem fala detectavel (${prepared.meanVolumeDb} dB)`, {
          kind: 'empty',
          defer: false,
          code: 'STT_SILENT'
        });
      }

      try {
        const timeoutMs = this.timeoutFor(prepared.durationSec);
        result = await withTimeout(this.engine.transcribe({
          wav: prepared.wav,
          lang: this.config.lang,
          durationSec: prepared.durationSec,
          job: { zapId, msgId: input.msgId || '', msgKey: input.msgKey || '' }
        }), timeoutMs, 'transcricao local');
      } catch (e) {
        throw sttError(e.message, { kind: e.kind || 'transient', defer: !!e.defer, code: e.code });
      }
    } finally {
      release();
    }

    const text = normalizeTranscript(result && result.text);
    if (!isUsableTranscript(text)) {
      throw sttError('transcricao vazia ou sem fala', { kind: 'empty', defer: false, code: 'STT_EMPTY' });
    }

    const sttMs = Number(result.sttMs) || Math.max(0, this.now() - startedAt - queueWaitMs);
    const engineName = result.engine || this.engine.name;
    const model = result.model || this.config.model;

    this.cache.set(key, {
      text,
      engine: engineName,
      model,
      lang: result.lang || this.config.lang,
      sha256: hash,
      sttMs
    });
    this.metrics.recordCompleted({ zapId, sttMs, queueWaitMs, cached: false });

    this.logger('success', 'audio transcrito localmente', {
      zapId,
      msgId: input.msgId || '',
      engine: engineName,
      model,
      durationSec: Math.round((prepared.durationSec || 0) * 10) / 10,
      queueWaitMs,
      sttMs,
      chars: text.length
    });

    return {
      text,
      engine: engineName,
      model,
      lang: result.lang || this.config.lang,
      cached: false,
      sttMs,
      queueWaitMs,
      sha256: hash,
      durationSec: prepared.durationSec
    };
  }

  stats() {
    const metrics = this.metrics.snapshot();
    return {
      enabled: this.config.enabled && this.config.engine !== 'api',
      engineMode: this.config.engine,
      describe: this.engine.describe,
      config: {
        model: this.config.model,
        lang: this.config.lang,
        threads: this.config.threads,
        concurrency: this.config.concurrency,
        fallbackApi: this.config.fallbackApi,
        canaryZaps: this.config.canaryZaps.length,
        cacheMaxMB: this.config.cacheMaxMB
      },
      engine: {
        ...this.engine.stats(),
        healthy: this._lastHealth ? this._lastHealth.ok : null,
        lastError: this._lastHealth ? this._lastHealth.error : ''
      },
      queue: this.gate.stats(),
      resources: this.guard.stats(),
      cache: this.cache.stats(),
      metrics,
      totals: metrics.totals,
      timing: { stt: metrics.stt, queue: metrics.queue },
      rates: metrics.rates,
      clients: metrics.clients
    };
  }

  async refreshHealth() {
    this._lastHealth = await this.engine.health(false);
    return this._lastHealth;
  }
}

module.exports = { SttManager, sttError, withTimeout };
