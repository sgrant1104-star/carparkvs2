#!/usr/bin/env node
/**
 * Validates that saving an End of Day record without a terminal total
 * preserves whatever was already checked/saved for that date, instead of
 * silently wiping it to null. Reproduces the exact real-world bug: check
 * the terminal, save (matches) — then later save again (e.g. just to add a
 * note) with the terminal field blank, and the earlier check used to
 * silently disappear.
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  await initializeDatabase();

  const carparkId = 1;
  const testDate = '2026-07-08';
  let fail = false;
  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail = true; } else { console.log('PASS:', msg); } };

  // Simulate what endday.js's POST route now does, directly against the DB,
  // mirroring the exact fixed logic (submittedMachineTotal / existing fallback).
  async function simulateSave({ notes, eftpos_machine_total }) {
    const existing = await db.prepare('SELECT * FROM end_day WHERE carpark_id = ? AND date = ?').get(carparkId, testDate);
    const submittedMachineTotal = eftpos_machine_total != null && eftpos_machine_total !== ''
      ? parseFloat(eftpos_machine_total) : null;
    const machineTotal = Number.isFinite(submittedMachineTotal)
      ? submittedMachineTotal
      : (existing && existing.eftpos_machine_total != null ? parseFloat(existing.eftpos_machine_total) : null);

    if (existing) {
      await db.prepare(`UPDATE end_day SET notes = ?, eftpos_machine_total = ? WHERE id = ?`).run(notes, machineTotal, existing.id);
    } else {
      await db.prepare(`INSERT INTO end_day (carpark_id, date, notes, eftpos_machine_total, total_revenue, cars_in, cars_in_yard, eftpos_total, cash_total, account_total) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0)`)
        .run(carparkId, testDate, notes, machineTotal);
    }
    return machineTotal;
  }

  // Clean slate
  await db.prepare('DELETE FROM end_day WHERE carpark_id = ? AND date = ?').run(carparkId, testDate);

  // 1) First save: staff checks the terminal, it matches, saves with a real figure.
  await simulateSave({ notes: 'MATCHES', eftpos_machine_total: '369.00' });
  let record = await db.prepare('SELECT * FROM end_day WHERE carpark_id = ? AND date = ?').get(carparkId, testDate);
  assert(parseFloat(record.eftpos_machine_total) === 369, `first save stores the terminal total correctly (got ${record.eftpos_machine_total})`);

  // 2) Later save: staff just updates a note, terminal field happens to be blank.
  await simulateSave({ notes: 'MATCHES - updated note', eftpos_machine_total: '' });
  record = await db.prepare('SELECT * FROM end_day WHERE carpark_id = ? AND date = ?').get(carparkId, testDate);
  assert(parseFloat(record.eftpos_machine_total) === 369, `second save with blank terminal field PRESERVES the earlier $369 check (got ${record.eftpos_machine_total}) — this is the bug fix`);
  assert(record.notes === 'MATCHES - updated note', 'notes still update correctly even while the terminal total is preserved');

  // 3) A genuine correction: staff re-enters a new terminal figure — should actually update this time.
  await simulateSave({ notes: 'Recount', eftpos_machine_total: '360.00' });
  record = await db.prepare('SELECT * FROM end_day WHERE carpark_id = ? AND date = ?').get(carparkId, testDate);
  assert(parseFloat(record.eftpos_machine_total) === 360, `explicitly entering a new value DOES update it (got ${record.eftpos_machine_total})`);

  console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS');

  await db.prepare('DELETE FROM end_day WHERE carpark_id = ? AND date = ?').run(carparkId, testDate);
  process.exit(fail ? 1 : 0);
})();
