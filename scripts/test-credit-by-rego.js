#!/usr/bin/env node
/**
 * Validates that a credit is found for a returning customer by vehicle
 * registration — the case where the original booking had no phone number and
 * only a first name (credit #22, rego PHF488), so neither phone nor
 * first+last name could ever match it.
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();
  const { checkAndCreateEarlyReturnCredit, findAvailableCredit, applyCreditToInvoice } = require('../src/utils/customerCredit');

  const carparkId = 1;
  let fail = false;
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail = true; } else { console.log('PASS:', msg); } };
  const invoiceIds = [];
  const mk = async (opts) => {
    const r = await db.prepare(`
      INSERT INTO invoices (invoice_number, carpark_id, first_name, last_name, phone, rego, date_in, time_in, return_date, return_time, stay_nights, total_price, paid_status, payment_amount, void)
      VALUES (?, ?, ?, ?, ?, ?, ?, '09:00', ?, '09:00', ?, ?, 'Eftpos', ?, 0)
    `).run(970000 + (Date.now() % 20000) + Math.floor(Math.random() * 1000), carparkId, opts.first, opts.last || '', opts.phone || '', opts.rego, opts.dateIn, opts.returnDate, opts.nights, opts.total, opts.total);
    invoiceIds.push(r.lastInsertRowid);
    return r.lastInsertRowid;
  };

  try {
    // First-name-only booking, no phone: 3 nights $33, picked up 1 night early -> $11 credit
    const inv = await mk({ first: 'ZZLUCINDA', rego: 'TST999', dateIn: '2026-12-01', returnDate: '2026-12-04', nights: 3, total: 33 });
    const credit = await checkAndCreateEarlyReturnCredit(db, { carparkId, invoiceId: inv, actualReturnDate: '2026-12-03' });
    assert(credit && Math.abs(credit.amount - 11) < 0.01, `credit created for the first-name-only booking (got ${credit && credit.amount})`);
    const row = await db.prepare('SELECT rego, phone, last_name FROM customer_credits WHERE id = ?').get(credit.id);
    assert(row.rego === 'TST999', 'the vehicle rego is stored on the credit');
    assert(!row.phone && !row.last_name, 'the credit really has no phone or surname (the unmatchable case)');

    // The old matching keys can't find it...
    const byName = await findAvailableCredit(db, { carparkId, phone: '021999', firstName: 'ZZLUCINDA', lastName: 'SMITH' });
    assert(byName.totalAvailable === 0, 'phone / full name alone do not find it (that is the bug)');
    // ...the rego does, however it's typed
    for (const typed of ['TST999', 'tst999', 'TST 999']) {
      const r = await findAvailableCredit(db, { carparkId, rego: typed });
      assert(Math.abs(r.totalAvailable - 11) < 0.01, `found by rego typed as "${typed}" (got ${r.totalAvailable})`);
    }
    assert((await findAvailableCredit(db, { carparkId, rego: 'NOTHERE1' })).totalAvailable === 0, 'a different rego finds nothing');

    // A credit saved BEFORE the rego column existed still matches via its source invoice
    await db.prepare('UPDATE customer_credits SET rego = NULL WHERE id = ?').run(credit.id);
    const legacy = await findAvailableCredit(db, { carparkId, rego: 'tst999' });
    assert(Math.abs(legacy.totalAvailable - 11) < 0.01, 'an older credit with no stored rego is found via its source invoice');

    // Applying it to a new booking (found by rego) consumes it
    const inv2 = await mk({ first: 'ZZLUCINDA', rego: 'TST999', dateIn: '2026-12-10', returnDate: '2026-12-12', nights: 2, total: 36 });
    const applied = await applyCreditToInvoice(db, { carparkId, invoiceId: inv2, amount: 36, rego: 'TST999' });
    assert(Math.abs(applied.applied - 11) < 0.01, `applying by rego uses the $11 credit (applied ${applied.applied})`);
    const after = await findAvailableCredit(db, { carparkId, rego: 'TST999' });
    assert(after.totalAvailable === 0, 'credit is used up afterwards, not offered twice');
  } finally {
    for (const id of invoiceIds) {
      await db.prepare('DELETE FROM customer_credits WHERE source_invoice_id = ? OR used_invoice_id = ?').run(id, id);
      await db.prepare("DELETE FROM activity_log WHERE (table_name = 'invoices' AND record_id = ?) OR (table_name = 'customer_credits')  AND notes LIKE '%TST999%'").run(id);
      await db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
    }
  }
  console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(fail ? 1 : 0);
})();
