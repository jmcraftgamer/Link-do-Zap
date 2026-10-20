'use strict';

// Horario de atendimento por Zap.
// workHours = { enabled: bool, start: 'HH:MM', end: 'HH:MM', days: [0..6] }
//   days: 0=domingo .. 6=sabado. Vazio/ausente = todos os dias.
// Suporta janela que vira o dia (ex: 22:00 -> 06:00).

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function isWithinWorkHours(wh, when) {
  if (!wh || wh.enabled !== true) return true; // sem horario definido = responde sempre
  const date = when ? new Date(when) : new Date();
  const start = parseHHMM(wh.start);
  const end = parseHHMM(wh.end);
  if (start === null || end === null) return true; // mal configurado: nao bloqueia

  const days = Array.isArray(wh.days) ? wh.days.map(Number).filter(n => n >= 0 && n <= 6) : [];
  if (days.length && !days.includes(date.getDay())) return false;

  const now = date.getHours() * 60 + date.getMinutes();
  if (start === end) return true; // janela de 24h
  if (start < end) return now >= start && now < end;
  return now >= start || now < end; // vira o dia
}

module.exports = { isWithinWorkHours, parseHHMM };
