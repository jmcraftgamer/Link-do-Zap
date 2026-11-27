'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isValidPeriod } = require('./billing');

function emptyLedger() {
  return { version: 1, payments: [], extensions: [] };
}

function validateLedger(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.payments) || !Array.isArray(value.extensions)) {
    throw new Error('estrutura invalida');
  }
  for (const payment of value.payments) {
    if (!payment || !payment.zapId || !isValidPeriod(payment.period)) throw new Error('pagamento invalido no livro');
  }
  for (const extension of value.extensions) {
    if (!extension || !extension.zapId || !isValidPeriod(extension.period) || !Number.isFinite(Date.parse(extension.newGraceEndsAt))) throw new Error('prorrogacao invalida no livro');
  }
  return value;
}

function cleanSignature(value) {
  const signature = String(value || '').trim();
  if (!signature.startsWith('data:image/png;base64,')) throw new Error('assinatura invalida');
  if (signature.length > 1_500_000) throw new Error('assinatura muito grande');
  const base64 = signature.slice('data:image/png;base64,'.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('assinatura invalida');
  const bytes = Buffer.from(base64, 'base64');
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < pngHeader.length || !bytes.subarray(0, pngHeader.length).equals(pngHeader)) throw new Error('assinatura invalida');
  return signature;
}

class BillingStore {
  constructor(options = {}) {
    this.filePath = options.filePath;
    if (!this.filePath) throw new Error('BillingStore: filePath obrigatorio');
    this.logger = options.logger || console;
    this.ledger = emptyLedger();
    this.loadError = null;
    this.load();
  }

  load() {
    this.loadError = null;
    try {
      if (!fs.existsSync(this.filePath)) {
        const backup = `${this.filePath}.bak`;
        if (!fs.existsSync(backup)) return this.ledger;
        this.ledger = validateLedger(JSON.parse(fs.readFileSync(backup, 'utf8')));
        fs.copyFileSync(backup, this.filePath);
        this.logger.error('[BILLING] livro de pagamentos ausente; restaurado do backup');
      } else {
        this.ledger = validateLedger(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
      }
    } catch (error) {
      const backup = `${this.filePath}.bak`;
      try {
        if (!fs.existsSync(backup)) throw error;
        this.ledger = validateLedger(JSON.parse(fs.readFileSync(backup, 'utf8')));
        fs.copyFileSync(backup, this.filePath);
        this.logger.error(`[BILLING] livro de pagamentos corrompido; restaurado do backup (${error.message})`);
      } catch (_) {
        this.logger.error(`[BILLING] livro de pagamentos corrompido e sem backup valido (${error.message})`);
        this.loadError = error;
        this.ledger = emptyLedger();
      }
    }
    return this.ledger;
  }

  assertReadable() {
    if (this.loadError) throw new Error('livro de pagamentos indisponivel: arquivo corrompido sem backup valido');
  }

  save() {
    this.assertReadable();
    const json = JSON.stringify(this.ledger, null, 2);
    JSON.parse(json);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, json);
    try {
      if (fs.existsSync(this.filePath)) fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
    } catch (_) {}
    try {
      fs.renameSync(tmp, this.filePath);
    } catch (_) {
      fs.writeFileSync(this.filePath, json);
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
    return this.ledger;
  }

  paymentsFor(zapId) {
    return this.ledger.payments
      .filter((payment) => String(payment.zapId) === String(zapId))
      .sort((a, b) => Date.parse(b.paidAt) - Date.parse(a.paidAt));
  }

  extensionsFor(zapId) {
    return this.ledger.extensions
      .filter((extension) => String(extension.zapId) === String(zapId))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  appendPayment(input) {
    const source = input && typeof input === 'object' ? input : {};
    const zapId = String(source.zapId || '').trim();
    const period = String(source.period || '').trim();
    if (!zapId || !isValidPeriod(period)) throw new Error('pagamento invalido');
    const duplicate = this.ledger.payments.find((payment) =>
      String(payment.zapId) === zapId && payment.period === period
    );
    if (duplicate) return { payment: duplicate, duplicate: true };
    const amountCents = Number(source.amountCents);
    if (!Number.isInteger(amountCents) || amountCents < 0) throw new Error('valor do pagamento invalido');
    const payment = {
      id: `pay-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      zapId,
      period,
      paidAt: new Date().toISOString(),
      amountCents,
      amount: amountCents / 100,
      currency: String(source.currency || 'BRL').toUpperCase().slice(0, 3),
      signature: cleanSignature(source.signature),
      note: String(source.note || '').trim().slice(0, 500)
    };
    this.ledger.payments.push(payment);
    this.save();
    return { payment, duplicate: false };
  }

  appendExtension(input) {
    const source = input && typeof input === 'object' ? input : {};
    const zapId = String(source.zapId || '').trim();
    const period = String(source.period || '').trim();
    const days = Number(source.days);
    if (!zapId || !isValidPeriod(period)) throw new Error('prorrogacao invalida');
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('a prorrogacao deve ser entre 1 e 365 dias');
    const previous = Date.parse(source.previousGraceEndsAt);
    const next = Date.parse(source.newGraceEndsAt);
    if (!Number.isFinite(previous) || !Number.isFinite(next) || next <= previous) throw new Error('prazo de prorrogacao invalido');
    const requestId = String(source.requestId || '').trim().slice(0, 120);
    if (requestId) {
      const existing = this.ledger.extensions.find((extension) => extension.requestId === requestId);
      if (existing) {
        if (existing.zapId !== zapId || existing.period !== period || existing.days !== days || existing.newGraceEndsAt !== new Date(next).toISOString()) {
          throw new Error('chave de prorrogacao ja usada com dados diferentes');
        }
        return existing;
      }
    }
    const extension = {
      id: `ext-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      zapId,
      period,
      days,
      previousGraceEndsAt: new Date(previous).toISOString(),
      newGraceEndsAt: new Date(next).toISOString(),
      reason: String(source.reason || '').trim().slice(0, 500),
      requestId: requestId || undefined,
      createdAt: new Date().toISOString()
    };
    this.ledger.extensions.push(extension);
    this.save();
    return extension;
  }

  accessSnapshot() {
    this.assertReadable();
    return {
      version: this.ledger.version,
      payments: this.ledger.payments.map((payment) => ({ zapId: payment.zapId, period: payment.period })),
      extensions: this.ledger.extensions.map((extension) => ({ ...extension }))
    };
  }

  snapshot() {
    this.assertReadable();
    return JSON.parse(JSON.stringify(this.ledger));
  }
}

module.exports = { BillingStore, emptyLedger };
