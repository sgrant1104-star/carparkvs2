/**
 * Key box rows must exist for each physical key. If staff enter a key number on an
 * invoice that was never added to key_box, plain UPDATE ... SET status='available'
 * updates 0 rows — the Key Box screen then stays wrong. These helpers UPSERT so the
 * row is created or corrected.
 */

function parseKeyNumber(keyNumber) {
  if (keyNumber == null || keyNumber === '') return null;
  const kn = parseInt(String(keyNumber).trim(), 10);
  return Number.isNaN(kn) ? null : kn;
}

/** Mark key as free (picked up / void / invoice deleted). */
async function releaseKey(db, carparkId, keyNumber) {
  const kn = parseKeyNumber(keyNumber);
  if (kn == null) return;
  await db.prepare(`
    INSERT INTO key_box (carpark_id, key_number, status, invoice_id, longterm_customer_id, holder_type)
    VALUES (?, ?, 'available', NULL, NULL, 'available')
    ON CONFLICT(carpark_id, key_number) DO UPDATE SET
      status = 'available',
      invoice_id = NULL,
      longterm_customer_id = NULL,
      holder_type = 'available'
  `).run(carparkId, kn);
}

/** Mark key as tied to an active booking (car in yard). */
async function assignKeyToInvoice(db, carparkId, keyNumber, invoiceId) {
  const kn = parseKeyNumber(keyNumber);
  if (kn == null) return;
  const iid = typeof invoiceId === 'bigint' ? Number(invoiceId) : invoiceId;
  await db.prepare(`
    INSERT INTO key_box (carpark_id, key_number, status, invoice_id, longterm_customer_id, holder_type)
    VALUES (?, ?, 'in_use', ?, NULL, 'invoice')
    ON CONFLICT(carpark_id, key_number) DO UPDATE SET
      status = 'in_use',
      invoice_id = excluded.invoice_id,
      longterm_customer_id = NULL,
      holder_type = 'invoice'
  `).run(carparkId, kn, iid);
}

async function assignKeyToLongTerm(db, carparkId, keyNumber, longtermCustomerId) {
  const kn = parseKeyNumber(keyNumber);
  if (kn == null) return;
  const lid = typeof longtermCustomerId === 'bigint' ? Number(longtermCustomerId) : longtermCustomerId;
  await db.prepare(`
    INSERT INTO key_box (carpark_id, key_number, status, invoice_id, longterm_customer_id, holder_type)
    VALUES (?, ?, 'in_use', NULL, ?, 'longterm')
    ON CONFLICT(carpark_id, key_number) DO UPDATE SET
      status = 'in_use',
      invoice_id = NULL,
      longterm_customer_id = excluded.longterm_customer_id,
      holder_type = 'longterm'
  `).run(carparkId, kn, lid);
}

/**
 * Keep key_box aligned with invoice picked_up (same rules as Invoice save).
 * Car In Yard → key in_use for this invoice; anything else → key available.
 */
async function syncKeyBoxForPickedUp(db, carparkId, invoiceId, invoiceRow, pickedUpStatus) {
  const final = pickedUpStatus || 'Car In Yard';
  if (!invoiceRow) return;
  const noKey = invoiceRow.no_key === 1 || invoiceRow.no_key === true;
  if (noKey) return;
  const kn = parseKeyNumber(invoiceRow.key_number);
  if (kn == null) return;
  if (final === 'Car In Yard') {
    await assignKeyToInvoice(db, carparkId, kn, invoiceId);
  } else {
    await releaseKey(db, carparkId, kn);
  }
}

module.exports = { parseKeyNumber, releaseKey, assignKeyToInvoice, assignKeyToLongTerm, syncKeyBoxForPickedUp };
