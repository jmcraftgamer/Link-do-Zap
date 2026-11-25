'use strict';

// Motor alternativo: whisper-cli por tarefa.
//
// Nao mantem o modelo carregado entre tarefas (o servidor HTTP e o padrao para
// isso). Serve para benchmark e como plano B quando o whisper-server nao esta
// disponivel. Mesmo contrato do engine HTTP, entao o manager nao muda.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

function parseCliOutput(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[\d:.,\s>\-]+\]\s*/, '').trim())
    .filter((line) => line && !/^\[BLANK_AUDIO\]$/i.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function deferError(message, code) {
  const err = new Error(message);
  err.code = code || 'STT_CLI';
  err.kind = 'transient';
  err.defer = true;
  return err;
}

class CliWhisperEngine {
  constructor(options = {}) {
    this.binPath = String(options.binPath || 'whisper-cli');
    this.modelPath = String(options.modelPath || '');
    this.threads = Number(options.threads) || 1;
    this.lang = String(options.lang || 'pt');
    this.tempDir = String(options.tempDir || '');
    this.timeoutFor = typeof options.timeoutFor === 'function'
      ? options.timeoutFor
      : () => 120000;
    this.logger = typeof options.logger === 'function' ? options.logger : () => {};
    this.requests = 0;
    this.failures = 0;
    this.totalMs = 0;
  }

  get name() {
    return 'whisper-cli';
  }

  async health(force = false) {
    if (!this.modelPath) return { ok: false, cached: !!force, error: 'modelo nao configurado' };
    try {
      const st = fs.statSync(this.modelPath);
      return { ok: st.size > 1024, cached: false, error: st.size > 1024 ? '' : 'modelo vazio' };
    } catch (e) {
      return { ok: false, cached: false, error: `modelo ausente: ${e.message}` };
    }
  }

  async transcribe(input = {}) {
    const wav = input.wav;
    if (!Buffer.isBuffer(wav) || wav.length <= 44) {
      const err = new Error('WAV invalido para transcricao');
      err.kind = 'corrupt';
      err.defer = false;
      throw err;
    }
    const health = await this.health();
    if (!health.ok) throw deferError(health.error, 'STT_MODEL_MISSING');

    const dir = this.tempDir || require('os').tmpdir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const file = path.join(dir, `stt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`);
    try { fs.writeFileSync(file, wav); } catch (e) {
      throw deferError(`nao foi possivel gravar WAV temporario: ${e.message}`, 'STT_TMP');
    }

    const lang = input.lang || this.lang;
    const args = [
      '-m', this.modelPath,
      '-f', file,
      '-l', lang,
      '-t', String(this.threads),
      '-nt',
      '-np'
    ];

    const startedAt = Date.now();
    this.requests++;
    try {
      const result = await new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let child;
        try {
          child = spawn(this.binPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch (e) {
          reject(deferError(`nao foi possivel iniciar o whisper-cli: ${e.message}`, 'STT_CLI_SPAWN'));
          return;
        }
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (_) {}
          reject(deferError(`whisper-cli excedeu ${this.timeoutFor(input.durationSec || 0)}ms`, 'STT_CLI_TIMEOUT'));
        }, Math.max(5000, this.timeoutFor(input.durationSec || 0)));
        if (typeof timer.unref === 'function') timer.unref();

        child.stdout.on('data', (c) => { if (stdout.length < 200000) stdout += c.toString(); });
        child.stderr.on('data', (c) => { if (stderr.length < 64000) stderr += c.toString(); });
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(deferError(`whisper-cli indisponivel: ${e.message}`, 'STT_CLI_SPAWN'));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(deferError(`whisper-cli saiu com codigo ${code}: ${stderr.slice(-300)}`, 'STT_CLI_EXIT'));
            return;
          }
          resolve({ stdout, stderr });
        });
      });
      const ms = Date.now() - startedAt;
      this.totalMs += ms;
      return {
        text: parseCliOutput(result.stdout),
        lang,
        engine: 'whisper-cli',
        model: path.basename(this.modelPath || 'model'),
        sttMs: ms
      };
    } catch (e) {
      this.failures++;
      throw e;
    } finally {
      try { fs.unlinkSync(file); } catch (_) {}
    }
  }

  stats() {
    return {
      name: 'whisper-cli',
      bin: this.binPath,
      model: this.modelPath ? path.basename(this.modelPath) : '',
      requests: this.requests,
      failures: this.failures,
      avgMs: this.requests ? Math.round(this.totalMs / this.requests) : 0
    };
  }
}

module.exports = { CliWhisperEngine, parseCliOutput };
