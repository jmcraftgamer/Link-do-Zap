'use strict';

// Admissao justa das tarefas de transcricao.
//
// Um unico modelo atende todos os clientes. Sem controle, um cliente que manda
// 50 audios ocuparia a CPU e os demais ficariam sem resposta. Aqui:
// - no maximo `maxConcurrent` transcricoes ao mesmo tempo (1 em 1 vCPU);
// - no maximo `maxPerZap` por conexao (evita monopolio);
// - round-robin entre zaps (quem chegou depois de outro cliente passa a vez);
// - aging: quem espera demais fura a rotacao uma vez;
// - espera maxima gera `defer` (a tarefa volta para a fila persistente, nunca
//   e descartada).

class SttGate {
  constructor(options = {}) {
    this.maxConcurrent = Math.max(1, Number(options.maxConcurrent) || 1);
    this.maxPerZap = Math.max(1, Number(options.maxPerZap) || 1);
    this.maxQueueWaitMs = Math.max(1000, Number(options.maxQueueWaitMs) || 90000);
    this.agingMs = Math.max(5000, Number(options.agingMs) || 60000);
    this.maxQueued = Math.max(10, Number(options.maxQueued) || 1000);
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.logger = typeof options.logger === 'function' ? options.logger : () => {};

    this.active = 0;
    this.waiters = [];
    this.activeZap = new Map();
    this.cursor = 0;
    this.enqueued = 0;
    this.started = 0;
    this.rejected = 0;
  }

  acquire(meta = {}) {
    const zapId = String(meta.zapId || 'default');
    const jobKey = String(meta.jobKey || '');

    if (this.waiters.length >= this.maxQueued) {
      this.rejected++;
      return Promise.reject(this._deferError('fila de STT cheia'));
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        zapId,
        jobKey,
        at: this.now(),
        done: false,
        resolve,
        reject,
        timer: null
      };
      waiter.timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx === -1) return; // ja foi atendido
        this.waiters.splice(idx, 1);
        this.rejected++;
        waiter.done = true;
        reject(this._deferError('tempo maximo de espera na fila de STT excedido'));
      }, this.maxQueueWaitMs);
      // Sem unref: enquanto houver tarefa esperando, o processo tem trabalho
      // pendente. O timer e curto (no maximo maxQueueWaitMs) e nao vaza.

      this.waiters.push(waiter);
      this.enqueued++;
      this._pump();
    });
  }

  _deferError(message) {
    const err = new Error(message);
    err.code = 'STT_QUEUE_WAIT';
    err.kind = 'transient';
    err.defer = true;
    return err;
  }

  _pick() {
    if (!this.waiters.length) return null;
    const now = this.now();

    // Aging: o mais antigo passa a vez se ja esperou o suficiente.
    let aged = null;
    for (const w of this.waiters) {
      if (now - w.at < this.agingMs) continue;
      if ((this.activeZap.get(w.zapId) || 0) >= this.maxPerZap) continue;
      if (!aged || w.at < aged.at) aged = w;
    }
    if (aged) return aged;

    const order = [];
    const byZap = new Map();
    for (const w of this.waiters) {
      if (!byZap.has(w.zapId)) {
        byZap.set(w.zapId, []);
        order.push(w.zapId);
      }
      byZap.get(w.zapId).push(w);
    }
    if (!order.length) return null;

    const start = Math.abs(this.cursor) % order.length;
    for (let i = 0; i < order.length; i++) {
      const zapId = order[(start + i) % order.length];
      if ((this.activeZap.get(zapId) || 0) >= this.maxPerZap) continue;
      const waiter = byZap.get(zapId)[0];
      // Cursor monotonico (o modulo e aplicado na leitura): se fosse reduzido
      // ao tamanho atual, uma fila pequena voltaria sempre ao primeiro zap.
      this.cursor = this.cursor + i + 1;
      return waiter;
    }
    return null;
  }

  _pump() {
    while (this.active < this.maxConcurrent) {
      const waiter = this._pick();
      if (!waiter) break;
      const idx = this.waiters.indexOf(waiter);
      if (idx === -1) continue;
      this.waiters.splice(idx, 1);
      if (waiter.done) continue;
      waiter.done = true;
      if (waiter.timer) clearTimeout(waiter.timer);

      this.active++;
      this.started++;
      this.activeZap.set(waiter.zapId, (this.activeZap.get(waiter.zapId) || 0) + 1);

      const waitMs = this.now() - waiter.at;
      if (waitMs > 5000) {
        this.logger('info', 'tarefa de STT aguardou na fila', { zapId: waiter.zapId, waitMs });
      }

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        const used = (this.activeZap.get(waiter.zapId) || 1) - 1;
        if (used <= 0) this.activeZap.delete(waiter.zapId);
        else this.activeZap.set(waiter.zapId, used);
        this._pump();
      };
      waiter.resolve(release);
    }
  }

  stats() {
    const byZap = {};
    let oldestWaitMs = 0;
    const now = this.now();
    for (const w of this.waiters) {
      byZap[w.zapId] = (byZap[w.zapId] || 0) + 1;
      const wait = now - w.at;
      if (wait > oldestWaitMs) oldestWaitMs = wait;
    }
    return {
      active: this.active,
      waiting: this.waiters.length,
      byZap,
      oldestWaitMs,
      enqueued: this.enqueued,
      started: this.started,
      rejected: this.rejected,
      maxConcurrent: this.maxConcurrent,
      maxPerZap: this.maxPerZap
    };
  }
}

module.exports = { SttGate };
