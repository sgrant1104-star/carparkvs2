#!/usr/bin/env node
/**
 * Validates key conflict detection:
 * 1) Assigning a free key succeeds (no conflict).
 * 2) Assigning a key already in_use by another invoice is detected.
 * 3) A booking re-saving with its OWN existing key is NOT flagged as a conflict.
 * 4) Releasing a key correctly frees it up again.
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();
  const { assignKeyToInvoice, releaseKey, checkKeyConflict } = require('../src/utils/keyBoxSync');

  const carparkId = 1;
  const testKey = 9001; // unlikely to collide with real data
  let fail = false;
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail = true; } else { console.log('PASS:', msg); } };

  const createdInvoiceIds = [];
  const mkInvoice = async (num) => {
    const r = await db.prepare(`
      INSERT INTO invoices (invoice_number, carpark_id, first_name, last_name, rego, date_in, time_in, return_date, return_time, total_price, paid_status, void)
      VALUES (?, ?, 'Key', 'Test', 'KEY001', '2026-08-01', '09:00', '2026-08-05', '09:00', 100, 'Eftpos', 0)
    `).run(990000 + (Date.now() % 5000) + num, carparkId);
    createdInvoiceIds.push(r.lastInsertRowid);
    return r.lastInsertRowid;
  };

  // 1) Free key — no conflict
  const noConflict = await checkKeyConflict(db, carparkId, testKey);
  assert(noConflict === null, 'a never-used key has no conflict');

  // 2) Assign to invoice A, then check invoice B trying to take it
  const invA = await mkInvoice(1);
  await assignKeyToInvoice(db, carparkId, testKey, invA);
  const conflictForB = await checkKeyConflict(db, carparkId, testKey);
  assert(conflictForB !== null && conflictForB.holderType === 'invoice', 'key held by invoice A is flagged as a conflict for anyone else');

  // 3) Invoice A re-checking its OWN key is not a conflict
  const selfCheck = await checkKeyConflict(db, carparkId, testKey, { excludeInvoiceId: invA });
  assert(selfCheck === null, 'invoice A checking its own already-held key is not a conflict');

  // 4) Release, then confirm it's free again
  await releaseKey(db, carparkId, testKey);
  const afterRelease = await checkKeyConflict(db, carparkId, testKey);
  assert(afterRelease === null, 'key is free again after release');

  // 5) Re-assign to a different invoice B after release — should succeed with no conflict
  const invB = await mkInvoice(2);
  const conflictForC = await checkKeyConflict(db, carparkId, testKey, { excludeInvoiceId: invB });
  assert(conflictForC === null, 'freed key has no conflict for a new invoice');
  await assignKeyToInvoice(db, carparkId, testKey, invB);
  const conflictForA = await checkKeyConflict(db, carparkId, testKey, { excludeInvoiceId: invA });
  assert(conflictForA !== null, 'once B holds the key, A (excluded) still sees a conflict since B, not A, holds it now');

  console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS');

  // Cleanup
  await releaseKey(db, carparkId, testKey);
  await db.prepare('DELETE FROM invoices WHERE id IN (' + createdInvoiceIds.map(() => '?').join(',') + ')').run(...createdInvoiceIds);

  process.exit(fail ? 1 : 0);
})();
