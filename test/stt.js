// Testes do motor de transcricao local (STT).
//
// Nao dependem do modelo, do FFmpeg nem da VPS: o motor e a conversao sao
// injetados. Os testes com audio real ficam em scripts/stt-benchmark.sh e sao
// executados na VPS, com numeros medidos (nunca estimados).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { loadConfig } = require(path.join(__dirname, '..', 'src', 'core', 'stt', 'config'));
const { sha256, wavDurationSec, isSilent, parseMeanVolume } = require(path.join(__dirname, '..', 'src', 'core', 'stt', 'audio-processor'));
const { TranscriptionCache } = require(path.join(__dirname, '..', 'src', 'core', 'stt', 'cache'));
const { SttGate } = require(path.join(__dirname, '..', 'src', 'core', 'stt', 'gate'));
const { ResourceGuard } = require(path.join(__dirname, '..', 'src', 'core', 'stt', 'resource-guard'));
const { SttMetrics } = require(path.join(__dirname, '..', 'src', 'core', 'stt', 'metrics'));
const { HttpWhisperEngine, buildMultipart, parseInferenceBody } = require(path.join(__dirname, '..', 'src', 'core', 'stt', 'engine-http'));
const { parseCliOutput } = require(path.join(__dirname, '..', 'src', 'core', 'stt', 'engine-cli'));
const { SttManager } = require(path.join(__dirname, '..', 'src', 'core', 'stt', 'manager'));
const { AudioTaskStore } = require(path.join(__dirname, '..', 'src', 'core', 'audio', 'task-store'));
const { AudioPipeline } = require(path.join(__dirname, '..', 'src', 'core', 'audio', 'pipeline'));
const { validateAudio } = require(path.join(__dirname, '..', 'src', 'core', 'audio', 'validator'));
const { errorText } = require(path.join(__dirname, '..', 'src', 'core', 'audio', 'errors'));

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failures.push({ name, error: e.message });
    console.log(`FAIL - ${name}`);
    console.log(`      ${e.message}`);
  }
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `zap-stt-${prefix}-`));
}

function oggBuffer() {
  return Buffer.concat([Buffer.from('OggS'), Buffer.alloc(220, 1)]);
}

function baseConfig(extra = {}) {
  const dir = tmpDir('cfg');
  return loadConfig({
    LINK_DATA_DIR: dir,
    LINK_STT_FALLBACK_API: '0',
    ...extra
  }, { dataDir: dir });
}

function fakeProcessor(overrides = {}) {
  return {
    sha256: (buf) => sha256(buf),
    process: async (buffer, mimetype) => ({
      wav: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4000, 0)]),
      sha256: sha256(buffer),
      durationSec: 2,
      meanVolumeDb: -20,
      silent: false,
      format: 'ogg',
      mimetype,
      ...overrides
    })
  };
}

function fakeGuard(ok = true) {
  return {
    check: () => ({ ok, reason: ok ? '' : 'RAM livre 100MB < 180MB', snapshot: {} }),
    stats: () => ({ paused: !ok })
  };
}

function fakeEngine(handler) {
  return {
    name: 'fake',
    describe: 'fake-engine',
    transcribe: handler,
    health: async () => ({ ok: true }),
    stats: () => ({ name: 'fake' })
  };
}

function makeManager(opts = {}) {
  const config = opts.config || baseConfig();
  const dir = tmpDir('cache');
  const cache = new TranscriptionCache({ dir, maxBytes: 8 * 1024 * 1024, ttlMs: 3600000 });
  cache.init();
  const metrics = new SttMetrics({ filePath: '' });
  const ctx = { engineCalls: [], fallbackCalls: [] };
  const engine = opts.engine || fakeEngine(async (input) => {
    ctx.engineCalls.push(input);
    return { text: 'bom dia, tudo bem?', engine: 'fake', model: 'tiny', lang: 'pt', sttMs: 120 };
  });
  const manager = new SttManager({
    config,
    engine,
    cache,
    gate: opts.gate || new SttGate({ maxConcurrent: 1, maxPerZap: 1, maxQueueWaitMs: 5000 }),
    guard: opts.guard || fakeGuard(opts.guardOk !== false),
    metrics,
    processor: opts.processor || fakeProcessor(),
    fallback: opts.fallback,
    logger: () => {}
  });
  return { manager, cache, metrics, engine, ctx };
}

async function run() {
  await test('stt config: defaults e override por env', () => {
    const cfg = baseConfig({
      LINK_STT_MODEL: 'base',
      LINK_STT_THREADS: '2',
      LINK_STT_FALLBACK_API: '1',
      LINK_STT_CANARY_ZAPS: 'a, b'
    });
    assert.strictEqual(cfg.model, 'base');
    assert.strictEqual(cfg.threads, 2);
    assert.strictEqual(cfg.fallbackApi, true);
    assert.deepStrictEqual(cfg.canaryZaps, ['a', 'b']);
    assert.ok(cfg.sttDir.endsWith('stt'));
    assert.ok(cfg.tempDir.endsWith(path.join('stt', 'tmp')));
    assert.ok(cfg.modelPath.endsWith(path.join('models', 'ggml-base.bin')));
    assert.ok(cfg.cliPath.includes(path.join('vendor', 'whisper.cpp', 'build', 'bin', 'whisper-cli')));
  });

  await test('stt validacao: aceita M4A com marca Apple e redige URL de erro', () => {
    const m4a = Buffer.alloc(256, 0);
    m4a.write('ftyp', 4, 'ascii');
    m4a.write('M4A ', 8, 'ascii');
    const check = validateAudio(m4a, { mimetype: 'audio/mp4' });
    assert.strictEqual(check.ok, true);
    assert.strictEqual(check.mimetype, 'audio/mp4');
    const text = errorText(new Error('falha em https://mmg.whatsapp.net/media?token=segredo HTTP 503'));
    assert.ok(!text.includes('token=segredo'));
    assert.ok(text.includes('[url]'));
    assert.ok(text.includes('HTTP 503'));
  });

  await test('stt audio: sha256, duracao de wav e silencio', () => {
    const a = Buffer.from('abc');
    assert.strictEqual(sha256(a), sha256(Buffer.from('abc')));
    assert.notStrictEqual(sha256(a), sha256(Buffer.from('abd')));
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(16000 * 2, 0)]);
    assert.strictEqual(Math.round(wavDurationSec(wav)), 1);
    const extra = Buffer.alloc(56 + 16000 * 2, 0);
    extra.write('RIFF', 0); extra.writeUInt32LE(extra.length - 8, 4); extra.write('WAVE', 8);
    extra.write('fmt ', 12); extra.writeUInt32LE(16, 16);
    extra.write('LIST', 36); extra.writeUInt32LE(4, 40); extra.write('INFO', 44);
    extra.write('data', 48); extra.writeUInt32LE(16000 * 2, 52);
    assert.strictEqual(Math.round(wavDurationSec(extra)), 1);
    assert.strictEqual(isSilent(-60, -55), true);
    assert.strictEqual(isSilent(-20, -55), false);
    assert.strictEqual(isSilent(null, -55), false);
    assert.strictEqual(parseMeanVolume('mean_volume: -23.5 dB'), -23.5);
    assert.strictEqual(parseMeanVolume('sem volume'), null);
  });

  await test('stt cache: grava, le, expira e respeita orcamento', () => {
    let now = 1700000000000;
    const dir = tmpDir('cache-unit');
    const cache = new TranscriptionCache({
      dir,
      maxBytes: 2048,
      ttlMs: 1000,
      now: () => now
    }).init();
    assert.ok(cache.set('k1', { text: 'ola mundo', engine: 'fake' }));
    assert.strictEqual(cache.get('k1').text, 'ola mundo');
    assert.ok(cache.set('k1', { text: 'ola mundo atualizado', engine: 'fake' }));
    assert.strictEqual(cache.get('k1').text, 'ola mundo atualizado');
    now += 2000;
    assert.strictEqual(cache.get('k1'), null, 'entrada expirada deve ser ignorada');
    for (let i = 0; i < 10; i++) cache.set(`k${i}`, { text: 'x'.repeat(300) });
    assert.ok(cache.stats().mb <= 1, 'nunca passa do orcamento');
    assert.ok(cache.get('k9'), 'entrada mais recente sobrevive ao LRU');
  });

  await test('stt gate: round-robin entre zaps evita monopolio', async () => {
    const gate = new SttGate({ maxConcurrent: 1, maxPerZap: 1, maxQueueWaitMs: 5000 });
    const order = [];
    const runJob = (zap, id) => gate.acquire({ zapId: zap, jobKey: id }).then((release) => {
      order.push(id);
      return new Promise((resolve) => {
        setTimeout(() => { release(); resolve(); }, 15);
      });
    });
    await Promise.all([
      runJob('A', 'A1'),
      runJob('A', 'A2'),
      runJob('B', 'B1'),
      runJob('C', 'C1')
    ]);
    assert.strictEqual(order[0], 'A1');
    assert.strictEqual(order[1], 'B1', 'outro cliente deve passar antes do segundo audio de A');
    assert.ok(order.indexOf('A2') > order.indexOf('B1'));
    assert.ok(order.includes('C1'));
  });

  await test('stt gate: espera maxima devolve defer (nao descarta)', async () => {
    const gate = new SttGate({ maxConcurrent: 1, maxPerZap: 1, maxQueueWaitMs: 40 });
    const release = await gate.acquire({ zapId: 'A', jobKey: 'A1' });
    let err = null;
    try {
      await gate.acquire({ zapId: 'B', jobKey: 'B1' });
    } catch (e) {
      err = e;
    }
    release();
    assert.ok(err, 'a segunda tarefa nao pode ser atendida');
    assert.strictEqual(err.defer, true);
    assert.strictEqual(err.code, 'STT_QUEUE_WAIT');
  });

  await test('stt recursos: pausa admissao com pouca RAM', () => {
    const guard = new ResourceGuard({
      minFreeMemMB: 180,
      readMemory: () => ({ total: 2 * 1024 ** 3, available: 100 * 1024 ** 2, swapTotal: 0, swapUsed: 0 }),
      readDisk: () => ({ free: 30 * 1024 ** 3, usedPct: 10 })
    });
    const r = guard.check();
    assert.strictEqual(r.ok, false);
    assert.ok(/RAM livre/.test(r.reason));
    assert.strictEqual(guard.stats().paused, true);
  });

  await test('stt metricas: totais, percentis e taxas', () => {
    const m = new SttMetrics({ filePath: '' });
    m.recordReceived('z1');
    m.recordReceived('z2');
    m.recordCompleted({ zapId: 'z1', sttMs: 100, queueWaitMs: 10, cached: false });
    m.recordCompleted({ zapId: 'z2', sttMs: 300, queueWaitMs: 30, cached: true });
    m.recordFailed({ zapId: 'z1', kind: 'corrupt' });
    const s = m.snapshot();
    assert.strictEqual(s.totals.received, 2);
    assert.strictEqual(s.totals.completed, 2);
    assert.strictEqual(s.totals.failed, 1);
    assert.strictEqual(s.totals.cached, 1);
    assert.strictEqual(s.stt.p50, 100);
    assert.strictEqual(s.stt.p95, 300);
    assert.strictEqual(s.clients.active, 2);
  });

  await test('stt http: multipart e parsing de resposta', () => {
    const mp = buildMultipart([
      { name: 'file', filename: 'a.wav', contentType: 'audio/wav', value: Buffer.from('RIFF1234') },
      { name: 'language', value: 'pt' }
    ]);
    const body = mp.body.toString('utf8');
    assert.ok(body.includes(`--${mp.boundary}`));
    assert.ok(body.includes('name="file"; filename="a.wav"'));
    assert.ok(body.includes('RIFF1234'));
    assert.strictEqual(parseInferenceBody(200, 'application/json', '{"text":" ola "}').text, 'ola');
    assert.strictEqual(parseInferenceBody(200, 'text/plain', 'ola mundo').text, 'ola mundo');
    assert.throws(() => parseInferenceBody(400, 'application/json', '{"error":"bad audio"}'), /bad audio/);
  });

  await test('stt http: cliente fala com servidor whisper real simulado', async () => {
    let inferenceBody = '';
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }
      if (req.method === 'POST' && req.url === '/inference') {
        req.on('data', (chunk) => { inferenceBody += chunk.toString('latin1'); });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text: 'ola do whisper' }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      const engine = new HttpWhisperEngine({ url: `http://127.0.0.1:${port}`, model: 'tiny', lang: 'pt' });
      assert.strictEqual((await engine.health(true)).ok, true);
      const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(100, 0)]);
      const out = await engine.transcribe({ wav, lang: 'pt', durationSec: 1 });
      assert.strictEqual(out.text, 'ola do whisper');
      assert.ok(inferenceBody.includes('name="file"; filename="audio.wav"'));
      assert.ok(inferenceBody.includes('name="language"'));
      assert.ok(inferenceBody.includes('pt'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await test('stt cli: limpa timestamps e ruido do stdout', () => {
    const out = [
      '[00:00:00.000 --> 00:00:02.000]   bom dia',
      '[00:00:02.000 --> 00:00:04.000]   tudo bem?',
      '[BLANK_AUDIO]',
      ''
    ].join('\n');
    assert.strictEqual(parseCliOutput(out), 'bom dia tudo bem?');
  });

  await test('stt manager: transcreve, grava cache e nao repete o motor', async () => {
    const { manager, ctx } = makeManager();
    const buffer = oggBuffer();
    const first = await manager.transcribe({ buffer, mimetype: 'audio/ogg', zapId: 'zapA', msgId: 'm1' });
    assert.strictEqual(first.text, 'bom dia, tudo bem?');
    assert.strictEqual(first.cached, false);
    assert.strictEqual(ctx.engineCalls.length, 1);
    assert.strictEqual(ctx.engineCalls[0].job.zapId, 'zapA');

    const second = await manager.transcribe({ buffer, mimetype: 'audio/ogg', zapId: 'zapB', msgId: 'm2' });
    assert.strictEqual(second.cached, true);
    assert.strictEqual(ctx.engineCalls.length, 1, 'mesmo audio nao deve ir ao motor duas vezes');
    const stats = manager.stats();
    assert.strictEqual(stats.totals.completed, 2);
    assert.strictEqual(stats.totals.cached, 1);
  });

  await test('stt manager: rajada identica reconfere cache depois da fila', async () => {
    const { manager, ctx } = makeManager({
      engine: fakeEngine(async (input) => {
        ctx.engineCalls.push(input);
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { text: 'texto unico', engine: 'fake', model: 'tiny', lang: 'pt', sttMs: 25 };
      })
    });
    const buffer = oggBuffer();
    const results = await Promise.all([
      manager.transcribe({ buffer, mimetype: 'audio/ogg', zapId: 'A', msgId: 'm1' }),
      manager.transcribe({ buffer, mimetype: 'audio/ogg', zapId: 'B', msgId: 'm2' }),
      manager.transcribe({ buffer, mimetype: 'audio/ogg', zapId: 'C', msgId: 'm3' })
    ]);
    assert.strictEqual(ctx.engineCalls.length, 1, 'a mesma inferencia nao deve repetir na rajada');
    assert.strictEqual(results.filter((r) => r.cached).length, 2);
    assert.strictEqual(manager.stats().totals.completed, 3);
  });

  await test('stt manager: FFmpeg ausente adia em vez de perder o audio', async () => {
    const { manager, ctx } = makeManager({
      processor: {
        sha256: (buf) => sha256(buf),
        process: async () => { throw new Error('spawn ffmpeg ENOENT'); }
      }
    });
    let err = null;
    try {
      await manager.transcribe({ buffer: oggBuffer(), mimetype: 'audio/ogg', zapId: 'z', msgId: 'm' });
    } catch (e) { err = e; }
    assert.ok(err && err.defer);
    assert.strictEqual(err.kind, 'infra');
    assert.strictEqual(ctx.engineCalls.length, 0);
  });

  await test('stt manager: audio sem fala nao chega na IA', async () => {
    const { manager, ctx } = makeManager({
      processor: fakeProcessor({ silent: true, meanVolumeDb: -70 })
    });
    let err = null;
    try {
      await manager.transcribe({ buffer: oggBuffer(), mimetype: 'audio/ogg', zapId: 'z', msgId: 'm' });
    } catch (e) { err = e; }
    assert.ok(err);
    assert.strictEqual(err.code, 'STT_SILENT');
    assert.strictEqual(err.defer, false);
    assert.strictEqual(ctx.engineCalls.length, 0);
  });

  await test('stt manager: motor fora do ar adia sem gastar API', async () => {
    const { manager, ctx } = makeManager({
      engine: fakeEngine(async () => {
        ctx.engineCalls.push(1);
        const e = new Error('motor fora do ar');
        e.defer = true;
        e.kind = 'transient';
        throw e;
      }),
      fallback: async () => { ctx.fallbackCalls.push(1); return 'nao deveria'; }
    });
    let err = null;
    try {
      await manager.transcribe({ buffer: oggBuffer(), mimetype: 'audio/ogg', zapId: 'z', msgId: 'm' });
    } catch (e) { err = e; }
    assert.ok(err && err.defer, 'falha de infraestrutura deve ser adiada');
    assert.strictEqual(ctx.fallbackCalls.length, 0, 'fallback desligado por padrao');
    assert.strictEqual(manager.stats().totals.failed, 0, 'defer nao conta como falha definitiva');
  });

  await test('stt manager: fallback externo so quando habilitado', async () => {
    const cfg = baseConfig({ LINK_STT_FALLBACK_API: '1' });
    const { manager, ctx } = makeManager({
      config: cfg,
      engine: fakeEngine(async () => {
        const e = new Error('motor fora do ar');
        e.defer = true;
        throw e;
      }),
      fallback: async () => { ctx.fallbackCalls.push(1); return 'texto vindo da api'; }
    });
    const res = await manager.transcribe({ buffer: oggBuffer(), mimetype: 'audio/ogg', zapId: 'z', msgId: 'm' });
    assert.strictEqual(res.text, 'texto vindo da api');
    assert.strictEqual(res.engine, 'api-fallback');
    assert.strictEqual(ctx.fallbackCalls.length, 1);
  });

  await test('stt manager: canary restringe o motor local a zaps escolhidos', () => {
    const cfg = baseConfig({ LINK_STT_CANARY_ZAPS: 'zapA' });
    const { manager } = makeManager({ config: cfg });
    assert.strictEqual(manager.enabledFor('zapA'), true);
    assert.strictEqual(manager.enabledFor('zapB'), false);
  });

  await test('stt pipeline: defer nao consome tentativa e conclui depois', async () => {
    const dir = tmpDir('pipe');
    const store = new AudioTaskStore({
      filePath: path.join(dir, 'audio-tasks.json'),
      logger: { error() {}, info() {}, warn() {} }
    });
    const pipeline = new AudioPipeline({
      store,
      sleep: async () => {},
      config: { transcribeAttempts: 2, maxTranscribeDefers: 3, transcribeTimeoutMs: 5000 }
    });
    const { task } = pipeline.begin({ zapId: 'z1', msgId: 'm1' });
    let calls = 0;
    const handlers = {
      download: async () => ({ buffer: oggBuffer(), mimetype: 'audio/ogg' }),
      transcribe: async () => {
        calls++;
        if (calls === 1) {
          const e = new Error('motor subindo');
          e.defer = true;
          e.kind = 'transient';
          throw e;
        }
        return { text: 'texto local', engine: 'fake', model: 'tiny', sttMs: 50, queueWaitMs: 5, sha256: 'abc' };
      }
    };
    const first = await pipeline.run(task.key, handlers);
    assert.strictEqual(first.retryLater, true);
    assert.strictEqual(store.get(task.key).state, 'RETRYING');
    assert.strictEqual(store.get(task.key).deferCount, 1);

    const second = await pipeline.run(task.key, handlers);
    assert.strictEqual(second.ok, true);
    const saved = store.get(task.key);
    assert.strictEqual(saved.state, 'TRANSCRIBED');
    assert.strictEqual(saved.engine, 'fake');
    assert.strictEqual(saved.sttMs, 50);
    assert.strictEqual(saved.sha256, 'abc');
    assert.strictEqual(saved.deferCount, 0, 'sucesso zera os adiamentos');
  });

  await test('stt pipeline: muitos defers caem no fluxo normal (DLQ)', async () => {
    const dir = tmpDir('pipe-dlq');
    const store = new AudioTaskStore({
      filePath: path.join(dir, 'audio-tasks.json'),
      logger: { error() {}, info() {}, warn() {} }
    });
    const pipeline = new AudioPipeline({
      store,
      sleep: async () => {},
      config: { transcribeAttempts: 1, maxTranscribeDefers: 1, transcribeTimeoutMs: 5000 }
    });
    const { task } = pipeline.begin({ zapId: 'z1', msgId: 'm1' });
    const handlers = {
      download: async () => ({ buffer: oggBuffer(), mimetype: 'audio/ogg' }),
      transcribe: async () => {
        const e = new Error('motor fora do ar');
        e.defer = true;
        e.kind = 'transient';
        throw e;
      }
    };
    const first = await pipeline.run(task.key, handlers);
    assert.strictEqual(first.retryLater, true);
    const second = await pipeline.run(task.key, handlers);
    assert.strictEqual(second.deadLetter, true);
    assert.strictEqual(store.get(task.key).state, 'DEAD_LETTER');
  });

  console.log('');
  if (failures.length) {
    console.log(`${failures.length} falha(s) de ${passed + failures.length} testes de STT`);
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    process.exitCode = 1;
  } else {
    console.log(`${passed}/${passed} testes de STT passaram`);
  }
}

run().catch((e) => {
  console.error('falha inesperada nos testes de STT:', e);
  process.exitCode = 1;
});
