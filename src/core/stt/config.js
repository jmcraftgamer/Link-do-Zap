'use strict';

// Configuracao do motor de transcricao local.
//
// Tudo vem de variaveis de ambiente para que a troca entre motor local, CLI e
// API externa (fallback) seja feita sem deploy de codigo. Os defaults foram
// pensados para uma VPS de 2 GB / 1 vCPU: um modelo, uma tarefa por vez.

const path = require('path');

const DEFAULTS = {
  // enabled=0 desliga o motor local por completo (volta ao caminho antigo).
  enabled: true,
  // local | remote | cli | api
  engine: 'local',
  model: 'tiny',
  lang: 'pt',
  // Identificacao automatica quando o cliente fala outro idioma.
  autoLang: false,
  threads: 1,
  concurrency: 1,
  // Uma tarefa que espera mais que isso sai da fila e volta para RETRYING.
  // Nunca e descartada: a fila do audio e persistente.
  maxQueueWaitMs: 90000,
  // Timeout por tarefa acompanha a duracao do audio; audios longos nao podem
  // morrer no timeout fixo que existia antes.
  jobTimeoutBaseMs: 30000,
  jobTimeoutFactor: 3,
  jobTimeoutMaxMs: 300000,
  minAudioSec: 0.35,
  maxAudioSec: 600,
  // Abaixo disso (dB medio) o audio e tratado como silencio/ruido, nao como
  // fala. Evita as alucinacoes tipicas do Whisper em audio vazio.
  silenceDb: -55,
  // Guarda de recursos: pausa a admissao sem derrubar o backend.
  minFreeMemMB: 180,
  minFreeDiskMB: 1024,
  cacheMaxMB: 128,
  cacheTtlHours: 168,
  fallbackApi: false,
  canaryZaps: [],
  workerUrl: 'http://127.0.0.1:8191',
  workerPort: 8191,
  healthTtlMs: 5000,
  httpTimeoutMs: 5000
};

function toInt(value, def, min, max) {
  if (value == null || value === '') return def;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return def;
  if (min != null && n < min) return min;
  if (max != null && n > max) return max;
  return n;
}

function toBool(value, def) {
  if (value == null || value === '') return def;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'sim', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'nao', 'off'].includes(s)) return false;
  return def;
}

function toList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadConfig(env = process.env, options = {}) {
  const dataDir = String(options.dataDir || env.LINK_DATA_DIR || '').trim();
  const sttDir = dataDir ? path.join(dataDir, 'stt') : '';
  const appDir = String(options.appDir || env.LINK_APP_DIR || path.resolve(__dirname, '..', '..', '..')).trim();
  const engine = String(env.LINK_STT_ENGINE || DEFAULTS.engine).trim().toLowerCase();
  const remoteUrl = String(env.LINK_STT_REMOTE_URL || '').trim();
  const model = String(env.LINK_STT_MODEL || DEFAULTS.model).trim();

  const cfg = {
    enabled: toBool(env.LINK_STT_ENABLED, DEFAULTS.enabled),
    engine: ['local', 'remote', 'cli', 'api'].includes(engine) ? engine : DEFAULTS.engine,
    model,
    lang: String(env.LINK_STT_LANG || DEFAULTS.lang).trim(),
    autoLang: toBool(env.LINK_STT_AUTO_LANG, DEFAULTS.autoLang),
    threads: toInt(env.LINK_STT_THREADS, DEFAULTS.threads, 1, 16),
    concurrency: toInt(env.LINK_STT_CONCURRENCY, DEFAULTS.concurrency, 1, 8),
    maxQueueWaitMs: toInt(env.LINK_STT_MAX_QUEUE_WAIT_MS, DEFAULTS.maxQueueWaitMs, 1000, 600000),
    jobTimeoutBaseMs: toInt(env.LINK_STT_JOB_TIMEOUT_BASE_MS, DEFAULTS.jobTimeoutBaseMs, 5000, 120000),
    jobTimeoutFactor: toInt(env.LINK_STT_JOB_TIMEOUT_FACTOR, DEFAULTS.jobTimeoutFactor, 1, 30),
    jobTimeoutMaxMs: toInt(env.LINK_STT_JOB_TIMEOUT_MAX_MS, DEFAULTS.jobTimeoutMaxMs, 10000, 1800000),
    minAudioSec: Number(env.LINK_STT_MIN_AUDIO_SEC || DEFAULTS.minAudioSec),
    maxAudioSec: toInt(env.LINK_STT_MAX_AUDIO_SEC, DEFAULTS.maxAudioSec, 5, 3600),
    silenceDb: Number(env.LINK_STT_SILENCE_DB || DEFAULTS.silenceDb),
    minFreeMemMB: toInt(env.LINK_STT_MIN_FREE_MB, DEFAULTS.minFreeMemMB, 32, 8192),
    minFreeDiskMB: toInt(env.LINK_STT_MIN_FREE_DISK_MB, DEFAULTS.minFreeDiskMB, 128, 102400),
    cacheMaxMB: toInt(env.LINK_STT_CACHE_MB, DEFAULTS.cacheMaxMB, 0, 10240),
    cacheTtlHours: toInt(env.LINK_STT_CACHE_TTL_H, DEFAULTS.cacheTtlHours, 1, 8760),
    fallbackApi: toBool(env.LINK_STT_FALLBACK_API, DEFAULTS.fallbackApi),
    canaryZaps: toList(env.LINK_STT_CANARY_ZAPS),
    workerUrl: remoteUrl || String(env.LINK_STT_WORKER_URL || DEFAULTS.workerUrl).trim(),
    workerPort: toInt(env.LINK_STT_WORKER_PORT, DEFAULTS.workerPort, 1, 65535),
    healthTtlMs: toInt(env.LINK_STT_HEALTH_TTL_MS, DEFAULTS.healthTtlMs, 0, 60000),
    httpTimeoutMs: toInt(env.LINK_STT_HTTP_TIMEOUT_MS, DEFAULTS.httpTimeoutMs, 500, 60000),
    modelPath: String(env.LINK_STT_MODEL_PATH || path.join(appDir, 'models', `ggml-${model}.bin`)).trim(),
    cliPath: String(env.LINK_STT_CLI_PATH || path.join(appDir, 'vendor', 'whisper.cpp', 'build', 'bin', 'whisper-cli')).trim(),
    ffmpegPath: String(env.LINK_FFMPEG_PATH || 'ffmpeg').trim(),
    ffprobePath: String(env.LINK_FFPROBE_PATH || 'ffprobe').trim(),
    appDir,
    dataDir,
    sttDir,
    tempDir: sttDir ? path.join(sttDir, 'tmp') : '',
    cacheDir: sttDir ? path.join(sttDir, 'cache') : '',
    metricsFile: sttDir ? path.join(sttDir, 'metrics.json') : ''
  };

  if (cfg.engine === 'remote' && !remoteUrl) cfg.engine = 'local';
  if (cfg.autoLang) cfg.lang = 'auto';
  return cfg;
}

module.exports = { loadConfig, DEFAULTS, toInt, toBool, toList };
