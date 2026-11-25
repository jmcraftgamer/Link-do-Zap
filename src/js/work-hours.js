'use strict';

// Horario de atendimento por Zap.
// workHours = { enabled: bool, start: 'HH:MM', end: 'HH:MM', days: [0..6], tz: 'America/Sao_Paulo' }
//   days: 0=domingo .. 6=sabado. Vazio/ausente = todos os dias.
//   tz:   fuso IANA gravado pelo painel (o servidor roda em UTC, entao o
//          horario e calculado NESTE fuso). Ausente/invalido = hora do sistema.
// Suporta janela que vira o dia (ex: 22:00 -> 06:00).

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Dia da semana e minutos do dia no fuso pedido (fallback: hora do sistema).
function partsInZone(date, tz) {
  if (!tz) return { day: date.getDay(), minutes: date.getHours() * 60 + date.getMinutes() };
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      weekday: 'short', hour: '2-digit', minute: '2-digit'
    });
    const found = {};
    for (const p of fmt.formatToParts(date)) found[p.type] = p.value;
    const day = WEEKDAY[found.weekday];
    let hh = parseInt(found.hour, 10);
    if (hh === 24) hh = 0; // alguns ambientes devolvem 24 em vez de 00
    const mi = parseInt(found.minute, 10);
    if (day === undefined || isNaN(hh) || isNaN(mi)) throw new Error('parts');
    return { day, minutes: hh * 60 + mi };
  } catch (_) {
    return { day: date.getDay(), minutes: date.getHours() * 60 + date.getMinutes() };
  }
}

function isWithinWorkHours(wh, when) {
  if (!wh || wh.enabled !== true) return true; // sem horario definido = responde sempre
  const date = when ? new Date(when) : new Date();
  const start = parseHHMM(wh.start);
  const end = parseHHMM(wh.end);
  if (start === null || end === null) return true; // mal configurado: nao bloqueia

  const { day, minutes } = partsInZone(date, wh.tz);

  const days = Array.isArray(wh.days) ? wh.days.map(Number).filter(n => n >= 0 && n <= 6) : [];
  const dayAllowed = days.length === 0 || days.includes(day);
  const previousDay = (day + 6) % 7;

  if (start === end) return dayAllowed;
  if (start < end) return dayAllowed && minutes >= start && minutes < end;
  const afterStart = dayAllowed && minutes >= start;
  const beforeEnd = (days.length === 0 || days.includes(previousDay)) && minutes < end;
  return afterStart || beforeEnd;
}

module.exports = { isWithinWorkHours, parseHHMM, partsInZone };
