'use strict';

// Seletor do motor de reconhecimento de fala.
//
// O manager conhece apenas este contrato. Trocar whisper-server por CLI, por
// um servidor remoto ou por outro modelo no futuro nao exige mudar o backend,
// a fila nem o fluxo de mensagens.

class TranscriptionEngine {
  constructor(options = {}) {
    this.mode = String(options.mode || 'local');
    this.http = options.http || null;
    this.cli = options.cli || null;
    this.logger = typeof options.logger === 'function' ? options.logger : () => {};
  }

  get name() {
    if (this.mode === 'cli') return this.cli ? this.cli.name : 'whisper-cli';
    return this.http ? this.http.name : 'whisper.cpp';
  }

  get describe() {
    return this.mode === 'cli' ? 'whisper-cli (processo por tarefa)' : 'whisper-server (modelo carregado)';
  }

  async transcribe(input) {
    if (this.mode === 'cli') {
      if (!this.cli) throw new Error('motor CLI nao configurado');
      return await this.cli.transcribe(input);
    }
    if (!this.http) throw new Error('motor HTTP nao configurado');
    return await this.http.transcribe(input);
  }

  async health(force = false) {
    const target = this.mode === 'cli' ? this.cli : this.http;
    if (!target) return { ok: false, error: 'motor nao configurado' };
    return await target.health(force);
  }

  stats() {
    const target = this.mode === 'cli' ? this.cli : this.http;
    return {
      mode: this.mode,
      describe: this.describe,
      ...(target && typeof target.stats === 'function' ? target.stats() : {})
    };
  }
}

module.exports = { TranscriptionEngine };
