'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const billing = require(path.join(root, 'src', 'core', 'billing'));
const { BillingStore } = require(path.join(root, 'src', 'core', 'billing-store'));
const WhatsAppManager = require(path.join(root, 'src', 'js', 'whatsapp-manager'));

const signature = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=';
const silentLogger = { error() {} };
let passed = 0;
const failures = [];
const pendingAsync = [];

function testAsync(name, fn) {
  pendingAsync.push({ name, fn });
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, error: error.message });
    console.log(`FAIL - ${name}`);
    console.log(`      ${error.message}`);
  }
}

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zap-billing-'));
  return { dir, store: new BillingStore({ filePath: path.join(dir, 'billing-ledger.json'), logger: silentLogger }) };
}

function plan(overrides = {}) {
  return {
    enabled: true,
    dueDay: 10,
    graceDays: 15,
    monthlyAmount: 50,
    currency: 'BRL',
    startMonth: '2026-09',
    ...overrides
  };
}

test('billing: periodo valido e vencimento clampado no ultimo dia do mes', () => {
  assert.strictEqual(billing.isValidPeriod('2026-11'), true);
  assert.strictEqual(billing.isValidPeriod('2026-13'), false);
  assert.strictEqual(billing.isValidPeriod('2026-1'), false);
  assert.strictEqual(billing.isValidPeriod('11'), false);
  assert.strictEqual(billing.dateKey(billing.periodDate('2026-02', 31)), '2026-02-28');
  assert.strictEqual(billing.dateKey(billing.periodDate('2024-02', 31)), '2024-02-29');
  assert.strictEqual(billing.addMonths('2026-12', 1), '2027-01');
});

test('billing: configuracao normaliza defaults e rejeita valores invalidos', () => {
  const now = new Date('2026-11-26T12:00:00');
  const normalized = billing.normalizeBillingConfig({ enabled: true }, {}, now);
  assert.strictEqual(normalized.dueDay, 26);
  assert.strictEqual(normalized.graceDays, 3);
  assert.strictEqual(normalized.monthlyAmount, 349);
  assert.strictEqual(normalized.startMonth, '2026-11');
  assert.strictEqual(normalized.disabledForOwnUse, false);
  assert.strictEqual(billing.normalizeBillingConfig({}, {}, now).enabled, true);
  assert.throws(() => billing.normalizeBillingConfig({ enabled: true, dueDay: 32 }, normalized, now), /vencimento/);
  assert.throws(() => billing.normalizeBillingConfig({ enabled: true, graceDays: -1 }, normalized, now), /carencia/);
  assert.throws(() => billing.normalizeBillingConfig({ enabled: true, monthlyAmount: -1 }, normalized, now), /valor/);
  assert.throws(() => billing.normalizeBillingConfig({ enabled: true, startMonth: '2026-99' }, normalized, now), /inicial/);
  const disabled = billing.normalizeBillingConfig({ enabled: false }, { enabled: true, dueDay: 99, startMonth: 'invalido' }, now);
  assert.strictEqual(disabled.enabled, false);
  assert.strictEqual(disabled.disabledForOwnUse, true);
});

test('billing: primeira fatura usa o dia de criacao, valor 349 e carencia de 3 dias', () => {
  const createdAt = new Date('2026-02-15T10:00:00');
  const defaults = billing.billingDefaultsForZap({ id: 'z1', createdAt: createdAt.toISOString() }, new Date('2026-03-01T12:00:00'));
  assert.strictEqual(defaults.dueDay, 15);
  assert.strictEqual(defaults.graceDays, 3);
  assert.strictEqual(defaults.monthlyAmount, 349);
  assert.strictEqual(defaults.startMonth, '2026-02');
  const detail = billing.describeBilling({ id: 'z1', billingPlan: { enabled: true, ...defaults } }, new Date('2026-02-15T12:00:00'), {});
  const first = detail.invoices.find((invoice) => invoice.period === '2026-02');
  const next = detail.invoices.find((invoice) => invoice.period === '2026-03');
  assert.strictEqual(first.dueDate, '2026-02-15');
  assert.strictEqual(first.payable, true);
  assert.strictEqual(first.status, 'grace');
  assert.strictEqual(next.dueDate, '2026-03-15');
  assert.strictEqual(next.payable, false);
});

test('billing: Zap sem plano ja nasce com assinatura ativa e primeira fatura', () => {
  const createdAt = new Date(2026, 10, 2, 10, 0, 0);
  const detail = billing.describeBilling({ id: createdAt.getTime(), createdAt: createdAt.toISOString() }, new Date(2026, 10, 2, 12, 0, 0), {});
  assert.strictEqual(detail.enabled, true);
  assert.strictEqual(detail.monthlyAmount, 349);
  assert.strictEqual(detail.graceDays, 3);
  assert.strictEqual(detail.invoices[0].period, '2026-11');
  assert.strictEqual(detail.invoices[0].dueDate, '2026-11-02');
  assert.strictEqual(detail.invoices[0].payable, true);
  assert.strictEqual(detail.invoices[1].period, '2026-12');
  assert.strictEqual(detail.invoices[1].dueDate, '2026-12-02');
});

test('billing: plano legado com defaults antigos migra sem alterar plano personalizado', () => {
  const createdAt = new Date(2026, 1, 15, 10, 0, 0);
  const zap = {
    id: createdAt.getTime(),
    billingPlan: { enabled: true, dueDay: 1, graceDays: 15, monthlyAmount: 0, currency: 'BRL', startMonth: '2026-02' }
  };
  const migrated = billing.resolveBillingPlan(zap, new Date('2026-03-01T12:00:00'));
  assert.strictEqual(migrated.dueDay, 15);
  assert.strictEqual(migrated.graceDays, 3);
  assert.strictEqual(migrated.monthlyAmount, 349);
  assert.strictEqual(migrated.startMonth, '2026-02');

  const custom = billing.resolveBillingPlan({
    ...zap,
    billingPlan: { ...zap.billingPlan, monthlyAmount: 99, updatedAt: '2026-02-15T10:00:00.000Z' }
  }, new Date('2026-03-01T12:00:00'));
  assert.strictEqual(custom.dueDay, 1);
  assert.strictEqual(custom.graceDays, 15);
  assert.strictEqual(custom.monthlyAmount, 99);
});

test('billing: marca mes pago sempre com ano e ignora periodo invalido', () => {
  const now = new Date('2026-11-26T12:00:00');
  const target = plan();
  billing.markMonthPaid(target, '11', true, now);
  assert.strictEqual(target.paidMonths['2026-11'], true);
  assert.strictEqual(target.paidMonths['11'], undefined);
  billing.markMonthPaid(target, '2026-99', true, now);
  assert.strictEqual(target.paidMonths['2026-99'], undefined);
});

test('billing: faturas atrasadas acumulam e suspensao ocorre apos qualquer carencia', () => {
  const now = new Date('2026-11-20T12:00:00');
  const detail = billing.describeBilling({ id: 'z1', billingPlan: plan() }, now, { payments: [], extensions: [] });
  assert.strictEqual(detail.invoices.length, 4);
  assert.deepStrictEqual(detail.invoices.map((invoice) => invoice.status), ['overdue', 'overdue', 'grace', 'pending']);
  assert.strictEqual(detail.arrearsCount, 3);
  assert.strictEqual(detail.arrearsAmountCents, 15000);
  assert.strictEqual(detail.overdueMonths.length, 2);
  assert.strictEqual(detail.active, false);
  assert.strictEqual(detail.reason, 'atrasado');
  assert.strictEqual(detail.oldestUnpaidPeriod, '2026-09');
});

test('billing: pagamento de um Zap nao quita a fatura de outro', () => {
  const now = new Date('2026-11-20T12:00:00');
  const ledger = { payments: [{ zapId: 'z1', period: '2026-10', paidAt: '2026-10-02T12:00:00.000Z' }], extensions: [] };
  const first = billing.describeBilling({ id: 'z1', billingPlan: plan() }, now, ledger);
  const second = billing.describeBilling({ id: 'z2', billingPlan: plan() }, now, ledger);
  assert.strictEqual(first.invoices.find((invoice) => invoice.period === '2026-10').paid, true);
  assert.strictEqual(second.invoices.find((invoice) => invoice.period === '2026-10').paid, false);
  assert.strictEqual(first.paidMonths['2026-10'], true);
  assert.strictEqual(second.paidMonths['2026-10'], undefined);
  assert.strictEqual(second.payments.length, 0);
});

test('billing: fatura futura aparece e pagamento abre 5 dias antes do vencimento', () => {
  const planInput = plan({ startMonth: '2026-11', dueDay: 30 });
  const before = billing.describeBilling({ id: 'z1', billingPlan: planInput }, new Date('2026-11-24T23:59:59'), {});
  const invoiceBefore = before.invoices.find((invoice) => invoice.period === '2026-11');
  assert.strictEqual(invoiceBefore.status, 'pending');
  assert.strictEqual(invoiceBefore.payable, false);
  assert.strictEqual(Date.parse(invoiceBefore.paymentOpensAt), new Date(2026, 10, 25).getTime());

  const after = billing.describeBilling({ id: 'z1', billingPlan: planInput }, new Date('2026-11-25T00:00:00'), {});
  const invoiceAfter = after.invoices.find((invoice) => invoice.period === '2026-11');
  assert.strictEqual(invoiceAfter.status, 'pending');
  assert.strictEqual(invoiceAfter.payable, true);
  assert.strictEqual(after.invoices.some((invoice) => invoice.period === '2026-12'), true);
});

test('billing: fatura do mes seguinte nao torna a assinatura atual pendente', () => {
  const now = new Date('2026-11-20T12:00:00');
  const ledger = { payments: [{ zapId: 'z1', period: '2026-11', paidAt: '2026-11-02T12:00:00.000Z' }], extensions: [] };
  const detail = billing.describeBilling({ id: 'z1', billingPlan: plan({ startMonth: '2026-11' }) }, now, ledger);
  assert.strictEqual(detail.status, 'paid');
  assert.strictEqual(detail.invoices.find((invoice) => invoice.period === '2026-12').status, 'pending');
});

test('billing: prorrogacao e pagamentos individuais regularizam sem apagar historico', () => {
  const { store } = makeStore();
  const now = new Date('2026-11-20T12:00:00');
  const zap = { id: 'z1', billingPlan: plan() };
  const before = billing.describeBilling(zap, now, store.snapshot());
  const september = before.invoices.find((invoice) => invoice.period === '2026-09');
  store.appendExtension({
    zapId: 'z1',
    period: '2026-09',
    days: 70,
    previousGraceEndsAt: september.graceEndsAt,
    newGraceEndsAt: new Date(Date.parse(september.graceEndsAt) + 70 * billing.DAY_MS).toISOString(),
    reason: 'acordo'
  });
  store.appendPayment({ zapId: 'z1', period: '2026-10', amountCents: 5000, currency: 'BRL', signature });
  const middle = billing.describeBilling(zap, now, store.snapshot());
  assert.strictEqual(middle.active, true);
  assert.strictEqual(middle.status, 'grace');
  assert.strictEqual(middle.overdueMonths.length, 0);
  assert.strictEqual(middle.arrearsCount, 2);
  assert.strictEqual(middle.invoices.find((invoice) => invoice.period === '2026-10').paid, true);
  assert.strictEqual(middle.invoices.find((invoice) => invoice.period === '2026-09').paid, false);

  store.appendPayment({ zapId: 'z1', period: '2026-09', amountCents: 5000, currency: 'BRL', signature });
  store.appendPayment({ zapId: 'z1', period: '2026-11', amountCents: 5000, currency: 'BRL', signature });
  const after = billing.describeBilling(zap, now, store.snapshot());
  assert.strictEqual(after.status, 'paid');
  assert.strictEqual(after.active, true);
  assert.strictEqual(after.arrearsCount, 0);
  assert.strictEqual(after.payments.length, 3);
  assert.ok(after.payments.every((payment) => payment.signature === signature));
  assert.strictEqual(after.extensions.length, 1);
});

test('billing: pagamento e idempotente e assinatura invalida e rejeitada', () => {
  const { store, dir } = makeStore();
  const first = store.appendPayment({ zapId: 'z1', period: '2026-10', amountCents: 5000, currency: 'BRL', signature });
  const second = store.appendPayment({ zapId: 'z1', period: '2026-10', amountCents: 5000, currency: 'BRL', signature });
  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(second.duplicate, true);
  assert.strictEqual(store.paymentsFor('z1').length, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'billing-ledger.json'), 'utf8')).payments.length, 1);
  assert.throws(() => store.appendPayment({ zapId: 'z1', period: '2026-09', amountCents: 5000, signature: 'data:image/png;base64,bm90LXBuZw==' }), /assinatura invalida/);
  assert.throws(() => store.appendExtension({ zapId: 'z1', period: '2026-09', days: 0, previousGraceEndsAt: '2026-09-25T00:00:00.000Z', newGraceEndsAt: '2026-09-26T00:00:00.000Z' }), /prorrogacao/);
});

test('billing: prorrogacao e idempotente por chave de solicitacao', () => {
  const { store } = makeStore();
  const input = {
    zapId: 'z1', period: '2026-10', days: 5, requestId: 'req-1',
    previousGraceEndsAt: '2026-10-16T00:00:00.000Z',
    newGraceEndsAt: '2026-10-21T00:00:00.000Z'
  };
  const first = store.appendExtension(input);
  const second = store.appendExtension(input);
  assert.strictEqual(first.id, second.id);
  assert.strictEqual(store.extensionsFor('z1').length, 1);
  assert.throws(() => store.appendExtension({ ...input, days: 10, newGraceEndsAt: '2026-10-26T00:00:00.000Z' }), /dados diferentes/);
});

test('billing: livro corrompido sem backup falha fechado e preserva o arquivo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zap-billing-corrupt-'));
  const filePath = path.join(dir, 'billing-ledger.json');
  fs.writeFileSync(filePath, '{ corrompido');
  const store = new BillingStore({ filePath, logger: silentLogger });
  assert.throws(() => store.snapshot(), /indisponivel/);
  assert.throws(() => store.appendPayment({ zapId: 'z1', period: '2026-10', amountCents: 5000, signature }), /indisponivel/);
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), '{ corrompido');
});

test('billing: livro com estrutura invalida falha fechado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zap-billing-structure-'));
  const filePath = path.join(dir, 'billing-ledger.json');
  fs.writeFileSync(filePath, '{}');
  const store = new BillingStore({ filePath, logger: silentLogger });
  assert.throws(() => store.snapshot(), /indisponivel/);
  assert.strictEqual(fs.readFileSync(filePath, 'utf8'), '{}');
});

test('billing: livro ausente e restaurado do backup', () => {
  const { store, dir } = makeStore();
  store.appendPayment({ zapId: 'z1', period: '2026-10', amountCents: 5000, signature });
  store.appendPayment({ zapId: 'z1', period: '2026-09', amountCents: 5000, signature });
  fs.unlinkSync(path.join(dir, 'billing-ledger.json'));
  const restored = new BillingStore({ filePath: path.join(dir, 'billing-ledger.json'), logger: silentLogger });
  assert.strictEqual(restored.snapshot().payments.length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'billing-ledger.json')));
});

test('billing: assinatura desativada nao bloqueia e plano futuro permanece pendente', () => {
  const now = new Date('2026-11-20T12:00:00');
  const ownUse = billing.describeBilling({ id: 'z1', billingPlan: plan({ enabled: false }) }, now, {});
  assert.strictEqual(ownUse.enabled, false);
  assert.strictEqual(ownUse.active, true);
  assert.strictEqual(ownUse.reason, 'own_use');
  const future = billing.describeBilling({ id: 'z2', billingPlan: plan({ startMonth: '2027-01' }) }, now, {});
  assert.strictEqual(future.status, 'pending');
  assert.strictEqual(future.active, true);
  assert.strictEqual(future.nextDueDate, '2027-01-10');
});

testAsync('billing: gate do WhatsApp impede conexao e envio quando inativo', async () => {
  const manager = new WhatsAppManager(null);
  manager.setAccessGate(() => ({ active: false, reason: 'atrasado', oldestUnpaidPeriod: '2026-10' }));
  const connection = await manager.connectZap('z1', '5511999999999', 'qrcode');
  assert.strictEqual(connection.status, 'billing_suspended');
  assert.strictEqual(manager.clients.size, 0);
  let called = false;
  await assert.rejects(() => manager._sendRobust('z1', ['5511999999999@c.us'], async () => { called = true; }), /sem acesso/);
  assert.strictEqual(called, false);
});

testAsync('billing: mensagem recebida nao e lida quando o acesso esta bloqueado', async () => {
  const manager = new WhatsAppManager(null);
  manager.setAccessGate(() => ({ active: false, reason: 'atrasado', oldestUnpaidPeriod: '2026-10' }));
  const message = new Proxy({}, { get() { throw new Error('mensagem nao deveria ser lida'); } });
  await manager.handleMessage('z1', message);
});

testAsync('billing: falha ao consultar o gate tambem bloqueia por seguranca', async () => {
  const manager = new WhatsAppManager(null);
  manager.setAccessGate(() => { throw new Error('ledger indisponivel'); });
  const state = manager._accessState('z1');
  assert.strictEqual(state.active, false);
  assert.strictEqual(state.reason, 'access_unavailable');
  await assert.rejects(() => manager._sendRobust('z1', [], async () => true), /sem acesso/);
});

(async () => {
  for (const { name, fn } of pendingAsync) {
    try {
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (error) {
      failures.push({ name, error: error.message });
      console.log(`FAIL - ${name}`);
      console.log(`      ${error.message}`);
    }
  }
  console.log(`\n${passed} testes passaram; ${failures.length} falharam.`);
  if (failures.length) process.exitCode = 1;
})();
