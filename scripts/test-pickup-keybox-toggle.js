#!/usr/bin/env node
/**
 * Simulates Returns "Pick Up" / "In Yard" key_box behaviour (same logic as POST /api/returns/:id/pickup).
 * Run: npm run test-pickup-keybox
 */
(async () => {
  const { db, initializeDatabase } = require('../src/database');
  const { syncKeyBoxForPickedUp } = require('../src/utils/keyBoxSync');

  await initializeDatabase();
  const carparkId = 1;

  const inv = await db.prepare(`
    SELECT * FROM invoices
    WHERE carpark_id = ? AND void = 0 AND (no_key = 0 OR no_key IS NULL)
      AND key_number IS NOT NULL AND TRIM(CAST(key_number AS TEXT)) != ''
    ORDER BY id DESC LIMIT 1
  `).get(carparkId);

  if (!inv) {
    console.log('No invoice with a physical key found — add a booking with a key number first.');
    process.exit(0);
  }

  const kn = parseInt(String(inv.key_number).trim(), 10);
  const readKey = async () =>
    db.prepare('SELECT status, invoice_id FROM key_box WHERE carpark_id = ? AND key_number = ?').get(carparkId, kn);

  console.log('Using invoice id=%s key_number=%s (rego %s)', inv.id, kn, inv.rego || '');

  // 1) Pick Up (not in yard)
  await db.prepare('UPDATE invoices SET picked_up = ? WHERE id = ?').run('Picked Up', inv.id);
  await syncKeyBoxForPickedUp(db, carparkId, inv.id, inv, 'Picked Up');
  let k = await readKey();
  console.log('After Pick Up → key_box:', k);
  if (!k || k.status !== 'available' || k.invoice_id != null) {
    console.error('FAIL: expected key available after Pick Up');
    process.exit(1);
  }

  // 2) In Yard again
  await db.prepare('UPDATE invoices SET picked_up = ? WHERE id = ?').run('Car In Yard', inv.id);
  await syncKeyBoxForPickedUp(db, carparkId, inv.id, inv, 'Car In Yard');
  k = await readKey();
  console.log('After In Yard → key_box:', k);
  if (!k || k.status !== 'in_use' || Number(k.invoice_id) !== Number(inv.id)) {
    console.error('FAIL: expected key in_use for this invoice after In Yard');
    process.exit(1);
  }

  // 3) Restore original picked_up so DB is not left in a weird state for dev
  const original = inv.picked_up || 'Car In Yard';
  await db.prepare('UPDATE invoices SET picked_up = ? WHERE id = ?').run(original, inv.id);
  await syncKeyBoxForPickedUp(db, carparkId, inv.id, inv, original);
  k = await readKey();
  console.log('Restored invoice picked_up=%s → key_box:', original, k);

  console.log('OK — Pick Up frees key; In Yard re-assigns key to invoice.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
