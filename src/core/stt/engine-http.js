'use strict';

// Cliente HTTP do whisper.cpp (whisper-server).
//
// O modelo fica carregado no servico systemd; aqui so enviamos WAV 16 kHz e
// recebemos texto. Multipart montado na mao (Buffer) para nao depender de
// FormData/Blob e para conseguir medir/temporizar cada etapa.

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

function buildMultipart(parts) {
  const boundary = `----linkstt${crypto.randomBytes(12).toString('hex')}`;
  const chunks = [];
  for (const part of parts) {
    const header = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${part.name}"` +
        (part.filename ? `; filename="${part.filename}"` : ''),
      part.contentType ? `Content-Type: ${part.contentType}` : null,
      '',
      ''
    ].filter((l) => l !== null).join('\r\n');
    chunks.push(Buffer.from(header, 'utf8'));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(String(part.value), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(chunks) };
}

function parseInferenceBody(statusCode, contentType, bodyText) {
  const text = String(bodyText || '').trim();
  if (!text) return { text: '' };
  if (String(contentType || '').includes('json') || text.startsWith('{') || text.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw Object.assign(new Error(`resposta invalida do motor: ${e.message}`), { statusCode });
    }
    if (Array.isArray(parsed)) {
      return { text: parsed.map((p) => (p && p.text) || '').join(' ').trim() };
    }
    if (parsed && typeof parsed.error === 'string') {
      throw Object.assign(new Error(parsed.error), { statusCode });
    }
    const out = parsed && (parsed.text || parsed.transcription);
    return { text: typeof out === 'string' ? out.trim() : '' };
  }
  return { text };
}

function deferError(message, code) {
  const err = new Error(message);
  err.code = code || 'STT_ENGINE';
  err.kind = 'transient';
  err.defer = true;
  return err;
}

class HttpWhisperEngine {
  constructor(options = {}) {
    this.url = new URL(options.url || 'http://127.0.0.1:8191');
    this.model = String(options.model || 'tiny');
    this.lang = String(options.lang || 'pt');
    this.threads = Number(options.threads) || 1;
    this.healthTtlMs = Math.max(0, Number(options.healthTtlMs) || 5000);
    this.httpTimeoutMs = Math.max(500, Number(options.httpTimeoutMs) || 5000);
    this.timeoutFor = typeof options.timeoutFor === 'function'
      ? options.timeoutFor
      : () => 120000;
    this.logger = typeof options.logger === 'function' ? options.logger : () => {};
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();

    this.healthy = null;
    this.checkedAt = 0;
    this.lastError = '';
    this.consecutiveFailures = 0;
    this.requests = 0;
    this.failures = 0;
    this.totalMs = 0;
  }

  get name() {
    return 'whisper.cpp';
  }

  _request(method, pathName, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const isHttps = this.url.protocol === 'https:';
      const transport = isHttps ? https : http;
      const headers = {};
      if (body) {
        headers['Content-Type'] = body.contentType;
        headers['Content-Length'] = body.body.length;
      }
      const req = transport.request({
        protocol: this.url.protocol,
        hostname: this.url.hostname,
        port: this.url.port || (isHttps ? 443 : 80),
        path: pathName,
        method,
        headers,
        timeout: timeoutMs
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > 2 * 1024 * 1024) {
            req.destroy(deferError('resposta do motor grande demais', 'STT_ENGINE_BODY'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers || {},
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      });
      req.on('timeout', () => {
        req.destroy(deferError(`motor de STT nao respondeu em ${timeoutMs}ms`, 'STT_ENGINE_TIMEOUT'));
      });
      req.on('error', (e) => {
        if (e && e.defer) return reject(e);
        const code = e && e.code === 'ECONNREFUSED' ? 'STT_ENGINE_DOWN'
          : e && e.code === 'ECONNRESET' ? 'STT_ENGINE_RESET'
          : 'STT_ENGINE_NET';
        reject(deferError(`motor de STT indisponivel: ${e && e.message ? e.message : e}`, code));
      });
      if (body) req.write(body.body);
      req.end();
    });
  }

  async health(force = false) {
    const now = this.now();
    if (!force && this.healthy !== null && now - this.checkedAt < this.healthTtlMs) {
      return { ok: this.healthy, cached: true, error: this.lastError };
    }
    this.checkedAt = now;
    try {
      const res = await this._request('GET', '/', null, this.httpTimeoutMs);
      const ok = res.statusCode > 0 && res.statusCode < 500;
      this.healthy = ok;
      this.lastError = ok ? '' : `HTTP ${res.statusCode}`;
      if (!ok) this.consecutiveFailures++;
      return { ok, cached: false, error: this.lastError, statusCode: res.statusCode };
    } catch (e) {
      this.healthy = false;
      this.lastError = e.message;
      this.consecutiveFailures++;
      return { ok: false, cached: false, error: e.message };
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

    const health = await this.health(false);
    if (!health.ok) {
      throw deferError(`motor de STT fora do ar (${health.error || 'sem resposta'})`, 'STT_ENGINE_DOWN');
    }

    const lang = input.lang || this.lang;
    const fields = [
      { name: 'file', filename: 'audio.wav', contentType: 'audio/wav', value: wav },
      { name: 'response_format', value: 'json' },
      { name: 'language', value: lang },
      { name: 'temperature', value: '0' }
    ];
    const multipart = buildMultipart(fields);
    const timeoutMs = Math.max(5000, this.timeoutFor(input.durationSec || 0));
    const startedAt = this.now();
    this.requests++;

    let res;
    try {
      res = await this._request('POST', '/inference', {
        contentType: `multipart/form-data; boundary=${multipart.boundary}`,
        body: multipart.body
      }, timeoutMs);
    } catch (e) {
      this.failures++;
      this.healthy = false;
      this.lastError = e.message;
      throw e;
    }

    const ms = this.now() - startedAt;
    this.totalMs += ms;

    if (res.statusCode >= 500 || res.statusCode === 429) {
      this.failures++;
      this.healthy = false;
      throw deferError(`motor de STT respondeu HTTP ${res.statusCode}`, 'STT_ENGINE_5XX');
    }
    if (res.statusCode >= 400) {
      this.failures++;
      const err = new Error(`motor recusou o audio (HTTP ${res.statusCode}): ${String(res.body).slice(0, 200)}`);
      err.kind = res.statusCode === 413 ? 'limit' : 'corrupt';
      err.defer = false;
      throw err;
    }

    const contentType = res.headers['content-type'] || '';
    const parsed = parseInferenceBody(res.statusCode, contentType, res.body);
    this.healthy = true;
    this.consecutiveFailures = 0;
    return {
      text: parsed.text,
      lang,
      engine: 'whisper.cpp',
      model: this.model,
      sttMs: ms
    };
  }

  stats() {
    return {
      name: 'whisper.cpp',
      url: `${this.url.protocol}//${this.url.host}`,
      model: this.model,
      lang: this.lang,
      threads: this.threads,
      healthy: this.healthy,
      lastError: this.lastError,
      requests: this.requests,
      failures: this.failures,
      avgMs: this.requests ? Math.round(this.totalMs / this.requests) : 0
    };
  }
}

module.exports = { HttpWhisperEngine, buildMultipart, parseInferenceBody };
