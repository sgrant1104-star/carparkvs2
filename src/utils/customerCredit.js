/**
 * Customer credit — early return refunds owed back to a customer, saved
 * against their identity so it's automatically surfaced next time they book.
 *
 * Example: customer books and pays for 10 nights, but picks up on night 8.
 * The 2 unused nights become a credit, matched primarily by phone number
 * (most reliable — names have typos/variants), falling back to first+last
 * name if no phone is on file.
 *
 * Pricing note: credit is calculated as an AVERAGE nightly rate
 * (total_price / booked_nights) × unused_nights. This is a reasonable
 * approximation but is not aware of tiered daily pricing (e.g. a rate card
 * where day 9-10 costs less per night than day 1-2) — if exact tiered
 * proration matters, this is the place to plug that in later.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const { logActivity } = require('./audit');

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d]/g, '');
}

function daysBetween(fromYmd, toYmd) {
  const a = new Date(`${String(fromYmd).slice(0, 10)}T00:00:00`);
  const b = new Date(`${String(toYmd).slice(0, 10)}T00:00:00`);
  return Math.round((b - a) / 86400000);
}

/**
 * Call this whenever a booking transitions to "picked up" (from Returns or
 * from editing the invoice directly). Idempotent — safe to call more than
 * once for the same invoice; only creates a credit the first time.
 */
async function checkAndCreateEarlyReturnCredit(db, { carparkId, invoiceId, actualReturnDate, userId = null, userName = null }) {
  const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ? AND carpark_id = ?').get(invoiceId, carparkId);
  if (!invoice || invoice.void) return null;

  // Already handled for this booking — never create a second credit for the same invoice.
  const already = await db.prepare('SELECT id FROM customer_credits WHERE source_invoice_id = ?').get(invoiceId);
  if (already) return null;

  const bookedReturn = String(invoice.return_date || '').slice(0, 10);
  const actual = String(actualReturnDate || '').slice(0, 10);
  if (!bookedReturn || !actual) return null;

  // Only a credit if they left BEFORE the paid-for return date.
  if (actual >= bookedReturn) return null;

  const bookedNights = Number(invoice.stay_nights) > 0
    ? Number(invoice.stay_nights)
    : Math.max(1, daysBetween(String(invoice.date_in || '').slice(0, 10), bookedReturn));
  const unusedNights = daysBetween(actual, bookedReturn);
  if (unusedNights <= 0) return null;

  const totalPrice = parseFloat(invoice.total_price) || 0;
  if (totalPrice <= 0) return null;
  // Nothing was actually paid — no credit to give back.
  const paidSomething = (invoice.paid_status && invoice.paid_status !== 'To Pay')
    || (invoice.paid_status_2 && invoice.paid_status_2 !== 'To Pay');
  if (!paidSomething) return null;

  const ratePerNight = totalPrice / bookedNights;
  const creditAmount = round2(ratePerNight * unusedNights);
  // Skip trivial/rounding-noise credits.
  if (creditAmount < 1) return null;

  const reason = `Early return: booked ${bookedNights} night(s), picked up ${unusedNights} night(s) early (return date ${bookedReturn}, actual ${actual}).`;

  const result = await db.prepare(`
    INSERT INTO customer_credits (carpark_id, phone, first_name, last_name, amount, source_invoice_id, reason, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'available')
  `).run(carparkId, invoice.phone || null, invoice.first_name || null, invoice.last_name || null, creditAmount, invoiceId, reason);

  await logActivity(db, {
    carparkId, tableName: 'customer_credits', recordId: result.lastInsertRowid, action: 'create',
    before: null,
    after: { invoice_id: invoiceId, customer: `${invoice.first_name || ''} ${invoice.last_name || ''}`.trim(), amount: creditAmount, reason },
    notes: reason, userId, userName,
  });

  return { id: result.lastInsertRowid, amount: creditAmount, reason };
}

/**
 * Find available (unused or partially-used) credit for a customer, matched
 * by phone first, then by exact first+last name if no phone match.
 */
async function findAvailableCredit(db, { carparkId, phone, firstName, lastName }) {
  const normPhone = normalizePhone(phone);
  let rows = [];

  if (normPhone) {
    const all = await db.prepare(`
      SELECT * FROM customer_credits
      WHERE carpark_id = ? AND status != 'used' AND phone IS NOT NULL AND phone != ''
      ORDER BY created_at ASC
    `).all(carparkId);
    rows = all.filter(r => normalizePhone(r.phone) === normPhone);
  }

  if (rows.length === 0 && firstName && lastName) {
    rows = await db.prepare(`
      SELECT * FROM customer_credits
      WHERE carpark_id = ? AND status != 'used'
        AND LOWER(TRIM(first_name)) = LOWER(TRIM(?)) AND LOWER(TRIM(last_name)) = LOWER(TRIM(?))
      ORDER BY created_at ASC
    `).all(carparkId, firstName, lastName);
  }

  const withRemaining = rows
    .map(r => ({ ...r, remaining: round2((parseFloat(r.amount) || 0) - (parseFloat(r.amount_used) || 0)) }))
    .filter(r => r.remaining > 0.01);

  const totalAvailable = round2(withRemaining.reduce((s, r) => s + r.remaining, 0));
  return { credits: withRemaining, totalAvailable };
}

/**
 * Apply up to `amount` of a customer's available credit to an invoice.
 * Consumes oldest credit first. Updates invoices.credit_applied (additive —
 * safe to call more than once, e.g. if the amount is adjusted before save).
 *
 * The amount actually applied is capped at what the invoice still owes
 * (total_price minus whatever credit_applied already is) — never lets an
 * invoice go into a nonsensical negative balance. Any excess simply stays
 * available on the customer's ledger for their next visit.
 */
async function applyCreditToInvoice(db, { carparkId, invoiceId, amount, phone, firstName, lastName, userId = null, userName = null }) {
  const invoiceBefore = await db.prepare('SELECT total_price, credit_applied FROM invoices WHERE id = ? AND carpark_id = ?').get(invoiceId, carparkId);
  if (!invoiceBefore) return { applied: 0, creditsUsed: [] };

  const maxApplicable = Math.max(0, round2((parseFloat(invoiceBefore.total_price) || 0) - (parseFloat(invoiceBefore.credit_applied) || 0)));
  const startingAmount = Math.min(round2(amount), maxApplicable);
  let remaining = startingAmount;
  if (remaining <= 0) return { applied: 0, creditsUsed: [] };

  const { credits } = await findAvailableCredit(db, { carparkId, phone, firstName, lastName });
  const creditsUsed = [];

  for (const credit of credits) {
    if (remaining <= 0.001) break;
    const take = round2(Math.min(remaining, credit.remaining));
    if (take <= 0) continue;
    const newUsed = round2((parseFloat(credit.amount_used) || 0) + take);
    const newStatus = newUsed >= parseFloat(credit.amount) - 0.01 ? 'used' : 'available';
    await db.prepare(`
      UPDATE customer_credits SET amount_used = ?, status = ?, used_invoice_id = ?, used_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newUsed, newStatus, invoiceId, credit.id);
    creditsUsed.push({ credit_id: credit.id, amount_applied: take, source_invoice_id: credit.source_invoice_id });
    remaining = round2(remaining - take);
  }

  const appliedTotal = round2(startingAmount - remaining);
  if (appliedTotal > 0) {
    const newCreditApplied = round2((parseFloat(invoiceBefore.credit_applied) || 0) + appliedTotal);
    await db.prepare('UPDATE invoices SET credit_applied = ? WHERE id = ?').run(newCreditApplied, invoiceId);

    await logActivity(db, {
      carparkId, tableName: 'invoices', recordId: invoiceId, action: 'apply_credit',
      before: null, after: { applied: appliedTotal, creditsUsed },
      notes: `Applied $${appliedTotal.toFixed(2)} credit to invoice`, userId, userName,
    });
  }

  return { applied: appliedTotal, creditsUsed };
}

/**
 * Restores whatever credit was consumed by a specific invoice — used when
 * that invoice is voided or deleted, so the customer doesn't lose real
 * credit just because the booking it was applied to got cancelled. Each
 * credit record is only ever consumed by one booking at a time in the
 * current flow, so a full reset back to available is correct here (not a
 * partial adjustment).
 */
async function releaseCreditForInvoice(db, { carparkId, invoiceId, userId = null, userName = null }) {
  const rows = await db.prepare(`
    SELECT * FROM customer_credits WHERE carpark_id = ? AND used_invoice_id = ?
  `).all(carparkId, invoiceId);
  if (rows.length === 0) return rows;

  await db.prepare(`
    UPDATE customer_credits SET amount_used = 0, status = 'available', used_invoice_id = NULL, used_at = NULL
    WHERE carpark_id = ? AND used_invoice_id = ?
  `).run(carparkId, invoiceId);

  await logActivity(db, {
    carparkId, tableName: 'customer_credits', recordId: invoiceId, action: 'released_on_cancel',
    before: rows, after: null,
    notes: `Restored ${rows.length} credit record(s) totalling $${rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0).toFixed(2)} — source invoice was voided/deleted`,
    userId, userName,
  });

  return rows;
}

module.exports = {
  checkAndCreateEarlyReturnCredit,
  findAvailableCredit,
  applyCreditToInvoice,
  releaseCreditForInvoice,
  normalizePhone,
};
