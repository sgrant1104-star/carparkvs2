#!/usr/bin/env node
/**
 * Validates the customer credit system:
 * 1) A car picked up early (before the paid return date) creates a credit.
 * 2) A car picked up ON TIME or LATE creates no credit.
 * 3) A car picked up early but never paid creates no credit.
 * 4) Calling the check twice on the same invoice never creates a duplicate.
 * 5) Credit is findable by phone, and separately by name when no phone matches.
 * 6) Applying credit consumes it correctly and caps at what's available.
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();
  const { checkAndCreateEarlyReturnCredit, findAvailableCredit, applyCreditToInvoice } = require('../src/utils/customerCredit');

  const carparkId = 1;
  let fail = false;
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail = true; } else { console.log('PASS:', msg); } };

  const createdInvoiceIds = [];
  const mkInvoice = async (opts) => {
    const r = await db.prepare(`
      INSERT INTO invoices (
        invoice_number, carpark_id, first_name, last_name, phone, rego,
        date_in, time_in, return_date, return_time, stay_nights, total_price,
        paid_status, payment_amount, void
      ) VALUES (?, ?, ?, ?, ?, 'CRD001', ?, '09:00', ?, '09:00', ?, ?, ?, ?, 0)
    `).run(
      980000 + (Date.now() % 15000) + Math.floor(Math.random() * 1000), carparkId,
      opts.firstName || 'Credit', opts.lastName || 'Test', opts.phone || '0211234567',
      opts.dateIn, opts.returnDate, opts.nights, opts.total, opts.paidStatus || 'Eftpos', opts.paidStatus === 'To Pay' ? 0 : opts.total
    );
    createdInvoiceIds.push(r.lastInsertRowid);
    return r.lastInsertRowid;
  };

  // 1) Booked 10 nights ($500), picked up after 8 → 2 unused nights → $100 credit
  const inv1 = await mkInvoice({ dateIn: '2026-03-01', returnDate: '2026-03-11', nights: 10, total: 500, phone: '021-555-0001' });
  const credit1 = await checkAndCreateEarlyReturnCredit(db, { carparkId, invoiceId: inv1, actualReturnDate: '2026-03-09' });
  assert(credit1 && Math.abs(credit1.amount - 100) < 0.01, `early return creates $100 credit (got ${credit1 && credit1.amount})`);

  // 2) Picked up exactly on time → no credit
  const inv2 = await mkInvoice({ dateIn: '2026-03-01', returnDate: '2026-03-11', nights: 10, total: 500, phone: '021-555-0002' });
  const credit2 = await checkAndCreateEarlyReturnCredit(db, { carparkId, invoiceId: inv2, actualReturnDate: '2026-03-11' });
  assert(credit2 === null, 'on-time pickup creates no credit');

  // 2b) Picked up LATE → no credit
  const inv2b = await mkInvoice({ dateIn: '2026-03-01', returnDate: '2026-03-11', nights: 10, total: 500, phone: '021-555-0003' });
  const credit2b = await checkAndCreateEarlyReturnCredit(db, { carparkId, invoiceId: inv2b, actualReturnDate: '2026-03-12' });
  assert(credit2b === null, 'late pickup creates no credit');

  // 3) Early return but never paid ("To Pay") → no credit
  const inv3 = await mkInvoice({ dateIn: '2026-03-01', returnDate: '2026-03-11', nights: 10, total: 500, phone: '021-555-0004', paidStatus: 'To Pay' });
  const credit3 = await checkAndCreateEarlyReturnCredit(db, { carparkId, invoiceId: inv3, actualReturnDate: '2026-03-09' });
  assert(credit3 === null, 'unpaid early-return booking creates no credit');

  // 4) Idempotency — calling twice on the same invoice does not duplicate
  const inv4 = await mkInvoice({ dateIn: '2026-03-01', returnDate: '2026-03-11', nights: 10, total: 500, phone: '021-555-0005' });
  await checkAndCreateEarlyReturnCredit(db, { carparkId, invoiceId: inv4, actualReturnDate: '2026-03-09' });
  const secondCall = await checkAndCreateEarlyReturnCredit(db, { carparkId, invoiceId: inv4, actualReturnDate: '2026-03-09' });
  const countForInv4 = await db.prepare('SELECT COUNT(*) as n FROM customer_credits WHERE source_invoice_id = ?').get(inv4);
  assert(secondCall === null && countForInv4.n === 1, `calling twice creates exactly 1 credit row (got ${countForInv4.n})`);

  // 5) Findable by phone
  const lookupByPhone = await findAvailableCredit(db, { carparkId, phone: '021 555 0001', firstName: '', lastName: '' });
  assert(lookupByPhone.totalAvailable === 100, `credit found by phone regardless of formatting (got ${lookupByPhone.totalAvailable})`);

  // 5b) Findable by name when phone doesn't match anything
  const lookupByName = await findAvailableCredit(db, { carparkId, phone: '999999', firstName: 'Credit', lastName: 'Test' });
  assert(lookupByName.totalAvailable > 0, 'falls back to name match when phone has no hits');

  // 6) Apply credit — caps at what's available, consumes correctly
  const inv6 = await mkInvoice({ dateIn: '2026-04-01', returnDate: '2026-04-03', nights: 2, total: 40, phone: '021-555-0001', paidStatus: 'To Pay' });
  const applyResult = await applyCreditToInvoice(db, { carparkId, invoiceId: inv6, amount: 100, phone: '021-555-0001' });
  assert(applyResult.applied === 40, `apply caps at invoice-requested amount, not full credit (got ${applyResult.applied})`);
  const afterApply = await findAvailableCredit(db, { carparkId, phone: '021-555-0001' });
  assert(Math.abs(afterApply.totalAvailable - 60) < 0.01, `remaining credit is $60 after applying $40 of $100 (got ${afterApply.totalAvailable})`);
  const inv6Row = await db.prepare('SELECT credit_applied FROM invoices WHERE id = ?').get(inv6);
  assert(Math.abs(inv6Row.credit_applied - 40) < 0.01, `invoice.credit_applied set to $40 (got ${inv6Row.credit_applied})`);

  console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS');

  // Cleanup
  await db.prepare('DELETE FROM customer_credits WHERE source_invoice_id IN (' + createdInvoiceIds.map(() => '?').join(',') + ')').run(...createdInvoiceIds);
  await db.prepare('DELETE FROM invoices WHERE id IN (' + createdInvoiceIds.map(() => '?').join(',') + ')').run(...createdInvoiceIds);

  process.exit(fail ? 1 : 0);
})();
