'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAYMENT_DAYS_BEFORE = 5;

function pad2(value) { return String(value).padStart(2, '0'); }
function monthKeyOf(date) { return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`; }
function dateKey(date) { return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`; }
function isoDate(date) { return date.toISOString(); }

function isValidPeriod(value) {
  const raw = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})$/.exec(raw);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return year >= 2000 && year <= 2100 && month >= 1 && month <= 12;
}

function periodDate(period, dueDay) {
  const [year, month] = String(period).split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return new Date(year, month - 1, Math.min(Math.max(1, dueDay), lastDay), 0, 0, 0, 0);
}

function addMonths(period, amount) {
  const [year, month] = String(period).split('-').map(Number);
  const date = new Date(year, month - 1 + amount, 1);
  return monthKeyOf(date);
}

function periodSequence(start, end) {
  if (!isValidPeriod(start) || !isValidPeriod(end)) return [];
  const out = [];
  let current = start;
  for (let i = 0; i < 240 && current <= end; i++) {
    out.push(current);
    current = addMonths(current, 1);
  }
  return out;
}

function subscriptionEnabled(plan) {
  return !!(plan && plan.enabled !== false && plan.disabledForOwnUse !== true);
}

function normalizePlan(plan, now) {
  const source = plan && typeof plan === 'object' ? plan : {};
  const dueDay = Number.isInteger(Number(source.dueDay)) && Number(source.dueDay) >= 1 && Number(source.dueDay) <= 31
    ? Number(source.dueDay) : now.getDate();
  const graceDays = Number.isInteger(Number(source.graceDays)) && Number(source.graceDays) >= 0 && Number(source.graceDays) <= 365
    ? Number(source.graceDays) : 3;
  return {
    ...source,
    enabled: subscriptionEnabled(source),
    dueDay,
    graceDays,
    startMonth: isValidPeriod(source.startMonth) ? source.startMonth : monthKeyOf(now),
    monthlyAmount: Math.max(0, Number(source.monthlyAmount == null ? 349 : source.monthlyAmount) || 0),
    currency: String(source.currency || 'BRL').toUpperCase().slice(0, 3)
  };
}

function resolveBillingPlan(zap, now = new Date()) {
  if (!zap) return null;
  const source = zap.billingPlan && typeof zap.billingPlan === 'object' ? zap.billingPlan : {};
  const defaults = billingDefaultsForZap(zap, now);
  const legacyDefaults = source.dueDay === 1
    && source.graceDays === 15
    && Number(source.monthlyAmount) === 0
    && !source.startedAt
    && !source.updatedAt
    && !source.paidMonths;
  const plan = { ...defaults, ...source };
  if (legacyDefaults) {
    plan.dueDay = defaults.dueDay;
    plan.graceDays = defaults.graceDays;
    plan.monthlyAmount = defaults.monthlyAmount;
  }
  return normalizePlan(plan, now);
}

function getBillingForZap(zap, now = new Date()) {
  const plan = resolveBillingPlan(zap, now);
  if (!plan) return null;
  return {
    ...plan,
    monthKey: monthKeyOf(now),
    payMonths: plan.paidMonths && typeof plan.paidMonths === 'object' ? plan.paidMonths : {},
    now: now.toISOString()
  };
}

function paidPeriodsOf(zapId, plan, ledger) {
  const paid = new Set();
  for (const [key, value] of Object.entries(plan.paidMonths || {})) {
    if (isValidPeriod(key) && (value === true || (value && value.paidAt))) paid.add(key);
  }
  for (const payment of (ledger && ledger.payments) || []) {
    if (payment && String(payment.zapId) === String(zapId) && payment.period && isValidPeriod(payment.period)) paid.add(payment.period);
  }
  return paid;
}

function effectiveGraceEndsAt(period, originalGraceEndsAt, ledger, zapId) {
  let effective = originalGraceEndsAt.getTime();
  for (const extension of (ledger && ledger.extensions) || []) {
    if (!extension || extension.zapId !== zapId || extension.period !== period) continue;
    const time = Date.parse(extension.newGraceEndsAt);
    if (Number.isFinite(time)) effective = Math.max(effective, time);
  }
  return new Date(effective);
}

function emptyBilling(status, reason, plan, ledger, now, zapId) {
  return {
    status,
    active: true,
    reason,
    enabled: false,
    todayKey: monthKeyOf(now),
    currentPeriod: monthKeyOf(now),
    dueDay: plan ? plan.dueDay : null,
    dueDate: null,
    graceDays: plan ? plan.graceDays : null,
    graceEndsAt: null,
    nextDueDate: null,
    daysRemaining: null,
    hoursRemaining: null,
    monthlyAmount: plan ? plan.monthlyAmount : null,
    currency: plan ? plan.currency : 'BRL',
    startMonth: plan ? plan.startMonth : null,
    paidMonths: {},
    invoices: [],
    dueMonths: [],
    overdueMonths: [],
    arrearsCount: 0,
    arrearsAmountCents: 0,
    oldestUnpaidPeriod: null,
    payments: ((ledger && ledger.payments) || []).filter((payment) => payment.zapId === zapId).sort((a, b) => Date.parse(b.paidAt) - Date.parse(a.paidAt)),
    extensions: []
  };
}

function describeBilling(zap, now = new Date(), ledger = {}) {
  const zapId = String(zap && zap.id != null ? zap.id : '');
  const plan = getBillingForZap(zap, now);
  if (!plan) return emptyBilling('no_plan', 'no_plan', null, ledger, now, zapId);
  if (!subscriptionEnabled(plan)) return emptyBilling('own_use', 'own_use', plan, ledger, now, zapId);
  const paid = paidPeriodsOf(zapId, plan, ledger);
  const currentPeriod = monthKeyOf(now);
  const periods = periodSequence(plan.startMonth, addMonths(currentPeriod, 1));
  const invoices = periods.map((period) => {
    const dueAt = periodDate(period, plan.dueDay);
    const paymentOpensAt = new Date(dueAt.getTime() - PAYMENT_DAYS_BEFORE * DAY_MS);
    const originalGraceEndsAt = new Date(dueAt.getTime() + plan.graceDays * DAY_MS);
    const graceEndsAt = effectiveGraceEndsAt(period, originalGraceEndsAt, ledger, zapId);
    const isPaid = paid.has(period);
    const status = isPaid ? 'paid' : now < dueAt ? 'pending' : now < graceEndsAt ? 'grace' : 'overdue';
    const extensions = ((ledger && ledger.extensions) || [])
      .filter((extension) => extension && extension.zapId === zapId && extension.period === period)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return {
      id: `${zapId}:${period}`,
      zapId,
      period,
      dueAt: isoDate(dueAt),
      dueDate: dateKey(dueAt),
      paymentOpensAt: isoDate(paymentOpensAt),
      originalGraceEndsAt: isoDate(originalGraceEndsAt),
      graceEndsAt: isoDate(graceEndsAt),
      amountCents: Math.round(plan.monthlyAmount * 100),
      amount: plan.monthlyAmount,
      currency: plan.currency,
      status,
      paid: isPaid,
      payable: !isPaid && now >= paymentOpensAt,
      daysOverdue: status === 'overdue' ? Math.max(0, Math.floor((now.getTime() - graceEndsAt.getTime()) / DAY_MS)) : 0,
      extensions
    };
  });

  const currentInvoice = invoices.find((invoice) => invoice.period === currentPeriod) || null;
  const dueMonths = invoices.filter((invoice) => invoice.payable);
  const overdueMonths = invoices.filter((invoice) => invoice.status === 'overdue');
  const oldestUnpaid = dueMonths[0] || null;
  const status = overdueMonths.length
    ? 'overdue'
    : invoices.some((invoice) => invoice.period <= currentPeriod && invoice.status === 'grace')
      ? 'grace'
      : !currentInvoice || currentInvoice.status === 'pending'
        ? 'pending'
        : 'paid';
  const active = status !== 'overdue';
  const reason = status === 'overdue' ? 'atrasado' : status === 'grace' ? 'carencia' : status === 'pending' ? 'no_vencimento' : 'pago';
  const nextPending = invoices.find((invoice) => !invoice.paid) || null;
  const nextDueDate = nextPending
    ? nextPending.dueDate
    : plan.startMonth > currentPeriod
      ? dateKey(periodDate(plan.startMonth, plan.dueDay))
      : dateKey(periodDate(addMonths(currentPeriod, 1), plan.dueDay));
  const remainingMs = oldestUnpaid ? Math.max(0, Date.parse(oldestUnpaid.graceEndsAt) - now.getTime()) : 0;
  const payments = ((ledger && ledger.payments) || [])
    .filter((payment) => payment && payment.zapId === zapId)
    .sort((a, b) => Date.parse(b.paidAt) - Date.parse(a.paidAt));
  const extensions = ((ledger && ledger.extensions) || [])
    .filter((extension) => extension && extension.zapId === zapId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return {
    status,
    active,
    reason,
    enabled: true,
    todayKey: currentPeriod,
    currentPeriod,
    dueDay: plan.dueDay,
    dueDate: currentInvoice ? currentInvoice.dueDate : nextDueDate,
    graceDays: plan.graceDays,
    graceEndsAt: oldestUnpaid ? oldestUnpaid.graceEndsAt : currentInvoice ? currentInvoice.graceEndsAt : null,
    nextDueDate,
    daysRemaining: oldestUnpaid ? Math.ceil(remainingMs / DAY_MS) : null,
    hoursRemaining: oldestUnpaid ? Math.ceil(remainingMs / (60 * 60 * 1000)) : null,
    monthlyAmount: plan.monthlyAmount,
    currency: plan.currency,
    startMonth: plan.startMonth,
    paidMonths: Object.fromEntries([...paid].map((period) => [period, true])),
    invoices,
    dueMonths,
    overdueMonths,
    arrearsCount: dueMonths.length,
    arrearsAmountCents: dueMonths.reduce((total, invoice) => total + invoice.amountCents, 0),
    oldestUnpaidPeriod: oldestUnpaid ? oldestUnpaid.period : null,
    payments,
    extensions
  };
}

function checkBillingActive(zap, now = new Date(), ledger = {}) {
  const detail = describeBilling(zap, now, ledger);
  return {
    active: detail.active,
    reason: detail.reason,
    status: detail.status,
    todayKey: detail.todayKey,
    currentDue: detail.currentPeriod,
    dueDate: detail.dueDate,
    graceEndsAt: detail.graceEndsAt,
    oldestUnpaidPeriod: detail.oldestUnpaidPeriod,
    arrearsCount: detail.arrearsCount
  };
}

function billingDefaultsForZap(zap, now = new Date()) {
  const candidates = [zap && zap.createdAtISO, zap && zap.createdAt, zap && zap.id];
  let createdAt = null;
  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue;
    const raw = String(candidate).trim();
    if (/^\d{13}$/.test(raw)) {
      createdAt = new Date(Number(raw));
      break;
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      createdAt = new Date(parsed);
      break;
    }
  }
  if (!createdAt || Number.isNaN(createdAt.getTime())) createdAt = new Date(now);
  return {
    dueDay: createdAt.getDate(),
    graceDays: 3,
    monthlyAmount: 349,
    currency: 'BRL',
    startMonth: monthKeyOf(createdAt)
  };
}

function normalizeBillingConfig(input, existing, now = new Date()) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const base = existing && typeof existing === 'object' ? existing : {};
  const enabled = source.enabled != null ? source.enabled === true : base.enabled == null ? true : subscriptionEnabled(base);
  if (source.enabled === false) {
    return {
      ...base,
      enabled: false,
      disabledForOwnUse: true,
      updatedAt: now.toISOString()
    };
  }
  const dueDay = source.dueDay != null ? Number(source.dueDay) : Number(base.dueDay == null ? now.getDate() : base.dueDay);
  const graceDays = source.graceDays != null ? Number(source.graceDays) : Number(base.graceDays == null ? 3 : base.graceDays);
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) throw new Error('o dia de vencimento deve estar entre 1 e 31');
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 365) throw new Error('a carencia deve estar entre 0 e 365 dias');
  const monthlyAmount = source.monthlyAmount != null ? Number(source.monthlyAmount) : Number(base.monthlyAmount == null ? 349 : base.monthlyAmount);
  if (!Number.isFinite(monthlyAmount) || monthlyAmount < 0) throw new Error('o valor mensal e invalido');
  const currency = String(source.currency || base.currency || 'BRL').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('moeda invalida');
  const startMonth = source.startMonth != null ? source.startMonth : (base.startMonth || monthKeyOf(now));
  if (!isValidPeriod(startMonth)) throw new Error('mes inicial invalido');
  return {
    ...base,
    enabled,
    disabledForOwnUse: !enabled,
    dueDay,
    graceDays,
    monthlyAmount: Math.round(monthlyAmount * 100) / 100,
    currency,
    startMonth: String(startMonth).trim(),
    startedAt: base.startedAt || now.toISOString(),
    updatedAt: now.toISOString()
  };
}

function markMonthPaid(plan, month, paid = true, now = new Date()) {
  const target = plan && typeof plan === 'object' ? plan : {};
  if (!target.paidMonths || typeof target.paidMonths !== 'object') target.paidMonths = {};
  let period = String(month == null ? '' : month).trim();
  if (/^\d{1,2}$/.test(period)) period = `${now.getFullYear()}-${pad2(Number(period))}`;
  if (!isValidPeriod(period)) return target;
  if (paid) target.paidMonths[period] = true;
  else delete target.paidMonths[period];
  return target;
}

module.exports = {
  DAY_MS,
  PAYMENT_DAYS_BEFORE,
  getBillingForZap,
  resolveBillingPlan,
  checkBillingActive,
  describeBilling,
  markMonthPaid,
  normalizeBillingConfig,
  billingDefaultsForZap,
  monthKeyOf,
  dateKey,
  isValidPeriod,
  periodDate,
  addMonths
};
