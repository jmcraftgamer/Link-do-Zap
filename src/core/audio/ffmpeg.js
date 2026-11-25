'use strict';

// Apoio opcional ao FFmpeg/FFprobe.
//
// O caminho normal (OGG/OPUS do WhatsApp) nao precisa de conversao: Whisper e
// Gemini aceitam o formato. O FFmpeg entra apenas quando instalado e quando:
// - o container nao e reconhecido/suportado;
// - o audio precisa de normalizacao;
// - queremos medir a duracao para cortar audios vazios ou longos demais.
//
// Se o binario nao existir, nada quebra: o audio original segue para a
// transcricao. Nenhuma dependencia nova e obrigatoria.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PROVIDER_MIMES = new Set([
  'audio/ogg', 'audio/opus', 'audio/mpeg', 'audio/mp3', 'audio/mp4',
  'audio/m4a', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/webm',
  'audio/flac', 'audio/aac'
]);

function run(bin, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    try {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        finish({ ok: false, code: -1, stdout, stderr: stderr + ' timeout' });
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, code: -1, stdout, stderr: stderr + e.message }); });
      child.on('exit', (code) => { clearTimeout(timer); finish({ ok: code === 0, code, stdout, stderr }); });
    } catch (e) {
      finish({ ok: false, code: -1, stdout: '', stderr: e.message });
    }
  });
}

function tempFile(ext) {
  const name = `link-audio-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  return path.join(os.tmpdir(), name);
}

function extForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('wav')) return 'wav';
  if (m.includes('webm')) return 'webm';
  if (m.includes('amr')) return 'amr';
  return 'bin';
}

async function probeFile(bin, buffer, mimetype) {
  const ext = extForMime(mimetype);
  const file = tempFile(ext);
  try {
    fs.writeFileSync(file, buffer);
    const r = await run(bin, [
      '-v', 'error',
      '-show_entries', 'format=duration,format_name',
      '-of', 'json',
      file
    ], 20000);
    if (!r.ok) return null;
    const parsed = JSON.parse(r.stdout || '{}');
    const fmt = parsed.format || {};
    const duration = Number(fmt.duration);
    return {
      duration: Number.isFinite(duration) ? duration : 0,
      format: String(fmt.format_name || '')
    };
  } catch (_) {
    return null;
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

async function transcodeFile(bin, buffer, mimetype, targetMime = 'audio/ogg') {
  const inFile = tempFile(extForMime(mimetype));
  const outFile = tempFile(extForMime(targetMime));
  try {
    fs.writeFileSync(inFile, buffer);
    const r = await run(bin, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inFile,
      '-vn',
      '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1',
      '-f', 'ogg', outFile
    ], 60000);
    if (!r.ok) return null;
    const out = fs.readFileSync(outFile);
    return out.length ? { buffer: out, mimetype: 'audio/ogg', size: out.length } : null;
  } catch (_) {
    return null;
  } finally {
    try { fs.unlinkSync(inFile); } catch (_) {}
    try { fs.unlinkSync(outFile); } catch (_) {}
  }
}

// Cria a funcao de preparo usada pelo AudioPipeline. As funcoes de probe e
// transcode sao injetaveis para os testes nao dependerem do binario.
function createAudioPreparer(options = {}) {
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  const minDuration = Number(options.minDurationSec) || 0.35;
  const maxDuration = Number(options.maxDurationSec) || 10 * 60;
  const probe = options.probe || probeFile;
  const transcode = options.transcode || transcodeFile;
  const ffprobePath = options.ffprobePath || process.env.LINK_FFPROBE_PATH || 'ffprobe';
  const ffmpegPath = options.ffmpegPath || process.env.LINK_FFMPEG_PATH || 'ffmpeg';

  let available = null; // null = ainda nao detectado

  async function detect() {
    if (available !== null) return available;
    const probeOk = await run(ffprobePath, ['-version'], 8000);
    let transcodeOk = false;
    if (probeOk.ok) {
      const ff = await run(ffmpegPath, ['-version'], 8000);
      transcodeOk = ff.ok;
    }
    available = { probe: probeOk.ok, transcode: transcodeOk, ffprobePath, ffmpegPath };
    if (!available.probe) logger('info', 'ffprobe indisponivel; seguindo sem validacao de duracao');
    return available;
  }

  async function prepare(audio, task = {}) {
    const out = {
      buffer: audio.buffer,
      mimetype: audio.mimetype,
      size: audio.size
    };
    if (!out.buffer || !out.buffer.length) return out;

    const mime = String(out.mimetype || '').toLowerCase();
    const needsConversion = mime && !PROVIDER_MIMES.has(mime) && !mime.startsWith('video/');
    let info = null;

    const caps = await detect();
    if (caps.probe) {
      info = await probe(caps.ffprobePath, out.buffer, out.mimetype);
      if (info) {
        if (info.duration > 0 && info.duration < minDuration) {
          const err = new Error(`audio curto demais (${info.duration.toFixed(2)}s)`);
          err.validationKind = 'limit';
          throw err;
        }
        if (info.duration > maxDuration) {
          const err = new Error(`audio longo demais (${Math.round(info.duration)}s)`);
          err.validationKind = 'limit';
          throw err;
        }
      }
    }

    const shouldConvert = needsConversion || (options.alwaysTranscode === true);
    if (shouldConvert && caps.transcode) {
      logger('info', `convertendo audio ${out.mimetype || '?'} para ogg/opus`);
      const converted = await transcode(caps.ffmpegPath, out.buffer, out.mimetype);
      if (converted) {
        out.buffer = converted.buffer;
        out.mimetype = converted.mimetype;
        out.size = converted.size;
        out.converted = true;
      }
    }

    out.durationSec = info ? info.duration : 0;
    out.format = info ? info.format : '';
    return out;
  }

  return { prepare, detect, _setAvailable: (v) => { available = v; } };
}

module.exports = { createAudioPreparer, probeFile, transcodeFile, PROVIDER_MIMES, extForMime };
