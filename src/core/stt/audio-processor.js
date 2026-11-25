'use strict';

// Preparo do audio para o motor local.
//
// Responsabilidades:
// - SHA-256 do arquivo original (chave do cache);
// - validar formato/duracao com ffprobe;
// - converter para WAV 16 kHz mono PCM (exigencia do whisper.cpp);
// - medir o volume medio para nao entregar silencio ao modelo.
//
// Probe e volume usam pipes. A conversao final usa um WAV temporario curto
// porque o whisper.cpp exige RIFF/data com tamanhos finais validos.
// Se o FFmpeg faltar, o erro e explicito e nao derruba o processo.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const MAX_OUTPUT_BYTES = 96 * 1024 * 1024; // ~50 min de WAV 16 kHz mono

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Executa um binario passando um buffer no stdin e devolvendo stdout/stderr.
function runBinary(bin, args, options = {}) {
  const input = options.input || null;
  const timeoutMs = Number(options.timeoutMs) || 60000;
  const maxBytes = Number(options.maxBytes) || MAX_OUTPUT_BYTES;

  return new Promise((resolve) => {
    let done = false;
    let stdout = [];
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      finish({ ok: false, code: -1, stdout: Buffer.alloc(0), stderr: e.message, timedOut: false });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (_) {}
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch (_) {}
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      // Limita o stderr: alguns builds do ffmpeg sao verborragicos.
      if (stderr.length < 64000) stderr += chunk.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, code: -1, stdout: Buffer.alloc(0), stderr: e.message, timedOut: false });
    });
    child.stdin.on('error', () => { /* o binario pode encerrar antes de ler o pipe */ });
    // No Windows, o pipe de stdin do ffmpeg pode precisar de um pequeno delay
    // para evitar 'write EOF' prematuro (shim do Scoop / handler de pipe).
    setImmediate(() => {
      try {
        if (input) child.stdin.end(input);
        else child.stdin.end();
      } catch (_) { /* processo ja pode ter morrido */ }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({
        ok: code === 0 && !timedOut,
        code,
        stdout: Buffer.concat(stdout),
        stderr: timedOut && !stderr ? 'timeout' : stderr,
        timedOut
      });
    });

  });
}

async function probeBuffer(options) {
  const r = await runBinary(options.ffprobePath || 'ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,format_name',
    '-of', 'json',
    '-i', 'pipe:0'
  ], { input: options.buffer, timeoutMs: options.timeoutMs || 20000 });

  if (!r.ok) return { ok: false, error: (r.stderr || 'ffprobe falhou').slice(0, 300) };
  try {
    const parsed = JSON.parse(r.stdout.toString('utf8') || '{}');
    const fmt = parsed.format || {};
    const duration = Number(fmt.duration);
    return {
      ok: true,
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : 0,
      format: String(fmt.format_name || '')
    };
  } catch (e) {
    return { ok: false, error: `ffprobe devolveu JSON invalido: ${e.message}` };
  }
}

async function transcodeToWav16k(options) {
  const dir = options.tempDir || os.tmpdir();
  const token = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const inFile = path.join(dir, `stt-in-${token}.bin`);
  const outFile = path.join(dir, `stt-out-${token}.wav`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(inFile, options.buffer);
    const r = await runBinary(options.ffmpegPath || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inFile,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      '-f', 'wav',
      outFile
    ], { timeoutMs: options.timeoutMs || 60000 });

    if (!r.ok) {
      const reason = r.timedOut ? 'conversao do audio excedeu o tempo' : (r.stderr || 'conversao falhou');
      return { ok: false, error: String(reason).slice(0, 300) };
    }
    const wav = fs.readFileSync(outFile);
    if (wav.length <= 44) return { ok: false, error: 'conversao retornou WAV vazio' };
    if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
      return { ok: false, error: 'conversao nao produziu um WAV valido' };
    }
    return { ok: true, wav };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 300) };
  } finally {
    try { fs.unlinkSync(inFile); } catch (_) {}
    try { fs.unlinkSync(outFile); } catch (_) {}
  }
}

function parseMeanVolume(stderr) {
  const m = String(stderr || '').match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
  if (!m) return null;
  const db = Number(m[1]);
  return Number.isFinite(db) ? db : null;
}

async function measureVolume(options) {
  const r = await runBinary(options.ffmpegPath || 'ffmpeg', [
    '-hide_banner',
    '-i', 'pipe:0',
    '-af', 'volumedetect',
    '-f', 'null',
    '-'
  ], { input: options.wav, timeoutMs: options.timeoutMs || 20000 });
  // volumedetect escreve o resultado no stderr e sai com 0.
  if (!r.ok && !r.stderr) return null;
  return parseMeanVolume(r.stderr);
}

// Duracao exata de um WAV PCM 16 bits mono 16 kHz, sem depender do ffprobe.
function wavDurationSec(wav) {
  if (!Buffer.isBuffer(wav) || wav.length <= 44) return 0;
  const byteRate = 16000 * 2;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'data') return Math.max(0, size / byteRate);
    offset += 8 + size + (size % 2);
  }
  return Math.max(0, (wav.length - 44) / byteRate);
}

function isSilent(meanDb, thresholdDb) {
  if (meanDb == null) return false;
  if (!Number.isFinite(Number(thresholdDb))) return false;
  return Number(meanDb) <= Number(thresholdDb);
}

function createAudioProcessor(options = {}) {
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  const ffmpegPath = options.ffmpegPath || 'ffmpeg';
  const ffprobePath = options.ffprobePath || 'ffprobe';
  const tempDir = options.tempDir || os.tmpdir();
  const silenceDb = options.silenceDb == null ? -55 : Number(options.silenceDb);
  const minAudioSec = options.minAudioSec == null ? 0.35 : Number(options.minAudioSec);
  const maxAudioSec = options.maxAudioSec == null ? 600 : Number(options.maxAudioSec);
  const probe = options.probe || probeBuffer;
  const transcode = options.transcode || transcodeToWav16k;
  const measure = options.measure || measureVolume;

  async function process(buffer, mimetype, meta = {}) {
    const startedAt = Date.now();
    const hash = sha256(buffer);

    let durationSec = Number(meta.durationSec) || 0;
    let format = String(meta.format || '');

    if (!durationSec) {
      const info = await probe({ ffprobePath, buffer, timeoutMs: 20000 });
      if (!info.ok) {
        const err = new Error(`nao foi possivel ler o audio: ${info.error}`);
        err.kind = 'corrupt';
        err.defer = false;
        throw err;
      }
      durationSec = info.durationSec;
      format = info.format;
    }

    if (durationSec && durationSec < minAudioSec) {
      const err = new Error(`audio curto demais (${durationSec.toFixed(2)}s)`);
      err.kind = 'limit';
      err.defer = false;
      throw err;
    }
    if (durationSec && durationSec > maxAudioSec) {
      const err = new Error(`audio longo demais (${Math.round(durationSec)}s, max ${maxAudioSec}s)`);
      err.kind = 'limit';
      err.defer = false;
      throw err;
    }

    const conv = await transcode({ ffmpegPath, buffer, mimetype, tempDir, timeoutMs: 60000 });
    if (!conv.ok) {
      const err = new Error(conv.error || 'falha ao converter o audio');
      err.kind = 'corrupt';
      err.defer = false;
      throw err;
    }

    const wav = conv.wav;
    const wavSec = wavDurationSec(wav);
    if (!wavSec) {
      const err = new Error('audio convertido sem duracao');
      err.kind = 'corrupt';
      err.defer = false;
      throw err;
    }
    if (wavSec > maxAudioSec) {
      const err = new Error(`audio longo demais apos conversao (${Math.round(wavSec)}s)`);
      err.kind = 'limit';
      err.defer = false;
      throw err;
    }

    const meanDb = await measure({ ffmpegPath, wav, timeoutMs: 20000 });
    const silent = isSilent(meanDb, silenceDb);

    logger('info', 'audio preparado para STT', {
      sha256: hash.slice(0, 12),
      format,
      durationSec: Math.round(wavSec * 100) / 100,
      meanDb,
      silent,
      wavKB: Math.round(wav.length / 1024),
      ms: Date.now() - startedAt
    });

    return {
      wav,
      sha256: hash,
      durationSec: wavSec,
      meanVolumeDb: meanDb,
      silent,
      format
    };
  }

  return { process, sha256, probe, transcode, measure };
}

module.exports = {
  createAudioProcessor,
  sha256,
  runBinary,
  probeBuffer,
  transcodeToWav16k,
  measureVolume,
  parseMeanVolume,
  wavDurationSec,
  isSilent
};
