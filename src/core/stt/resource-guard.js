'use strict';

// Guarda de recursos da VPS.
//
// O motor de STT nunca pode competir com o backend/WhatsApp por RAM. Antes de
// admitir uma tarefa, conferimos memoria disponivel, carga e disco. Quando um
// limite e atingido, a tarefa e adiada (volta para RETRYING); nada e perdido e
// o processo principal continua atendendo.

const os = require('os');
const { readMemory, readDisk } = require('../resources');

class ResourceGuard {
  constructor(options = {}) {
    this.minFreeMemMB = Math.max(16, Number(options.minFreeMemMB) || 180);
    this.minFreeDiskMB = Math.max(128, Number(options.minFreeDiskMB) || 1024);
    this.maxLoadFactor = Math.max(1, Number(options.maxLoadFactor) || 6);
    this.diskPath = options.diskPath || (process.platform === 'win32' ? null : '/');
    this.ttlMs = Math.max(0, Number(options.ttlMs) || 2000);
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.logger = typeof options.logger === 'function' ? options.logger : () => {};
    this.readMemory = options.readMemory || readMemory;
    this.readDisk = options.readDisk || readDisk;
    this.cpuCount = Number(options.cpus) || Math.max(1, (os.cpus() || []).length);

    this.cached = null;
    this.cachedAt = 0;
    this.paused = false;
    this.lastReason = '';
    this.pauses = 0;
  }

  _read() {
    let mem = null;
    try { mem = this.readMemory(); } catch (_) {}
    const mb = (b) => Math.round(Number(b || 0) / 1048576);

    let disk = null;
    try { disk = this.readDisk(this.diskPath); } catch (_) {}

    const load = os.loadavg ? os.loadavg() : [0, 0, 0];
    return {
      ramTotalMB: mem ? mb(mem.total) : 0,
      ramAvailableMB: mem ? mb(mem.available) : 0,
      ramUsedPct: mem && mem.total ? Math.round(((mem.total - mem.available) / mem.total) * 100) : 0,
      diskFreeMB: disk ? mb(disk.free) : null,
      diskUsedPct: disk ? disk.usedPct : null,
      load1: Math.round((Number(load[0]) || 0) * 100) / 100,
      cpus: this.cpuCount
    };
  }

  snapshot() {
    const now = this.now();
    if (this.cached && now - this.cachedAt < this.ttlMs) return this.cached;
    this.cached = this._read();
    this.cachedAt = now;
    return this.cached;
  }

  check() {
    const snap = this.snapshot();
    let reason = '';

    if (snap.ramTotalMB && snap.ramAvailableMB < this.minFreeMemMB) {
      reason = `RAM livre ${snap.ramAvailableMB}MB < ${this.minFreeMemMB}MB`;
    } else if (snap.diskFreeMB != null && snap.diskFreeMB < this.minFreeDiskMB) {
      reason = `disco livre ${snap.diskFreeMB}MB < ${this.minFreeDiskMB}MB`;
    } else if (snap.load1 > snap.cpus * this.maxLoadFactor) {
      reason = `carga ${snap.load1} > ${snap.cpus * this.maxLoadFactor} (${snap.cpus} vCPU)`;
    }

    const wasPaused = this.paused;
    this.paused = !!reason;
    if (reason) {
      this.lastReason = reason;
      this.pauses++;
      if (!wasPaused) this.logger('warning', `admissao de STT pausada: ${reason}`);
    } else if (wasPaused) {
      this.lastReason = '';
      this.logger('info', 'admissao de STT retomada');
    }

    return { ok: !reason, reason, snapshot: snap };
  }

  stats() {
    return {
      paused: this.paused,
      reason: this.lastReason,
      pauses: this.pauses,
      limits: {
        minFreeMemMB: this.minFreeMemMB,
        minFreeDiskMB: this.minFreeDiskMB,
        maxLoadFactor: this.maxLoadFactor
      },
      snapshot: this.snapshot()
    };
  }
}

module.exports = { ResourceGuard };
