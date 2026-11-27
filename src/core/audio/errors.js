'use strict';

// Classificacao de falhas do processamento de audio.
//
// O objetivo e decidir, sem adivinhacao, se vale a pena tentar de novo:
// - transient: rede/servidor instavel, tenta com backoff
// - expired:   URL/mediaKey vencida, vale renovar os metadados e tentar
// - corrupt:   bytes invalidos, vale pedir uma copia nova
// - auth:      chave/credencial invalida, repetir nao resolve
// - permanent: dado ausente/invalido que nao muda sozinho
// - limit:     arquivo grande/pequeno demais
// - unknown:   trata como transitorio limitado (melhor esforco)

const PATTERNS = [
  { kind: 'auth', retryable: false, re: /HTTP\s*40[13]|unauthorized|forbidden|invalid api key|chave invalida|token invalido/i },
  { kind: 'expired', retryable: true, refresh: true, re: /reupload|expirad|mediaKey ausente|URL de midia ausente|HTTP\s*40[4]|HTTP\s*410|stale|nomedia|sem mediaData|midia indisponivel/i },
  { kind: 'timeout', retryable: true, re: /timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT|AbortError|abort/i },
  { kind: 'transient', retryable: true, re: /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|fetch failed|HTTP\s*5\d\d|HTTP\s*429|resposta vazia|empty|vazi[ao]/i },
  { kind: 'corrupt', retryable: true, re: /assinatura da midia nao confere|decrypt|descriptograf|corromp|Unexpected mimetype|formato|mime|header|bytes/i },
  { kind: 'limit', retryable: false, re: /grande demais|maior que o limite|muito grande|too large|size limit|pequeno demais|too small/i },
  { kind: 'permanent', retryable: false, re: /ReferenceError|SyntaxError|is not defined|is not a function/i },
  { kind: 'permanent', retryable: false, re: /nao encontrada|mensagem nao encontrada|not found|fetch indisponivel|nenhuma URL|sem midia|sem permissao|permission denied/i }
];

function errorText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  const parts = [error.message, error.code, error.name].filter(Boolean);
  return parts.join(' ').replace(/https?:\/\/[^\s|]+/gi, '[url]');
}

// Devolve sempre um objeto com a mesma forma, para o chamador nao precisar
// repetir a classificacao em cada ponto do fluxo.
function classifyAudioError(error) {
  const text = errorText(error);
  for (const rule of PATTERNS) {
    if (rule.re.test(text)) {
      return { kind: rule.kind, retryable: !!rule.retryable, refresh: !!rule.refresh, text };
    }
  }
  return { kind: 'unknown', retryable: true, refresh: false, text };
}

module.exports = { classifyAudioError, errorText };
