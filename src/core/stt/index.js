'use strict';

// Montagem do servico de transcricao local (wiring unico).
//
// Uso no backend:
//   const stt = createSttSystem({ dataDir, logger, fallback });
//   stt.manager.transcribe({ buffer, mimetype, zapId, msgId });
//
// Nada aqui depende de Electron, WhatsApp ou do painel.

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { createAudioProcessor } = require('./audio-processor');
const { TranscriptionCache } = require('./cache');
const { SttGate } = require('./gate');
const { ResourceGuard } = require('./resource-guard');
const { SttMetrics } = require('./metrics');
const { HttpWhisperEngine } = require('./engine-http');
const { CliWhisperEngine } = require('./engine-cli');
const { TranscriptionEngine } = require('./engine');
const { SttManager } = require('./manager');

function ensureDir(dir, logger) {
  if (!dir) return;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    if (logger) logger('warning', `nao foi possivel criar ${dir}: ${e.message}`);
  }
}

function createSttSystem(options = {}) {
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  const dataDir = options.dataDir || process.env.LINK_DATA_DIR || '';
  const config = options.config || loadConfig(process.env, { dataDir });

  if (!config.sttDir) {
    throw new Error('STT: diretorio de dados nao definido (LINK_DATA_DIR)');
  }

  ensureDir(config.sttDir, logger);
  ensureDir(config.tempDir, logger);
  ensureDir(config.cacheDir, logger);

  const processor = options.processor || createAudioProcessor({
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    tempDir: config.tempDir,
    silenceDb: config.silenceDb,
    minAudioSec: config.minAudioSec,
    maxAudioSec: config.maxAudioSec,
    logger
  });

  const cache = options.cache || new TranscriptionCache({
    dir: config.cacheDir,
    maxBytes: config.cacheMaxMB * 1024 * 1024,
    ttlMs: config.cacheTtlHours * 3600 * 1000,
    logger
  });
  if (typeof cache.init === 'function') cache.init();

  const gate = options.gate || new SttGate({
    maxConcurrent: config.concurrency,
    maxPerZap: 1,
    maxQueueWaitMs: config.maxQueueWaitMs,
    logger
  });

  const guard = options.guard || new ResourceGuard({
    minFreeMemMB: config.minFreeMemMB,
    minFreeDiskMB: config.minFreeDiskMB,
    diskPath: config.dataDir || undefined,
    logger
  });

  const metrics = options.metrics || new SttMetrics({
    filePath: config.metricsFile,
    logger
  });
  if (typeof metrics.load === 'function') metrics.load();
  const timersEnabled = options.startTimers !== false && config.enabled && config.engine !== 'api';
  if (timersEnabled && typeof metrics.start === 'function') metrics.start();

  const mode = config.engine === 'remote' ? 'local' : config.engine;

  const http = options.http || new HttpWhisperEngine({
    url: config.workerUrl,
    model: config.model,
    lang: config.lang,
    threads: config.threads,
    healthTtlMs: config.healthTtlMs,
    httpTimeoutMs: config.httpTimeoutMs,
    timeoutFor: (durationSec) => {
      const base = Number(config.jobTimeoutBaseMs) || 30000;
      const factor = Number(config.jobTimeoutFactor) || 3;
      const max = Number(config.jobTimeoutMaxMs) || 300000;
      return Math.min(max, Math.max(base, base + Math.round(factor * (Number(durationSec) || 0) * 1000)));
    },
    logger
  });

  const cli = options.cli || new CliWhisperEngine({
    binPath: config.cliPath,
    modelPath: config.modelPath || path.join(config.sttDir, '..', 'models', `ggml-${config.model}.bin`),
    threads: config.threads,
    lang: config.lang,
    tempDir: config.tempDir,
    timeoutFor: (durationSec) => {
      const base = Number(config.jobTimeoutBaseMs) || 30000;
      const factor = Number(config.jobTimeoutFactor) || 3;
      const max = Number(config.jobTimeoutMaxMs) || 300000;
      return Math.min(max, Math.max(base, base + Math.round(factor * (Number(durationSec) || 0) * 1000)));
    },
    logger
  });

  const engine = options.engine || new TranscriptionEngine({ mode, http, cli, logger });

  const manager = options.manager || new SttManager({
    config,
    engine,
    cache,
    gate,
    guard,
    metrics,
    processor,
    logger,
    fallback: options.fallback,
    now: options.now
  });

  let healthTimer = null;
  if (timersEnabled) {
    healthTimer = setInterval(() => {
      manager.refreshHealth().catch(() => {});
    }, 30000);
    if (typeof healthTimer.unref === 'function') healthTimer.unref();
  }

  function close() {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = null;
    try { metrics.stop(); } catch (_) {}
  }

  return { config, manager, engine, cache, gate, guard, metrics, processor, http, cli, close };
}

module.exports = { createSttSystem };
