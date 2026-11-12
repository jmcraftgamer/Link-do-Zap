// Plano de pagamento por Zap.
// - checkBillingActive mantem EXATAMENTE a regra que o app ja usava (portada
//   de main.js) para nao mudar o comportamento de quem ja tem billingPlan.
// - describeBilling e a versao "de API": devolve vencimento, carencia,
//   dias/horas restantes e status legivel para o Setup e o app mobile.
const DAY_MS = 24 * 60 * 60 * 1000;

function getBillingForZap(zap, now = new Date()) {
  if (!zap || !zap.billingPlan) return null;
  const monthKey = String(now.getMonth() + 1); // 1..12
  const payMonths = zap.billingPlan.paidMonths || {};
  return {
    dueDay: Number(zap.billingPlan.dueDay) || 1,
    graceDays: Number(zap.billingPlan.graceDays) || 0,
    payMonths,
    monthKey,
    now: now.toISOString(),
    ...zap.billingPlan
  };
}

// Regra de cobranca: pago = ativo. Nao pago = ativo ate o vencimento, ativo
// durante a carencia e suspenso depois dela.
function checkBillingActive(zap, now = new Date()) {
  const bp = getBillingForZap(zap, now);
  if (!bp) return { active: true, reason: 'no_plan', todayKey: null, currentDue: null };
  if (bp.disabledForOwnUse === true) return { active: true, reason: 'own_use', todayKey: null, currentDue: null };
  const mk = bp.monthKey || String(now.getMonth() + 1);
  const dueDay = Number(bp.dueDay) || 1;
  const graceDays = Number(bp.graceDays) || 0;
  const dueDate = new Date(now.getFullYear(), now.getMonth(), dueDay);
  const graceEnd = new Date(dueDate.getTime() + graceDays * DAY_MS);
  const paid = !!(bp.paidMonths && (bp.paidMonths[mk] || bp.paidMonths[monthKeyOf(now)]));

  if (paid) {
    return { active: true, reason: 'pago', todayKey: mk, currentDue: dueDay, dueDate: dateKey(dueDate), graceEndsAt: dateKey(graceEnd) };
  }
  if (now < dueDate) {
    return { active: true, reason: 'no_vencimento', todayKey: mk, currentDue: dueDay, dueDate: dateKey(dueDate), graceEndsAt: dateKey(graceEnd) };
  }
  if (now <= graceEnd) {
    return { active: true, reason: 'carencia', todayKey: mk, currentDue: dueDay, dueDate: dateKey(dueDate), graceEndsAt: dateKey(graceEnd) };
  }
  return { active: false, reason: 'atrasado', todayKey: mk, currentDue: dueDay, dueDate: dateKey(dueDate), graceEndsAt: dateKey(graceEnd) };
}

function pad2(n) { return String(n).padStart(2, '0'); }
function dateKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

function monthKeyOf(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; }

// Status detalhado para API/dashboard.
function describeBilling(zap, now = new Date()) {
  const plan = zap && zap.billingPlan ? zap.billingPlan : null;
  if (!plan) {
    return {
      status: 'no_plan',
      active: true,
      reason: 'no_plan',
      dueDay: null,
      dueDate: null,
      graceEndsAt: null,
      nextDueDate: null,
      daysRemaining: null,
      hoursRemaining: null,
      monthlyAmount: null,
      paidMonths: {}
    };
  }
  if (plan.disabledForOwnUse === true) {
    return {
      status: 'own_use',
      active: true,
      reason: 'own_use',
      dueDay: Number(plan.dueDay) || 1,
      dueDate: null,
      graceEndsAt: null,
      nextDueDate: null,
      daysRemaining: null,
      hoursRemaining: null,
      monthlyAmount: plan.monthlyAmount || null,
      paidMonths: plan.paidMonths || {}
    };
  }

  const dueDay = Number(plan.dueDay) || 1;
  const graceDays = Number(plan.graceDays) || 0;
  const paidMonths = plan.paidMonths || {};
  const currentMonth = monthKeyOf(now);
  const currentDue = new Date(now.getFullYear(), now.getMonth(), dueDay);
  const graceEnd = new Date(currentDue.getTime() + graceDays * DAY_MS);
  const nextDue = new Date(now.getFullYear(), now.getMonth() + 1, dueDay);
  const paid = !!paidMonths[currentMonth] || !!paidMonths[String(now.getMonth() + 1)];

  const gate = checkBillingActive(zap, now);
  let status;
  if (paid) status = 'paid';
  else if (!gate.active) status = 'overdue';
  else if (now < currentDue) status = 'pending';
  else status = 'grace';

  const remainingMs = Math.max(0, graceEnd.getTime() - now.getTime());
  return {
    status,
    active: gate.active,
    reason: gate.reason,
    dueDay,
    dueDate: dateKey(currentDue),
    graceDays,
    graceEndsAt: dateKey(graceEnd),
    nextDueDate: dateKey(nextDue),
    daysRemaining: paid ? null : Math.ceil(remainingMs / DAY_MS),
    hoursRemaining: paid ? null : Math.ceil(remainingMs / (60 * 60 * 1000)),
    monthlyAmount: plan.monthlyAmount || null,
    paidMonths
  };
}

// Marca um mes como pago. Aceita "2026-11" (recomendado) ou 11 (legado).
function markMonthPaid(plan, month, paid = true) {
  const target = plan && typeof plan === 'object' ? plan : {};
  if (!target.paidMonths || typeof target.paidMonths !== 'object') target.paidMonths = {};
  const raw = String(month == null ? '' : month).trim();
  if (!raw) return target;
  if (/^\d{4}-\d{2}$/.test(raw)) {
    const m = Number(raw.slice(5, 7));
    if (paid) target.paidMonths[m] = true;
    else delete target.paidMonths[m];
    if (paid) target.paidMonths[raw] = true;
    else delete target.paidMonths[raw];
  } else {
    const m = Number(raw);
    if (!Number.isFinite(m) || m < 1 || m > 12) return target;
    if (paid) target.paidMonths[m] = true;
    else delete target.paidMonths[m];
  }
  return target;
}

module.exports = {
  DAY_MS,
  getBillingForZap,
  checkBillingActive,
  describeBilling,
  markMonthPaid,
  monthKeyOf
};
