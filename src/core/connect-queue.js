'use strict';

// Fila de conexao: limita quantos Chromium sobem ao mesmo tempo.
//
// Cada Zap abre um navegador proprio (puppeteer.launch). Sem limite, um
// servidor com 30 Zaps dispara 30 Chromium simultaneos no boot e o pico de
// memoria derruba a VPS. Esta fila deixa no maximo `maxConcurrent` subindo
// ao mesmo tempo, com um intervalo minimo entre cada inicio.
class ConnectQueue {
  constructor({ maxConcurrent = 2, minGapMs = 2000, maxHoldMs = 240000 } = {}) {
    this.maxConcurrent = Math.max(1, Number(maxConcurrent) || 1);
    this.minGapMs = Math.max(0, Number(minGapMs) || 0);
    this.maxHoldMs = Math.max(1000, Number(maxHoldMs) || 240000);
    this.active = 0;
    this.lastStart = 0;
    this._waiters = [];
    // Serializa a entrada: garante que dois pedidos nao passem juntos pelo
    // teste de vagas + intervalo minimo.
    this._gate = Promise.resolve();
  }

  get pending() {
    return this._waiters.length;
  }

  async acquire() {
    const previous = this._gate;
    let open;
    this._gate = new Promise((resolve) => { open = resolve; });
    await previous;
    try {
      while (this.active >= this.maxConcurrent) {
        await new Promise((resolve) => this._waiters.push(resolve));
      }
      const wait = this.minGapMs - (Date.now() - this.lastStart);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.active += 1;
      this.lastStart = Date.now();
    } finally {
      open();
    }
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this._waiters.shift();
    if (next) next();
  }
}

module.exports = { ConnectQueue };
