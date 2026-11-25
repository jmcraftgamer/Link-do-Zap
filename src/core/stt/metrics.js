'use strict';

// Metricas do servico de transcricao.
//
// Contadores acumulados sobrevivem a reinicio (arquivo pequeno, escrita
// atomica a cada 30 s). Percentis e taxas ficam em memoria: sao janela movel e
// nao fazem sentido depois de um reboot.

const fs = require('fs');
const path = require('path');

const MAX_SAMPLES = 400;
const RATE_WINDOW_MS = 10 * 60 * 1000;

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

class SttMetrics {
  constructor(options = {}) {
    this.filePath = options.filePath || '';
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.logger = typeof options.logger === 'function' ? options.logger : () => {};
    this.flushMs = Math.max(5000, Number(options.flushMs) || 30000);
    this.startedAt = this.now();

    this.totals = {
      received: 0,
      completed: 0,
      failed: 0,
      cached: 0,
      engineRestarts: 0,
      sttMsSum: 0,
      sttMsCount: 0,
      queueMsSum: 0,
      queueMsCount: 0
    };
    this.samples = { stt: [], queue: [] };
    this.rates = [];
    this.zaps = new Map();
    this.timer = null;
    this.loaded = false;
    this.dirty = false;
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    if (!this.filePath) return this;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const t = raw && raw.totals ? raw.totals : null;
      if (t) {
        for (const key of Object.keys(this.totals)) {
          const n = Number(t[key]);
          if (Number.isFinite(n) && n >= 0) this.totals[key] = n;
        }
        if (raw.since) this.persistedSince = raw.since;
      }
    } catch (_) { /* arquivo ausente ou corrompido: comeca do zero */ }
    return this;
  }

  start() {
    if (this.timer || !this.filePath) return this;
    this.timer = setInterval(() => this.flush(), this.flushMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }

  flush() {
    if (!this.filePath || !this.dirty) return;
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const payload = JSON.stringify({
        version: 1,
        since: this.persistedSince || new Date(this.startedAt).toISOString(),
        updatedAt: new Date(this.now()).toISOString(),
        totals: this.totals
      });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, this.filePath);
      this.dirty = false;
    } catch (e) {
      this.logger('warning', `falha ao gravar metricas de STT: ${e.message}`);
    }
  }

  _zap(zapId) {
    const key = String(zapId || 'unknown');
    let z = this.zaps.get(key);
    if (!z) {
      if (this.zaps.size >= 500) {
        const first = this.zaps.keys().next();
        if (!first.done) this.zaps.delete(first.value);
      }
      z = { received: 0, completed: 0, failed: 0, cached: 0, lastAt: 0 };
      this.zaps.set(key, z);
    }
    return z;
  }

  _rate(kind) {
    const now = this.now();
    this.rates.push({ t: now, kind });
    if (this.rates.length > 5000) this.rates.splice(0, this.rates.length - 5000);
    const cutoff = now - RATE_WINDOW_MS;
    while (this.rates.length && this.rates[0].t < cutoff) this.rates.shift();
  }

  recordReceived(zapId) {
    this.totals.received++;
    this._zap(zapId).received++;
    this._rate('in');
    this.dirty = true;
  }

  recordCompleted(info = {}) {
    const sttMs = Math.max(0, Number(info.sttMs) || 0);
    const queueMs = Math.max(0, Number(info.queueWaitMs) || 0);
    this.totals.completed++;
    this.totals.sttMsSum += sttMs;
    this.totals.sttMsCount++;
    this.totals.queueMsSum += queueMs;
    this.totals.queueMsCount++;
    if (info.cached) this.totals.cached++;
    this._push('stt', sttMs);
    this._push('queue', queueMs);
    const z = this._zap(info.zapId);
    z.completed++;
    if (info.cached) z.cached++;
    z.lastAt = this.now();
    this._rate('done');
    this.dirty = true;
  }

  recordFailed(info = {}) {
    this.totals.failed++;
    const z = this._zap(info.zapId);
    z.failed++;
    z.lastAt = this.now();
    this._rate('fail');
    this.dirty = true;
  }

  recordEngineRestart() {
    this.totals.engineRestarts++;
    this.dirty = true;
  }

  _push(kind, value) {
    const arr = this.samples[kind];
    arr.push(Number(value) || 0);
    if (arr.length > MAX_SAMPLES) arr.shift();
  }

  _summary(arr) {
    if (!arr.length) return { p50: 0, p95: 0, avg: 0, count: 0 };
    const sorted = [...arr].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      avg: Math.round(sum / sorted.length),
      count: sorted.length
    };
  }

  _rates() {
    const now = this.now();
    const lastMin = now - 60000;
    const lastFive = now - 5 * 60000;
    let inMin = 0;
    let doneMin = 0;
    let inFive = 0;
    let doneFive = 0;
    for (let i = this.rates.length - 1; i >= 0; i--) {
      const r = this.rates[i];
      if (r.t < lastFive) break;
      if (r.t >= lastMin) {
        if (r.kind === 'in') inMin++;
        if (r.kind === 'done') doneMin++;
      }
      if (r.kind === 'in') inFive++;
      if (r.kind === 'done') doneFive++;
    }
    let backlogTrend = 'stable';
    const pressure = doneFive ? inFive / doneFive : (inFive ? 2 : 1);
    if (pressure > 1.2) backlogTrend = 'up';
    else if (pressure < 0.8) backlogTrend = 'down';
    return {
      arrivalPerMin: inMin,
      donePerMin: doneMin,
      last5min: { in: inFive, done: doneFive },
      backlogTrend,
      pressure: Math.round(pressure * 100) / 100
    };
  }

  snapshot() {
    const t = this.totals;
    const zaps = {};
    for (const [id, z] of this.zaps) zaps[id] = { ...z };
    return {
      since: this.persistedSince || new Date(this.startedAt).toISOString(),
      uptimeSec: Math.round((this.now() - this.startedAt) / 1000),
      totals: {
        received: t.received,
        completed: t.completed,
        failed: t.failed,
        cached: t.cached,
        engineRestarts: t.engineRestarts
      },
      stt: this._summary(this.samples.stt),
      queue: this._summary(this.samples.queue),
      rates: this._rates(),
      clients: { active: this.zaps.size, zaps },
      totalsPersistedAt: this.persistedSince || null
    };
  }
}

module.exports = { SttMetrics, percentile };
