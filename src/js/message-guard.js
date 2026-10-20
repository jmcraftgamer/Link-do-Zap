// ============================================================
// Verificador de mensagens (message guard)
// ------------------------------------------------------------
// Decide, ANTES de enviar, se um texto pode ir ao cliente como
// mensagem normal de WhatsApp. Puro (regex/contagem), sem rede e
// sem IA: roda em microssegundos, entao nao pesa no fluxo.
//
// Reprova: vazio, codigo (```, JSON, XML, tool_call), markdown,
// marcador interno vazado ([SEND_IMAGE], [QUEBRA]...), texto de
// sistema (prompt/erro ecoado), meta ("as an AI"), ingles (somente
// quando o cliente escreveu em portugues) e lixo/simbolos.
// ============================================================
'use strict';

// Marcadores internos legitimos da IA (o sistema resolve/consome antes de
// enviar). Na checagem do texto CRU do modelo eles sao permitidos; na
// checagem final (pre-envio) qualquer colchete e vazamento.
const KNOWN_MARKER_RE = /^\[\s*(SEND[_\s-]?(?:IMAGE|IMG|LINK)|QUEBRA|BREAK|NOVA[_\s-]?MENSAGEM|MSG)\s*[:;]?/i;
const ANY_BRACKET_RE = /\[[^\[\]]{1,60}\]/g;

// Artefatos de erro/schema que nunca podem ir ao cliente (lista historica do
// isJunkResponse, preservada para nao regredir).
const ARTIFACT_PATTERNS = [
  /check\s*const/i,
  /finish_?reason/i,
  /max_?tokens?|maxoutputtokens/i,
  /\bquota\b|rate.?limit|too many requests/i,
  /invalid api key|api key not|unauthorized/i,
  /internal server error|service unavailable/i,
  /tool_use|tool_call|function_call/i,
  /\[object Object\]/,
  /promptFeedback|safetyRatings/i,
  /\btraceback\b/i,
  /thought\s*[:=]?\s*true/i
];

// Rotulos do proprio system prompt que modelos fracos costumam ecoar.
const PROMPT_LEAK_RE = new RegExp(
  [
    'REGRAS DE',
    'FORMATO DA RESPOSTA',
    'MENSAGENS MULTIPLAS',
    'REGRA UNIVERSAL',
    'INFORMACOES DO NEGOCIO',
    'MEMORIA DA CONVERSA',
    'ESTILO DE CONVERSA',
    'system\\s*prompt',
    'prompt\\s*do\\s*sistema',
    'instru[cç][õo]es\\s*do\\s*sistema',
    '\\*\\*\\*'
  ].join('|'),
  'i'
);

// Frases meta ("sou uma IA", "as an AI"...).
const META_RE = /\bas an ai\b|\blanguage model\b|sou uma (?:ia|intelig[êe]ncia artificial)|como (?:uma )?(?:ia|intelig[êe]ncia artificial)|i (?:cannot|can't|am unable to) help/i;

const PT_ACCENT_RE = /[áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ]/;
const BRACKET_ANY_RE = /\[[^\[\]]{1,80}\]/;

// Palavras em ingles pouco ambiguas com portugues.
const EN_STOPWORDS = new Set([
  'the', 'you', 'your', 'yours', 'please', 'could', 'would', 'should', 'will',
  'with', 'this', 'that', 'these', 'those', 'have', 'has', 'had', 'want', 'need',
  'order', 'message', 'messages', 'thanks', 'thank', 'hello', 'hey', 'sure',
  'sorry', 'from', 'about', 'there', 'what', 'when', 'where', 'which', 'who',
  'how', 'why', 'because', 'also', 'only', 'their', 'and', 'are', 'was', 'were',
  'been', 'does', 'did', 'get', 'make', 'made', 'time', 'today', 'tomorrow',
  'price', 'okay', 'available', 'hello', 'help'
]);

// Palavras/marcadores de portugues.
const PT_WORDS = new Set([
  'que', 'para', 'pra', 'voce', 'voces', 'nao', 'sim', 'com', 'uma', 'por',
  'obrigado', 'obrigada', 'tudo', 'bem', 'aqui', 'esta', 'estao', 'tem', 'tenho',
  'vou', 'pode', 'posso', 'como', 'oi', 'ola', 'bom', 'boa', 'dia', 'tarde',
  'noite', 'beleza', 'valeu', 'tamo', 'junto', 'ate', 'mais', 'tambem', 'sobre',
  'quando', 'onde', 'qual', 'quem', 'porque', 'muito', 'obg', 'blz', 'vc', 'tmj',
  'ta', 'ne', 'entao', 'isso', 'esse', 'essa', 'este', 'seu', 'sua', 'meu',
  'minha', 'nos', 'ser', 'estar', 'fazer', 'ter', 'dar', 'ver', 'quer', 'quero'
]);

function normWords(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function uniqWords(text) {
  return new Set(normWords(text));
}

// "Confianca" de que o texto e portugues.
function ptScore(text) {
  const raw = String(text || '');
  let s = 0;
  if (PT_ACCENT_RE.test(raw)) s += 2;
  const words = uniqWords(raw);
  for (const w of words) if (PT_WORDS.has(w)) s += 1;
  if (/\b(vc|q|pq|td|blz|obg|vlw|ta|tbm|kct)\b/i.test(raw)) s += 1;
  if (/[a-z]cao\b|[a-z]coes\b|[a-z]nh[oa]s?\b/i.test(raw)) s += 1;
  return s;
}

function enScore(text) {
  let s = 0;
  for (const w of uniqWords(text)) if (EN_STOPWORDS.has(w)) s += 1;
  return s;
}

function isProbablyPortuguese(text) {
  return ptScore(text) >= 1;
}

// Ingles/estrangeiro: so reprova quando o cliente escreveu em PT e a resposta
// nao tem nenhum sinal de portugues.
function looksForeign(reply, incoming) {
  const inc = String(incoming || '').trim();
  if (!inc) return false;
  if (!isProbablyPortuguese(inc)) return false;
  const rep = String(reply || '').trim();
  if (!rep) return false;
  if (ptScore(rep) >= 1) return false;
  const en = enScore(rep);
  return en >= 2;
}

function looksLikeJson(text) {
  const s = String(text || '').trim();
  if (!/^[\{\[]/.test(s)) return false;
  if (!/[\}\]]$/.test(s)) return false;
  try {
    const o = JSON.parse(s);
    return !!o && typeof o === 'object';
  } catch (_) {
    return /"\s*:\s*/.test(s) || /\btrue\b|\bfalse\b|\bnull\b/.test(s);
  }
}

function looksLikeCode(text) {
  const t = String(text || '');
  if (/```|~~~/.test(t)) return true;                       // bloco de codigo
  if (/`[^`]+`/.test(t)) return true;                       // codigo inline
  if (/<\/?[a-zA-Z][\w:-]*(\s[^<>]*)?\/?>/.test(t)) return true; // tag XML/HTML
  if (/\btool_call\b|\btool_use\b|\bfunction_call\b|"role"\s*:|<\|.*?\|>/i.test(t)) return true;
  if (/^\s*"[\w-]+"\s*:/m.test(t)) return true;             // linha "chave": valor
  // Palavra-chave so conta como codigo em contexto de codigo (evita "let me"
  // do ingles, "class" em texto, etc).
  if (/=>|console\.log\s*\(|\b(?:const|let|var|function)\s+[A-Za-z_$][\w$]*\s*[=(]/.test(t)) return true;
  if (/\b[a-z]{2,}_[a-z]{2,}\b/.test(t)) return true;       // identificador snake_case
  if (looksLikeJson(t)) return true;
  return false;
}

function looksLikeMarkdown(text) {
  const t = String(text || '');
  if (/^#{1,6}\s/m.test(t)) return true;                    // titulo
  if (/^\s{0,3}[-*+]\s+\S/m.test(t)) return true;           // lista
  if (/^\s{0,3}\d+[.)]\s+\S/m.test(t)) return true;         // lista numerada
  if (/\*\*[^*\n]+\*\*/.test(t)) return true;               // negrito
  if (/\[[^\]]+\]\([^)]+\)/.test(t)) return true;           // link markdown
  return false;
}

function looksGibberish(text) {
  // Ignora marcadores [..] (ex: [QUEBRA]) na medicao: eles somem antes do envio.
  const t = String(text || '').replace(/\[[^\]]*\]/g, '').trim();
  if (t.length >= 12) {
    const letters = (t.match(/[a-zA-ZÀ-ÿ0-9]/g) || []).length;
    if (letters / t.length < 0.45) return true;             // muitos simbolos
  }
  if (/[A-Za-z0-9+/]{60,}={0,2}/.test(t)) return true;      // blob base64
  for (const tok of t.split(/\s+/)) if (tok.length > 45) return true; // token gigante
  return false;
}

function bracketMarkers(text) {
  return String(text || '').match(ANY_BRACKET_RE) || [];
}

function hasLeftoverMarkers(text, allowKnown) {
  const markers = bracketMarkers(text);
  if (markers.length === 0) return false;
  if (!allowKnown) return true;
  return markers.some((m) => !KNOWN_MARKER_RE.test(m));
}

function isArtifact(text) {
  return ARTIFACT_PATTERNS.some((p) => p.test(text));
}

function isPromptLeak(text) {
  return PROMPT_LEAK_RE.test(text);
}

function isMeta(text) {
  return META_RE.test(text);
}

/**
 * Verifica se o texto pode ser enviado ao cliente.
 * @param {string} text
 * @param {{ incoming?: string, allowKnownMarkers?: boolean }} [opts]
 *   incoming: mensagem do cliente (usada so na checagem de idioma)
 *   allowKnownMarkers: true no texto CRU do modelo (permite [SEND_IMAGE]/[QUEBRA])
 * @returns {{ ok: boolean, reason: string|null }}
 */
function verifyMessage(text, opts = {}) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t || t.length < 2) return { ok: false, reason: 'empty' };
  if (t.length > 2000) return { ok: false, reason: 'too_long' };
  if (hasLeftoverMarkers(t, !!opts.allowKnownMarkers)) return { ok: false, reason: 'marker_leak' };
  if (isArtifact(t)) return { ok: false, reason: 'artifact' };
  if (isPromptLeak(t)) return { ok: false, reason: 'prompt_leak' };
  if (looksLikeCode(t)) return { ok: false, reason: 'code' };
  if (looksLikeMarkdown(t)) return { ok: false, reason: 'markdown' };
  if (isMeta(t)) return { ok: false, reason: 'meta' };
  if (looksForeign(t, opts.incoming)) return { ok: false, reason: 'foreign' };
  if (looksGibberish(t)) return { ok: false, reason: 'gibberish' };
  return { ok: true, reason: null };
}

// Instrucao enviada ao modelo quando a resposta e reprovada (autocorrecao).
function buildCorrectionPrompt(reason) {
  const mapa = {
    code: 'continha codigo/JSON/formato tecnico',
    markdown: 'continha formatacao (markdown, listas, titulos)',
    marker_leak: 'continha um marcador interno do sistema',
    prompt_leak: 'repetia as instrucoes do sistema',
    artifact: 'continha um texto de erro/sistema',
    foreign: 'estava em ingles',
    meta: 'falava sobre voce ser uma IA',
    gibberish: 'nao era uma frase legivel',
    too_long: 'era longa demais',
    empty: 'estava vazia'
  };
  const motivo = mapa[reason] || 'nao pode ser enviada';
  return `Sua ultima resposta ${motivo} e NAO pode ser enviada ao cliente. ` +
    'Escreva DE NOVO, agora somente a mensagem final para o cliente: ' +
    'em portugues do Brasil, texto simples de WhatsApp (sem codigo, sem JSON, ' +
    'sem markdown, sem listas e sem repetir instrucoes). Nao explique nada - ' +
    'escreva apenas a mensagem, como se fosse o proprio atendente.';
}

module.exports = {
  verifyMessage,
  buildCorrectionPrompt,
  isProbablyPortuguese,
  looksForeign,
  looksLikeCode,
  looksLikeMarkdown,
  looksGibberish,
  hasLeftoverMarkers,
  isArtifact,
  isPromptLeak,
  isMeta,
  ptScore,
  enScore
};
