'use strict';

// Validacao real dos bytes de audio recebidos.
//
// Baixar com HTTP 200 nao significa que o arquivo e um audio: a CDN pode
// devolver uma pagina de erro, JSON, ou um arquivo truncado. Antes de gastar
// uma chamada de transcricao, conferimos tamanho e assinatura binaria.

const MAX_DEFAULT_MB = Number(process.env.LINK_AUDIO_MAX_MB) || 25;
const MIN_DEFAULT_BYTES = Number(process.env.LINK_AUDIO_MIN_BYTES) || 64;

// Assinaturas de containers de audio usados pelo WhatsApp e pelos provedores.
function sniffAudioMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return '';
  const b = buf;

  if (b.length >= 4 && b.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (b.length >= 4 && b.toString('ascii', 0, 4) === 'RIFF' &&
      b.length >= 12 && b.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (b.length >= 3 && b.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (b.length >= 2 && b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) {
    // MPEG frame sync (MP3) ou ADTS (AAC). O segundo byte 0xF1/0xF9 e ADTS.
    if (b.length >= 2 && (b[1] & 0xF6) === 0xF0) return 'audio/aac';
    return 'audio/mpeg';
  }
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12).trim();
    if (/^(M4A|M4B|M4P|mp42|mp41|isom|iso2|dash)$/i.test(brand)) return 'audio/mp4';
    return 'video/mp4'; // pode ser um video com faixa de audio
  }
  if (b.length >= 6 && b.toString('ascii', 0, 6) === '#!AMR\n') return 'audio/amr';
  if (b.length >= 4 && b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return 'audio/webm';

  return '';
}

// Formatos que claramente NAO sao audio. Se um deles aparecer, o download
// "deu certo" mas o conteudo esta errado: melhor tentar outra copia.
function looksLikeNonAudio(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  const head = buf.toString('ascii', 0, Math.min(24, buf.length)).toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) return true;
  if (head.startsWith('{') || head.startsWith('[')) return true; // JSON de erro
  if (buf.length >= 4 && buf[0] === 0x89 && b(buf, 1, 4) === 'PNG') return true;
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'GIF8') return true;
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === '%PDF') return true;
  return false;
}

function b(buf, start, end) {
  return buf.toString('ascii', start, Math.min(end, buf.length));
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === 'string') {
    let s = input.trim();
    const comma = s.indexOf(',');
    if (s.startsWith('data:') && comma !== -1) s = s.slice(comma + 1);
    return Buffer.from(s, 'base64');
  }
  return Buffer.alloc(0);
}

// opts: { minBytes, maxBytes, mimetype, allowVideoAudio }
// Retorna { ok, buffer, mimetype, size, sniffed, reason, kind }.
function validateAudio(input, opts = {}) {
  const buf = toBuffer(input);
  const size = buf.length;
  const minBytes = Number(opts.minBytes) || MIN_DEFAULT_BYTES;
  const maxBytes = Number(opts.maxBytes) || MAX_DEFAULT_MB * 1024 * 1024;
  const declared = String(opts.mimetype || '').split(';')[0].trim().toLowerCase();

  if (!size) {
    return { ok: false, reason: 'arquivo vazio', kind: 'empty', size: 0 };
  }
  if (size < minBytes) {
    return { ok: false, reason: `arquivo pequeno demais (${size} bytes)`, kind: 'limit', size };
  }
  if (size > maxBytes) {
    return { ok: false, reason: `arquivo grande demais (${size} bytes)`, kind: 'limit', size };
  }
  if (looksLikeNonAudio(buf)) {
    return { ok: false, reason: 'conteudo nao e audio (pagina/JSON/imagem)', kind: 'corrupt', size };
  }

  const sniffed = sniffAudioMime(buf);
  const isVideo = sniffed === 'video/mp4';
  const declaredAudio = declared.startsWith('audio/');
  if (isVideo && !opts.allowVideoAudio && !declaredAudio) {
    return { ok: false, reason: 'container de video sem faixa de audio confirmada', kind: 'unsupported', size, sniffed };
  }

  if (!sniffed && !declaredAudio) {
    return { ok: false, reason: 'formato de audio nao reconhecido', kind: 'unsupported', size };
  }

  return {
    ok: true,
    buffer: buf,
    size,
    sniffed: !!sniffed,
    mimetype: sniffed && sniffed !== 'video/mp4' ? sniffed : (declared || 'audio/ogg')
  };
}

module.exports = { sniffAudioMime, looksLikeNonAudio, validateAudio, toBuffer };
