const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { businessDateYmd } = require('../utils/businessDate');
const { syncKeyBoxForPickedUp } = require('../utils/keyBoxSync');
const { checkAndCreateEarlyReturnCredit } = require('../utils/customerCredit');
const { overstayFor, GRACE_MINUTES } = require('../utils/stayDays');
const { logActivity, actorFromReq } = require('../utils/audit');
const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { date, filter, search, search_type, show_voided } = req.query;
    const filterDate = date || businessDateYmd();

    let dateField = 'return_date';
    if (filter === 'date_brought_in') dateField = 'date_in';
    else if (filter === 'date_paid')   dateField = 'updated_at';

    const inYardExpr = `(i.picked_up IS NULL OR i.picked_up = '' OR i.picked_up = 'Car In Yard')`;

    let query = `
      SELECT i.*, u.name as staff_name, ac.company_name as account_name
      FROM invoices i
      LEFT JOIN users u ON i.staff_id = u.id
      LEFT JOIN account_customers ac ON i.account_customer_id = ac.id
      WHERE i.carpark_id = ?
    `;
    const params = [carparkId];

    // Return Date view includes:
    // - cars returning on selected day, plus
    // - overdue cars (past return date) that are still in yard, plus
    // - cars with no return date yet (TBC / blank) still in yard — otherwise they only appear in Key Box.
    const noReturnYet = `(trim(COALESCE(i.return_date, '')) = '' OR i.return_date IS NULL)`;
    if (dateField === 'return_date') {
      // Only cars still in yard — picked-up vehicles drop off the returns list immediately.
      query += ` AND ${inYardExpr} AND (
        DATE(i.return_date) = ?
        OR DATE(i.return_date) < ?
        OR ${noReturnYet}
      )`;
      params.push(filterDate, filterDate);
    } else {
      query += ` AND DATE(i.${dateField}) = ?`;
      params.push(filterDate);
    }

    if (show_voided !== 'true') query += ' AND i.void = 0';

    if (search && search.trim()) {
      const s = `%${search.trim()}%`;
      if (search_type === 'name') {
        query += ` AND (i.last_name LIKE ? OR i.first_name LIKE ?)`;
        params.push(s, s);
      } else if (search_type === 'rego') {
        query += ` AND i.rego LIKE ?`;
        params.push(s);
      } else {
        query += ` AND CAST(i.invoice_number AS TEXT) LIKE ?`;
        params.push(s);
      }
    }
    query += ' ORDER BY i.return_time ASC, i.id ASC';

    const invoices = await db.prepare(query).all(...params);
    const groups = {}, overdue = [];
    const ymd = (v) => {
      if (v == null || v === '') return '';
      const s = String(v);
      return s.length >= 10 ? s.slice(0, 10) : s;
    };
    invoices.forEach(inv => {
      const rd = ymd(inv.return_date);
      if (!rd || rd < filterDate) {
        overdue.push(inv);
      } else {
        const timeKey = inv.return_time || 'Unspecified';
        if (!groups[timeKey]) groups[timeKey] = [];
        groups[timeKey].push(inv);
      }
    });
    res.json({ date: filterDate, total: invoices.length, groups, overdue, overdueCars: overdue.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const isPaying = (status) => !!status && status !== 'To Pay' && status !== 'OnAcc';
const PAY_METHODS = ['Eftpos', 'Cash'];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** What this booking has actually had paid against it (cash/eftpos/IB/credit lines — not On Account). */
function paidSoFar(inv) {
  let paid = Number(inv.credit_applied) || 0;
  if (isPaying(inv.paid_status)) paid += Number(inv.payment_amount) || 0;
  if (isPaying(inv.paid_status_2)) paid += Number(inv.payment_amount_2) || 0;
  return round2(paid);
}

// GET /api/returns/:id/overstay — is this car being collected late (past the booked days + 30 min grace)?
// The Returns page asks this when Pick Up is clicked, so staff can charge, add it to the account, or waive it.
router.get('/:id/overstay', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ? AND carpark_id = ?').get(req.params.id, carparkId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    const o = await overstayFor(db, invoice, { carparkId });
    if (!o) return res.json({ late: false, graceMinutes: GRACE_MINUTES });
    res.json({
      late: true, ...o,
      onAccount: !!invoice.account_customer_id,
      total: round2(invoice.total_price), paid: paidSoFar(invoice),
      owingBefore: invoice.account_customer_id ? 0 : Math.max(0, round2(invoice.total_price - paidSoFar(invoice))),
      name: `${invoice.first_name || ''} ${invoice.last_name || ''}`.trim(), rego: invoice.rego,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Applies the staff's choice for a late pick-up to the invoice. `choice` is one of:
 *   'waive'  — no charge (noted on the booking)
 *   'owing'  — add the extra to the total and leave it unpaid (balance owing)
 *   'Eftpos' | 'Cash' — extra added to the total AND collected now as a payment dated today
 * An account booking just has the extra added to what is billed to the account.
 * Always re-worked out here from the invoice — the screen's figures are never trusted.
 */
async function applyOverstay(invoice, o, choice, { carparkId, userId, userName }) {
  const today = businessDateYmd();
  const before = { ...invoice };
  const note = (txt) => [invoice.notes, txt].filter(Boolean).join(' — ');
  let sql; let params; let summary;

  if (choice === 'waive') {
    sql = 'UPDATE invoices SET notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
    params = [note(`Collected ${o.minutesPastBlock} min after the paid day ended — extra day waived`), invoice.id];
    summary = 'waived';
  } else {
    const newTotal = round2((Number(invoice.total_price) || 0) + o.extraAmount);
    const txt = `Late pick-up: +${o.extraDays} day${o.extraDays === 1 ? '' : 's'} ($${o.extraAmount.toFixed(2)})`;
    if (invoice.account_customer_id) {
      sql = `UPDATE invoices SET total_price = ?, payment_amount = ?, stay_nights = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
      params = [newTotal, newTotal, o.actualDays, note(`${txt} — billed to account`), invoice.id];
      summary = 'billed to the account';
    } else if (choice === 'owing') {
      sql = `UPDATE invoices SET total_price = ?, stay_nights = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
      params = [newTotal, o.actualDays, note(`${txt} — still owing`), invoice.id];
      summary = 'added, still owing';
    } else if (PAY_METHODS.includes(choice)) {
      const nothingPaid = paidSoFar(invoice) === 0 && !isPaying(invoice.paid_status) && !isPaying(invoice.paid_status_2);
      if (nothingPaid) {
        // Unpaid booking: they now settle the whole new total.
        sql = `UPDATE invoices SET total_price = ?, stay_nights = ?, paid_status = ?, payment_amount = ?, payment_date_1 = ?, paid_status_2 = NULL, payment_amount_2 = 0, payment_date_2 = NULL, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
        params = [newTotal, o.actualDays, choice, newTotal, today, note(`${txt} — paid by ${choice}`), invoice.id];
      } else if (!isPaying(invoice.paid_status_2)) {
        // Already paid: the extra goes on as a second payment dated today.
        sql = `UPDATE invoices SET total_price = ?, stay_nights = ?, paid_status_2 = ?, payment_amount_2 = ?, payment_date_2 = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
        params = [newTotal, o.actualDays, choice, o.extraAmount, today, note(`${txt} — paid by ${choice}`), invoice.id];
      } else if (invoice.paid_status_2 === choice) {
        sql = `UPDATE invoices SET total_price = ?, stay_nights = ?, payment_amount_2 = ?, payment_date_2 = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
        params = [newTotal, o.actualDays, round2(invoice.payment_amount_2 + o.extraAmount), today, note(`${txt} — paid by ${choice}`), invoice.id];
      } else if (invoice.paid_status === choice) {
        sql = `UPDATE invoices SET total_price = ?, stay_nights = ?, payment_amount = ?, payment_date_1 = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
        params = [newTotal, o.actualDays, round2(invoice.payment_amount + o.extraAmount), today, note(`${txt} — paid by ${choice}`), invoice.id];
      } else {
        const e = new Error('Both payment lines on this booking are already used by other methods — add it as "still owing" and record the payment on the invoice.');
        e.status = 400; throw e;
      }
      summary = `collected by ${choice}`;
    } else {
      const e = new Error('Choose how to handle the late pick-up.'); e.status = 400; throw e;
    }
  }
  await db.prepare(sql).run(...params);
  const after = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice.id);
  await logActivity(db, {
    carparkId, tableName: 'invoices', recordId: invoice.id, action: 'late-pickup', before, after,
    notes: `Late pick-up on ${invoice.invoice_number}: ${o.extraDays} extra day(s), $${o.extraAmount.toFixed(2)} — ${summary}`, userId, userName,
  });
  return { choice, extraDays: o.extraDays, extraAmount: o.extraAmount, summary };
}

router.post('/:id/pickup', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { picked_up, staff_code, staff_code_name } = req.body;
    const carparkId = req.session.carparkId || 1;
    const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ? AND carpark_id = ?').get(id, carparkId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    const final = picked_up || 'Picked Up';

    // Collected late? Only acts when the screen sent a choice — an old page open in a tab never charges by surprise.
    let overstay = null;
    if (final === 'Picked Up' && req.body.overstay && req.body.overstay.choice) {
      const o = await overstayFor(db, invoice, { carparkId });
      if (o) {
        const { userId, userName } = actorFromReq(req);
        try {
          overstay = await applyOverstay(invoice, o, String(req.body.overstay.choice), { carparkId, userId, userName });
        } catch (e) {
          return res.status(e.status || 500).json({ error: e.message });
        }
      }
    }
    if (final === 'Picked Up' && staff_code) {
      await db.prepare("UPDATE invoices SET picked_up = ?, return_staff_code = ?, return_staff_code_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(final, staff_code, staff_code_name || null, id);
    } else {
      await db.prepare("UPDATE invoices SET picked_up = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(final, id);
    }
    // Mirror Invoice save: Pick Up / not in yard → key free; In Yard → key tied to this booking again
    await syncKeyBoxForPickedUp(db, carparkId, Number(id), invoice, final);

    // If this car left before the paid-for return date, save the unused
    // portion as credit against the customer's name/phone for next visit.
    let credit = null;
    if (final !== 'Car In Yard' && final !== 'Voided') {
      credit = await checkAndCreateEarlyReturnCredit(db, {
        carparkId, invoiceId: Number(id), actualReturnDate: businessDateYmd(),
      });
    }

    res.json({ success: true, credit, overstay });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
