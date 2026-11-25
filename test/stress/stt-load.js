#!/usr/bin/env node
'use strict';

// Gerador de carga do motor de STT local.
//
// Chama o caminho real: FFmpeg -> WAV 16 kHz -> whisper-server -> cache ->
// metricas. Roda fora do Electron (na VPS, no mesmo diretorio do projeto),
// entao nao derruba o WhatsApp. Os numeros sao medidos, nao estimados.
//
// Exemplos:
//   node test/stress/stt-load.js --audio amostra.ogg --jobs 20
//   node test/stress/stt-load.js --audio a.ogg --jobs 50 --concurrency 1 --zap A,B,C
//   node test/stress/stt-load.js --audio a.ogg --jobs 10 --engine cli \
//     --model-path /opt/assistente-zap/models/ggml-tiny.bin
//
// Saida: tabela por tarefa + resumo (p50/p95, vazao, falhas, cache).

const fs = require('fs');
const os = require('os');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v == null || v.startsWith('--') ? true : v;
}

const AUDIO = String(arg('audio', ''));
const JOBS = Math.max(1, Number(arg('jobs', 10)) || 10);
const CONCURRENCY = Math.max(1, Number(arg('concurrency', 1)) || 1);
const WORKER = String(arg('worker', process.env.LINK_STT_WORKER_URL || 'http://127.0.0.1:8191'));
const MODEL = String(arg('model', process.env.LINK_STT_MODEL || 'tiny'));
const ENGINE = String(arg('engine', 'local'));
const MODEL_PATH = String(arg('model-path', process.env.LINK_STT_MODEL_PATH || ''));
const ZAPS = String(arg('zap', 'zapA,zapB,zapC')).split(',').map((s) => s.trim()).filter(Boolean);
const CACHE_MB = Number(arg('cache-mb', 0)) || 0;

if (!AUDIO) {
  console.error('uso: node test/stress/stt-load.js --audio <arquivo> [--jobs 20] [--concurrency 1]');
  process.exit(2);
}
const abs = path.resolve(AUDIO);
if (!fs.existsSync(abs)) {
  console.error(`audio nao encontrado: ${abs}`);
  process.exit(2);
}
const buffer = fs.readFileSync(abs);
const mimetype = abs.endsWith('.mp3') ? 'audio/mpeg'
  : abs.endsWith('.wav') ? 'audio/wav'
  : abs.endsWith('.m4a') ? 'audio/mp4'
  : abs.endsWith('.webm') ? 'audio/webm'
  : 'audio/ogg';

const { loadConfig } = require(path.join(__dirname, '..', '..', 'src', 'core', 'stt', 'config'));
const { createAudioProcessor } = require(path.join(__dirname, '..', '..', 'src', 'core', 'stt', 'audio-processor'));
const { TranscriptionCache } = require(path.join(__dirname, '..', '..', 'src', 'core', 'stt', 'cache'));
const { SttGate } = require(path.join(__dirname, '..', '..', 'src', 'core', 'stt', 'gate'));
const { SttMetrics } = require(path.join(__dirname, '..', '..', 'src', 'core', 'stt', 'metrics'));
const { ResourceGuard } = require(path.join(__dirname, '..', '..', 'src', 'core', 'stt', 'resource-guard'));
const { HttpWhisperEngine } = require(path.join(__dirname, '..', '..', 'src', 'core', 'stt', 'engine-http'));
const { CliWhisperEngine } = require(path.join(__dirname, '..', '..', 'src', 'core', 'stt', 'engine-cli'));
const { TranscriptionEngine } = require(path.join(__dirname, '..', '..', 'src', 'core', 'stt', 'engine'));
const { SttManager } = require(path.join(__dirname, '..', '..', 'src', 'core', 'stt', 'manager'));

// Modo local (sem VPS/modelo): engine fake para medir o caminho real de
// conversao (FFmpeg -> WAV), cache, gate e metricas sem precisar do whisper-server.
function createFakeEngine() {
  const stats = { calls: 0, totalMs: 0 };
  const engine = {
    name: 'fake',
    describe: 'fake-engine (validacao local do caminho conversao+cache)',
    transcribe: async (input) => {
      const started = Date.now();
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
      const ms = Date.now() - started;
      stats.totalMs += ms;
      stats.calls++;
      return {
        text: `audio de teste transcrito em ${input.durationSec || 0}s`,
        lang: 'pt',
        engine: 'fake',
        model: 'fake',
        sttMs: ms
      };
    },
    health: async () => ({ ok: true, cached: false, error: '' }),
    stats: () => ({ name: 'fake', calls: stats.calls, avgMs: stats.calls ? Math.round(stats.totalMs / stats.calls) : 0 })
  };
  return engine;
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zap-stt-load-'));
const config = loadConfig({
  ...process.env,
  LINK_DATA_DIR: dataDir,
  LINK_STT_MODEL: MODEL,
  LINK_STT_CONCURRENCY: String(CONCURRENCY),
  LINK_STT_ENGINE: ENGINE,
  LINK_STT_WORKER_URL: WORKER,
  LINK_STT_CACHE_MB: String(CACHE_MB),
  LINK_STT_FALLBACK_API: '0'
}, { dataDir });

const processor = createAudioProcessor({
  ffmpegPath: config.ffmpegPath,
  ffprobePath: config.ffprobePath,
  tempDir: config.tempDir,
  silenceDb: config.silenceDb,
  logger: () => {}
});

const cache = new TranscriptionCache({
  dir: config.cacheDir,
  maxBytes: CACHE_MB * 1024 * 1024,
  ttlMs: 3600000
}).init();

const gate = new SttGate({ maxConcurrent: CONCURRENCY, maxPerZap: 1, maxQueueWaitMs: 300000 });
const metrics = new SttMetrics({ filePath: '' });
const guard = new ResourceGuard({
  minFreeMemMB: 16,
  minFreeDiskMB: 128,
  maxLoadFactor: 999,
  logger: () => {}
});

let engine;
if (ENGINE === 'fake') {
  engine = createFakeEngine();
  console.log('MODO FAKE: usando engine simulado (sem whisper.cpp) para validar FFmpeg + cache + gate + metricas');
} else {
  const http = new HttpWhisperEngine({
    url: config.workerUrl,
    model: MODEL,
    lang: config.lang,
    threads: config.threads,
    timeoutFor: (d) => config.jobTimeoutMaxMs
  });
  const cli = new CliWhisperEngine({
    binPath: config.cliPath,
    modelPath: MODEL_PATH || config.modelPath,
    threads: config.threads,
    lang: config.lang,
    tempDir: config.tempDir,
    timeoutFor: (d) => config.jobTimeoutMaxMs
  });
  engine = new TranscriptionEngine({ mode: ENGINE === 'cli' ? 'cli' : 'local', http, cli });
}

const manager = new SttManager({ config, engine, cache, gate, guard, metrics, processor, logger: () => {} });

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

(async () => {
  let health = { ok: true, cached: false, error: '' };
  if (ENGINE !== 'fake') {
    health = await engine.health(true).catch((e) => ({ ok: false, error: e.message }));
  }
  console.log(`motor=${engine.describe} modelo=${MODEL} worker=${WORKER} saude=${health.ok ? 'ok' : 'FALHA ' + (health.error || '')}`);
  if (!health.ok && ENGINE !== 'cli' && ENGINE !== 'fake') {
    console.error('motor indisponivel: inicie o servico (systemctl start assistente-zap-stt) ou use --engine cli');
    process.exit(1);
  }

  console.log(`audio=${path.basename(abs)} bytes=${buffer.length} tarefas=${JOBS} concorrencia=${CONCURRENCY} zaps=${ZAPS.join(',')}`);
  console.log('');
  console.log('tarefa | zap | ms_total | stt_ms | fila_ms | chars | cache | erro');
  console.log('-------|-----|----------|--------|---------|-------|-------|-----');

  const startedAt = Date.now();
  const results = [];
  const tasks = [];
  for (let i = 0; i < JOBS; i++) {
    const zapId = ZAPS[i % ZAPS.length] || 'zap';
    const t0 = Date.now();
    tasks.push(
      manager.transcribe({ buffer, mimetype, size: buffer.length, zapId, msgId: `load-${i}` })
        .then((res) => {
          const total = Date.now() - t0;
          results.push({ ok: true, total, ...res });
          console.log(`${String(i).padStart(6)} | ${zapId} | ${String(total).padStart(8)} | ${String(res.sttMs).padStart(6)} | ${String(res.queueWaitMs).padStart(7)} | ${String(res.text.length).padStart(5)} | ${res.cached ? 'sim' : 'nao'} | -`);
          return res;
        })
        .catch((e) => {
          const total = Date.now() - t0;
          results.push({ ok: false, total, defer: !!e.defer, error: e.message });
          console.log(`${String(i).padStart(6)} | ${zapId} | ${String(total).padStart(8)} | - | - | - | - | ${e.defer ? 'DEFER ' : ''}${e.message.slice(0, 60)}`);
          return null;
        })
    );
  }
  await Promise.all(tasks);
  const wallMs = Date.now() - startedAt;

  const ok = results.filter((r) => r.ok);
  const failed = results.length - ok.length;
  const totals = ok.map((r) => r.total);
  const stts = ok.map((r) => r.sttMs);
  const queues = ok.map((r) => r.queueWaitMs);
  const cached = ok.filter((r) => r.cached).length;

  console.log('');
  console.log('--- resumo (medido, nao estimado) ---');
  console.log(`concluidas=${ok.length} falhas=${failed} cache=${cached} parede=${wallMs}ms`);
  console.log(`total ms: p50=${pct(totals, 50)} p95=${pct(totals, 95)} max=${Math.max(0, ...totals)}`);
  console.log(`stt   ms: p50=${pct(stts, 50)} p95=${pct(stts, 95)} max=${Math.max(0, ...stts)}`);
  console.log(`fila  ms: p50=${pct(queues, 50)} p95=${pct(queues, 95)} max=${Math.max(0, ...queues)}`);
  if (ok.length && wallMs > 0) {
    const inferred = ok.length - cached;
    console.log(`vazao observada: ${(ok.length / (wallMs / 1000)).toFixed(2)} tarefas/s (${(ok.length / (wallMs / 60000)).toFixed(1)}/min)`);
    console.log(`inferencias reais: ${inferred} (${Math.round(inferred / (wallMs / 3600000))}/h nesta execucao, concorrencia ${CONCURRENCY})`);
  }
  const stats = manager.stats();
  console.log(`metricas internas: recebidas=${stats.totals.received} concluidas=${stats.totals.completed} falhas=${stats.totals.failed}`);
  console.log(`ram disponivel: ${stats.resources.snapshot.ramAvailableMB}MB | load1: ${stats.resources.snapshot.load1}`);

  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('falha no teste de carga:', e && e.stack ? e.stack : e);
  process.exit(1);
});
