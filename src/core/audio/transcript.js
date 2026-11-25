'use strict';

// Normalizacao do texto vindo dos provedores de transcricao.
//
// Whisper e Gemini costumam devolver artefatos quando o audio esta mudo ou
// tem so ruido ("[Musica]", "(silencio)", "Legenda:", "..." etc.). Isso nao
// pode chegar na IA como se fosse uma mensagem do cliente.

const MUSIC_OR_SILENCE = /^[\[(]?\s*(musica|m[uú]sica|silencio|silêncio|slience|silence|ruido|ruído|aplausos|risadas|inaudivel|inaudível)\s*[\])]?\.?$/i;
const BOILERPLATE = /^(legenda|legendas|subtitulos|subtítulos|transcri[cç][aã]o)\s*[:\-]/i;

function normalizeTranscript(value) {
  let text = String(value == null ? '' : value)
    .replace(/\u0000/g, '')
    .replace(/\r/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Remove prefixos que alguns modelos adicionam.
  text = text.replace(/^transcri[cç][aã]o\s*[:\-]\s*/i, '');
  text = text.replace(/^legenda\s*[:\-]\s*/i, '');
  return text.trim();
}

function isUsableTranscript(value) {
  const text = normalizeTranscript(value);
  if (!text) return false;
  if (text.length < 2) return false;
  if (MUSIC_OR_SILENCE.test(text)) return false;
  if (BOILERPLATE.test(text) && text.length < 20) return false;
  if (/^[\W_]+$/.test(text)) return false;
  // Repeticoes infinitas do mesmo token ("ah ah ah ah ...") normalmente sao
  // alucinacao de ruido, mas fala real tambem repete. So corta casos extremos.
  const words = text.split(/\s+/);
  if (words.length >= 12) {
    const unique = new Set(words.map((w) => w.toLowerCase()));
    if (unique.size <= 2) return false;
  }
  return true;
}

module.exports = { normalizeTranscript, isUsableTranscript };
