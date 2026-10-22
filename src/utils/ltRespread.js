/**
 * Re-spread an existing long-term prepayment: same total, same cash-received
 * date, same method/reference — only the months it is recognised in change.
 * Used when a payment was spread over the wrong months (e.g. counted from the
 * day the cash arrived instead of the contract start), by the staff "covers
 * from" control and by one-off data corrections.
 */
const { buildProratedPayments, isPlausibleDate } = require('./longtermProration');
const { logActivity } = require('./audit');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function respreadBatch(db, { carparkId, ltId, batchId, coversFrom, months, userId = null, userName = null, notes = null }) {
  const rows = await db.prepare(`
    SELECT * FROM longterm_payments
    WHERE carpark_id = ? AND longterm_customer_id = ? AND payment_batch_id = ?
    ORDER BY payment_date, id
  `).all(carparkId, ltId, batchId);
  if (rows.length === 0) throw Object.assign(new Error('Payment batch not found'), { status: 404 });

  const start = String(coversFrom || '').slice(0, 10);
  if (!isPlausibleDate(start)) throw Object.assign(new Error('A valid "covers from" date is required'), { status: 400 });

  const total = round2(rows.reduce((s, r) => s + (parseFloat(r.amount_ex_gst) || 0), 0));
  const m = Math.max(1, Math.min(12, parseInt(months, 10) || rows.length));
  const cash = String(rows[0].cash_received_date || rows[0].payment_date).slice(0, 10);
  const first = rows[0];

  const proration = buildProratedPayments({
    totalAmountExGst: total,
    cashReceivedDate: cash,
    contractStartDate: start,
    months: m,
    baseNotes: null,
    transactionReference: first.transaction_reference,
  });
  // A single-month payment is recognised on the date given, not the cash date.
  if (m === 1) proration.rows[0].payment_date = start;

  for (const r of proration.rows) {
    await db.prepare(`
      INSERT INTO longterm_payments
        (carpark_id, longterm_customer_id, payment_date, amount_ex_gst, payment_method,
         transaction_reference, notes, payment_batch_id, cash_received_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(carparkId, ltId, r.payment_date, r.amount_ex_gst, first.payment_method,
      first.transaction_reference, r.notes, batchId, r.cash_received_date);
  }
  // Old rows go only after the new ones are safely in.
  for (const r of rows) await db.prepare('DELETE FROM longterm_payments WHERE id = ?').run(r.id);

  await logActivity(db, {
    carparkId, tableName: 'longterm_payments', recordId: ltId, action: 'respread',
    before: { batchId, months: rows.length, first: String(rows[0].payment_date).slice(0, 10), last: String(rows[rows.length - 1].payment_date).slice(0, 10), total },
    after: { batchId, months: m, first: proration.rows[0].payment_date, last: proration.rows[proration.rows.length - 1].payment_date, total },
    notes: notes || `Re-spread ${total.toFixed(2)} ex GST from ${start} over ${m} month(s)`,
    userId, userName,
  });

  return { months: m, total, rows: proration.rows };
}

module.exports = { respreadBatch };
