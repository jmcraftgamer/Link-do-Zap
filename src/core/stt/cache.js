'use strict';

// Cache de transcricoes enderecado por conteudo (SHA-256 + modelo + idioma).
//
// O audio nunca e persistido: so o texto e os metadados. Um mesmo arquivo
// reenviado (ou encaminhado) nao paga CPU de novo. O indice e reconstruido
// varrendo a pasta no boot, entao nao existe "indice corrompido": o pior caso
// e ignorar uma entrada invalida e transcrever outra vez.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function safeKey(key) {
  return crypto.createHash('sha1').update(String(key)).digest('hex');
}

class TranscriptionCache {
  constructor(options = {}) {
    this.dir = options.dir;
    if (!this.dir) throw new Error('TranscriptionCache: dir obrigatorio');
    this.maxBytes = Math.max(0, Number(options.maxBytes) || 0);
    this.ttlMs = Math.max(1000, Number(options.ttlMs) || 7 * 24 * 60 * 60 * 1000);
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.logger = typeof options.logger === 'function' ? options.logger : () => {};
    this.entries = new Map();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
    this.loaded = false;
  }

  init() {
    if (this.loaded) return this;
    this.loaded = true;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (e) {
      this.logger('warning', `cache indisponivel (${e.message}); seguindo sem cache`);
      this.maxBytes = 0;
      return this;
    }
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch (_) {}
    for (const file of files) {
      const abs = path.join(this.dir, file);
      try {
        const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
        if (!raw || !raw.key || typeof raw.text !== 'string') throw new Error('entrada invalida');
        const size = Number(raw.bytes) || Buffer.byteLength(JSON.stringify(raw));
        const entry = { ...raw, size, file: abs };
        if (this._expired(entry)) {
          this._removeFile(abs);
          continue;
        }
        this.entries.set(String(entry.key), entry);
        this.bytes += size;
      } catch (_) {
        this._removeFile(abs);
      }
    }
    this.prune();
    this.logger('info', 'cache de transcricao carregado', {
      entries: this.entries.size,
      mb: Math.round(this.bytes / 1048576)
    });
    return this;
  }

  _expired(entry) {
    const created = Number(entry.createdAt) || 0;
    return created > 0 && this.now() - created > this.ttlMs;
  }

  _removeFile(abs) {
    try { fs.unlinkSync(abs); } catch (_) {}
  }

  _write(entry) {
    const payload = JSON.stringify(entry);
    const abs = path.join(this.dir, `${safeKey(entry.key)}.json`);
    const tmp = `${abs}.tmp`;
    fs.writeFileSync(tmp, payload);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
    fs.renameSync(tmp, abs);
    return { abs, size: Buffer.byteLength(payload) };
  }

  get(key) {
    const k = String(key || '');
    if (!k) return null;
    const entry = this.entries.get(k);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (this._expired(entry)) {
      this.entries.delete(k);
      this.bytes = Math.max(0, this.bytes - (entry.size || 0));
      this._removeFile(entry.file);
      this.misses++;
      return null;
    }
    this.hits++;
    entry.hits = (Number(entry.hits) || 0) + 1;
    entry.lastHitAt = this.now();
    return entry;
  }

  set(key, data = {}) {
    const k = String(key || '');
    if (!k || !this.maxBytes) return null;
    if (typeof data.text !== 'string' || !data.text.trim()) return null;
    const prev = this.entries.get(k);
    if (prev) {
      this.bytes = Math.max(0, this.bytes - (prev.size || 0));
      this.entries.delete(k);
    }
    const entry = {
      key: k,
      text: data.text.slice(0, 8000),
      engine: String(data.engine || ''),
      model: String(data.model || ''),
      lang: String(data.lang || ''),
      sha256: String(data.sha256 || ''),
      sttMs: Number(data.sttMs) || 0,
      createdAt: this.now(),
      lastHitAt: this.now(),
      hits: 0
    };
    try {
      const written = this._write(entry);
      entry.file = written.abs;
      entry.size = written.size;
      this.entries.set(k, entry);
      this.bytes += entry.size;
      this.prune();
      return entry;
    } catch (e) {
      this.logger('warning', `falha ao gravar cache: ${e.message}`);
      return null;
    }
  }

  delete(key) {
    const k = String(key || '');
    const entry = this.entries.get(k);
    if (!entry) return false;
    this.entries.delete(k);
    this.bytes = Math.max(0, this.bytes - (entry.size || 0));
    this._removeFile(entry.file);
    return true;
  }

  prune() {
    if (!this.maxBytes) return 0;
    let removed = 0;
    for (const [k, entry] of this.entries) {
      if (this._expired(entry)) {
        this.entries.delete(k);
        this.bytes = Math.max(0, this.bytes - (entry.size || 0));
        this._removeFile(entry.file);
        removed++;
      }
    }
    if (this.bytes <= this.maxBytes) return removed;
    const byAge = [...this.entries.values()].sort((a, b) => {
      const aT = Number(a.lastHitAt || a.createdAt) || 0;
      const bT = Number(b.lastHitAt || b.createdAt) || 0;
      return aT - bT;
    });
    for (const entry of byAge) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(entry.key);
      this.bytes = Math.max(0, this.bytes - (entry.size || 0));
      this._removeFile(entry.file);
      removed++;
    }
    return removed;
  }

  stats() {
    return {
      entries: this.entries.size,
      mb: Math.round((this.bytes / 1048576) * 100) / 100,
      maxMB: Math.round(this.maxBytes / 1048576),
      hits: this.hits,
      misses: this.misses,
      ttlHours: Math.round(this.ttlMs / 3600000)
    };
  }
}

module.exports = { TranscriptionCache, safeKey };
