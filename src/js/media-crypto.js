const crypto = require('crypto');

const MEDIA_INFO = {
  audio: 'WhatsApp Audio Keys',
  ptt: 'WhatsApp Audio Keys',
  image: 'WhatsApp Image Keys',
  video: 'WhatsApp Video Keys',
  gif: 'WhatsApp Video Keys',
  document: 'WhatsApp Document Keys',
  sticker: 'WhatsApp Sticker Keys',
};

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'string') return Buffer.from(value, 'base64');
  throw new TypeError('conteudo de midia invalido');
}

// Descriptografa a midia do WhatsApp sem passar pelo DownloadManager, que
// rejeita ptt quando o mimetype nao e informado (application/octet-stream).
function decryptWhatsAppMedia(encrypted, mediaKey, type) {
  const payload = toBuffer(encrypted);
  const key = toBuffer(mediaKey);
  if (key.length !== 32) throw new Error(`mediaKey invalida (${key.length} bytes)`);
  if (payload.length <= 10) throw new Error('midia criptografada muito curta');

  const info = MEDIA_INFO[String(type || '').toLowerCase()] || MEDIA_INFO.audio;
  const derived = Buffer.from(
    crypto.hkdfSync('sha256', key, Buffer.alloc(32), Buffer.from(info), 112)
  );
  const iv = derived.subarray(0, 16);
  const cipherKey = derived.subarray(16, 48);
  const macKey = derived.subarray(48, 80);
  const ciphertext = payload.subarray(0, payload.length - 10);
  const mac = payload.subarray(payload.length - 10);
  const expected = crypto
    .createHmac('sha256', macKey)
    .update(Buffer.concat([iv, ciphertext]))
    .digest()
    .subarray(0, 10);

  if (!crypto.timingSafeEqual(mac, expected)) {
    throw new Error('assinatura da midia nao confere');
  }

  const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = { decryptWhatsAppMedia };
