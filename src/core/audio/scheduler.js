'use strict';

// Agendador de audio com isolamento por empresa/zap.
//
// O bot atende varias conexoes ao mesmo tempo. Sem limite, uma rajada de
// audios de um cliente monopoliza a fila e os outros ficam sem resposta.
// Este agendador aplica:
// - limite global de tarefas simultaneas
// - limite por zap (conta/empresa)
// - backpressure: acima de `maxPending` a tarefa e recusada e fica para retry
//
// A ordem de chegada e preservada dentro de cada chave (FIFO).

class AudioScheduler {
  constructor(options = {}) {
    this.maxConcurrent = Math.max(1, Number(options.maxConcurrent) || 2);
    this.maxPerKey = Math.max(1, Number(options.maxPerKey) || 1);
    this.maxPending = Math.max(1, Number(options.maxPending) || 200);
    this.active = 0;
    this.pending = 0;
    this.keyActive = new Map();
    this.waiters = [];
    this.rejected = 0;
  }

  async run(key, fn) {
    const k = String(key || 'default');
    if (this.pending >= this.maxPending) {
      const err = new Error('fila de audio cheia (backpressure)');
      err.code = 'QUEUE_FULL';
      this.rejected++;
      throw err;
    }
    this.pending++;
    try {
      await this._acquire(k);
      try {
        return await fn();
      } finally {
        this._release(k);
      }
    } finally {
      this.pending--;
    }
  }

  _acquire(key) {
    return new Promise((resolve) => {
      this.waiters.push({ key, resolve });
      this._pump();
    });
  }

  _pump() {
    for (let i = 0; i < this.waiters.length; i++) {
      if (this.active >= this.maxConcurrent) break;
      const w = this.waiters[i];
      const used = this.keyActive.get(w.key) || 0;
      if (used >= this.maxPerKey) continue;
      this.waiters.splice(i, 1);
      i--;
      this.active++;
      this.keyActive.set(w.key, used + 1);
      w.resolve();
    }
  }

  _release(key) {
    this.active = Math.max(0, this.active - 1);
    const used = (this.keyActive.get(key) || 1) - 1;
    if (used <= 0) this.keyActive.delete(key);
    else this.keyActive.set(key, used);
    this._pump();
  }

  stats() {
    return {
      active: this.active,
      pending: this.pending,
      waiting: this.waiters.length,
      rejected: this.rejected,
      keys: this.keyActive.size,
      maxConcurrent: this.maxConcurrent,
      maxPerKey: this.maxPerKey
    };
  }
}

module.exports = { AudioScheduler };
