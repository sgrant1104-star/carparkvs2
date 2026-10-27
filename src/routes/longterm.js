const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { parseKeyNumber } = require('../utils/keyBoxSync');
const {
  buildProratedPayments,
  collapsePaymentsForDisplay,
  suggestMonthsForPayment,
  suggestCoverageStart,
  coverageMonths,
  findOverlapMonths,
  isPlausibleDate,
} = require('../utils/longtermProration');
const { respreadBatch } = require('../utils/ltRespread');
const ltReminders = require('../utils/ltReminders');
const { businessDateYmd } = require('../utils/businessDate');
const { logActivity, actorFromReq } = require('../utils/audit');
const { withUppercaseFields } = require('../utils/textCase');
const router = express.Router();

function normalizedMoney(val) {
  if (val == null || val === '') return null;
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : null;
}

function ymdToday() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetweenYmd(fromYmd, toYmd) {
  if (!fromYmd || !toYmd) return null;
  const a = new Date(`${fromYmd}T00:00:00Z`);
  const b = new Date(`${toYmd}T00:00:00Z`);
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function withRenewalStatus(row, todayYmd) {
  const expiry = row.expiry_date ? String(row.expiry_date).slice(0, 10) : null;
  if (!expiry) {
    return { ...row, expiry_date: null, renewal_status: 'no_expiry', days_to_expiry: null };
  }
  const days = daysBetweenYmd(todayYmd, expiry);
  let renewal = 'active';
  if (days < 0) renewal = 'expired';
  else if (days <= 30) renewal = 'due_soon';
  return { ...row, expiry_date: expiry, renewal_status: renewal, days_to_expiry: days };
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const today = ymdToday();
    const status = String(req.query.status || 'active').toLowerCase();
    let activeClause = ' AND active = 1';
    if (status === 'archived') activeClause = ' AND active = 0';
    else if (status === 'all') activeClause = '';
    const customers = await db.prepare(`
      SELECT * FROM longterm_customers WHERE carpark_id = ?${activeClause}
      ORDER BY CAST(REPLACE(lt_number, 'LT', '') AS INTEGER)
    `).all(carparkId);
    res.json(customers.map(c => withRenewalStatus(c, today)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/longterm/overview?status=active|archived
// Everyone with their "paid through" date, next payment due, days left and
// amount — worked out from the payments, so staff don't have to — plus the
// summary cards and how many reminders are waiting for review.
router.get('/overview', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const today = businessDateYmd();
    const archived = String(req.query.status || 'active').toLowerCase() === 'archived';
    // Make sure today's reminders exist before counting them.
    if (!archived) await ltReminders.generateDrafts(db, { carparkId, todayYmd: today });

    const all = await ltReminders.loadCustomersWithStatus(db, carparkId, today, { includeArchived: true });
    const list = all.filter((x) => (archived ? Number(x.customer.active) === 0 : Number(x.customer.active) === 1));

    const lastRem = await db.prepare(`
      SELECT longterm_customer_id AS id, MAX(sent_at) AS sent_at FROM lt_reminders
      WHERE carpark_id = ? AND status = 'sent' GROUP BY longterm_customer_id
    `).all(carparkId);
    const lastSent = new Map(lastRem.map((r) => [r.id, r.sent_at]));
    // Has a reminder already gone out for the payment that is due next?
    const sentCycles = await db.prepare(`
      SELECT longterm_customer_id AS id, cycle_due_date FROM lt_reminders
      WHERE carpark_id = ? AND status = 'sent'
    `).all(carparkId);
    const sentForCycle = new Set(sentCycles.map((r) => `${r.id}|${String(r.cycle_due_date).slice(0, 10)}`));
    const drafted = await db.prepare(`
      SELECT longterm_customer_id AS id, kind FROM lt_reminders
      WHERE carpark_id = ? AND status = 'drafted' AND (snoozed_until IS NULL OR snoozed_until <= ?)
    `).all(carparkId, today);
    const draftKind = new Map(drafted.map((r) => [r.id, r.kind]));

    const customers = list.map(({ customer, status }) => ({
      ...withRenewalStatus(customer, today),
      key_number: customer.lt_key_slot || null,
      key_in_yard: !!customer.lt_in_yard,
      status,
      lastReminderSentAt: lastSent.get(customer.id) || null,
      sentForNextDue: !!status.nextDue && sentForCycle.has(`${customer.id}|${status.nextDue}`),
      draftKind: draftKind.get(customer.id) || null,
    }));

    const money = (n) => Math.round(n * 100) / 100;
    const sumAmt = (xs) => money(xs.reduce((s, c) => s + (c.status.nextAmountInc || 0), 0));
    const by = (b) => customers.filter((c) => c.status.bucket === b);
    const next30 = customers.filter((c) => c.status.days != null && c.status.days >= 0 && c.status.days <= 30);
    res.json({
      today,
      customers,
      summary: {
        overdue: { count: by('overdue').length, amount: sumAmt(by('overdue')) },
        soon: { count: by('soon').length, amount: sumAmt(by('soon')) },
        upcoming: { count: by('upcoming').length, amount: sumAmt(by('upcoming')) },
        paid: { count: by('paid').length },
        none: { count: by('none').length },
        next30: { count: next30.length, amount: sumAmt(next30) },
      },
      draftCount: archived ? 0 : draftKind.size,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/next-number', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    // Pick the smallest missing LT number among all customers (active OR
    // archived). Archived rows still occupy their lt_number (UNIQUE) — if we
    // only checked active rows here, this could suggest an archived
    // customer's number, and creating a new customer with it silently
    // reactivates + overwrites the archived record (see POST '/').
    const rows = await db.prepare(`
      SELECT lt_number
      FROM longterm_customers
      WHERE carpark_id = ?
      ORDER BY CAST(REPLACE(lt_number, 'LT', '') AS INTEGER) ASC
    `).all(carparkId);

    const used = new Set();
    for (const r of rows) {
      const n = parseInt(String(r.lt_number).replace('LT', ''), 10);
      if (!Number.isNaN(n) && n > 0) used.add(n);
    }

    let next = 1;
    while (used.has(next)) next += 1;
    res.json({ ltNumber: `LT${next}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const customer = await db.prepare('SELECT * FROM longterm_customers WHERE id = ?').get(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Not found' });
    res.json({
      ...withRenewalStatus(customer, ymdToday()),
      key_number: customer.lt_key_slot || null,
      key_in_yard: !!customer.lt_in_yard
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/longterm/:id/payments
router.get('/:id/payments', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const ltId = parseInt(req.params.id, 10);
    if (!Number.isFinite(ltId)) return res.status(400).json({ error: 'Invalid LT id' });

    // No `active = 1` filter here — archived customers must still be able
    // to have their payment history viewed (that's the whole point of
    // archiving instead of deleting).
    const lt = await db.prepare(`
      SELECT id, contract_amount
      FROM longterm_customers
      WHERE id = ? AND carpark_id = ?
    `).get(ltId, carparkId);
    if (!lt) return res.status(404).json({ error: 'Long-term customer not found' });

    const payments = await db.prepare(`
      SELECT
        id,
        payment_date,
        amount_ex_gst,
        payment_method,
        transaction_reference,
        notes,
        payment_batch_id,
        cash_received_date,
        created_at
      FROM longterm_payments
      WHERE carpark_id = ? AND longterm_customer_id = ?
      ORDER BY payment_date DESC, created_at DESC
    `).all(carparkId, ltId);

    const paidRow = await db.prepare(`
      SELECT COALESCE(SUM(amount_ex_gst), 0) AS paid_ex_gst,
             COUNT(*) AS count
      FROM longterm_payments
      WHERE carpark_id = ? AND longterm_customer_id = ?
    `).get(carparkId, ltId);

    const contractExGst = lt.contract_amount != null && lt.contract_amount !== '' ? parseFloat(lt.contract_amount) : 0;
    const paidExGst = parseFloat(paidRow?.paid_ex_gst || 0);
    const remainingExGst = contractExGst > 0 ? Math.max(0, contractExGst - paidExGst) : 0;

    res.json({
      payments,
      displayPayments: collapsePaymentsForDisplay(payments),
      paidExGst,
      contractExGst,
      remainingExGst,
      count: paidRow?.count || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/longterm/:id/payments/suggest?amount_ex_gst=&cash_date=&months=&covers_from=
// What a payment of this size would cover, for the Add Payment form's preview
// (and its defaults). Read-only.
router.get('/:id/payments/suggest', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const ltId = parseInt(req.params.id, 10);
    const lt = await db.prepare(`
      SELECT id, contract_amount, contract_start_date, expiry_date FROM longterm_customers WHERE id = ? AND carpark_id = ?
    `).get(ltId, carparkId);
    if (!lt) return res.status(404).json({ error: 'Long-term customer not found' });

    const amt = parseFloat(req.query.amount_ex_gst);
    const cashDate = req.query.cash_date ? String(req.query.cash_date).slice(0, 10) : new Date().toISOString().slice(0, 10);
    const existingRows = await db.prepare(`
      SELECT payment_date, payment_batch_id FROM longterm_payments WHERE carpark_id = ? AND longterm_customer_id = ?
    `).all(carparkId, ltId);

    const reqMonths = parseInt(req.query.months, 10);
    const months = Number.isFinite(reqMonths) && reqMonths >= 1 ? Math.min(12, reqMonths) : suggestMonthsForPayment(lt, amt);
    const reqStart = req.query.covers_from ? String(req.query.covers_from).slice(0, 10) : null;
    const coversFrom = reqStart && isPlausibleDate(reqStart)
      ? reqStart
      : (months === 1 ? cashDate : suggestCoverageStart(lt, existingRows, cashDate));
    const monthsList = coverageMonths(coversFrom, months);
    res.json({
      months, coversFrom, monthsList,
      overlapMonths: findOverlapMonths(existingRows, monthsList),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/longterm/:id/payments/batch/:batchId/respread { covers_from, months? }
// Re-spreads an existing payment over different months (same total). For
// payments that were counted against the wrong months.
router.put('/:id/payments/batch/:batchId/respread', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const ltId = parseInt(req.params.id, 10);
    const batchId = req.params.batchId;
    if (!Number.isFinite(ltId) || !batchId) return res.status(400).json({ error: 'Invalid id' });
    const coversFrom = String(req.body?.covers_from || '').slice(0, 10);
    if (!isPlausibleDate(coversFrom)) return res.status(400).json({ error: 'A valid "covers from" date is required' });

    const current = await db.prepare(`
      SELECT payment_date, payment_batch_id FROM longterm_payments
      WHERE carpark_id = ? AND longterm_customer_id = ? AND payment_batch_id = ?
    `).all(carparkId, ltId, batchId);
    if (current.length === 0) return res.status(404).json({ error: 'Payment not found' });
    const months = Math.max(1, Math.min(12, parseInt(req.body?.months, 10) || current.length));

    const others = await db.prepare(`
      SELECT payment_date, payment_batch_id FROM longterm_payments WHERE carpark_id = ? AND longterm_customer_id = ?
    `).all(carparkId, ltId);
    const overlap = findOverlapMonths(others, coverageMonths(coversFrom, months), batchId);
    if (overlap.length && !req.body?.allow_overlap) {
      return res.status(409).json({
        error: `That would count this payment in ${overlap.join(', ')}, which another payment already covers.`,
        overlapMonths: overlap,
      });
    }

    const { userId, userName } = actorFromReq(req);
    const result = await respreadBatch(db, { carparkId, ltId, batchId, coversFrom, months, userId, userName });
    res.json({ success: true, months: result.months, spread: result.rows.map(r => ({ date: r.payment_date, amount: r.amount_ex_gst })) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/longterm/:id/payments
router.post('/:id/payments', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const ltId = parseInt(req.params.id, 10);
    if (!Number.isFinite(ltId)) return res.status(400).json({ error: 'Invalid LT id' });

    const lt = await db.prepare(`
      SELECT id, contract_amount, payment_status, contract_start_date, expiry_date
      FROM longterm_customers
      WHERE id = ? AND carpark_id = ? AND active = 1
    `).get(ltId, carparkId);
    if (!lt) return res.status(404).json({ error: 'Long-term customer not found' });

    const {
      payment_date,
      amount_ex_gst,
      payment_method,
      transaction_reference,
      notes
    } = req.body || {};

    const pDate = payment_date ? String(payment_date).slice(0, 10) : null;
    if (!pDate) return res.status(400).json({ error: 'payment_date is required (YYYY-MM-DD)' });

    const amt = parseFloat(amount_ex_gst);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'amount_ex_gst must be > 0' });

    const method = payment_method ? String(payment_method).trim() : null;
    const txRef = transaction_reference ? String(transaction_reference).trim() : null;
    const payNotes = notes ? String(notes).trim() : null;

    // Months covered and where coverage starts are explicit (the form shows
    // and lets staff change both); the defaults only apply if they're omitted.
    // A new payment starts after whatever earlier payments already cover — it
    // used to always start at the contract start, so renewals and monthly
    // payments landed on months that had already been counted.
    const existingRows = await db.prepare(`
      SELECT payment_date, payment_batch_id FROM longterm_payments WHERE carpark_id = ? AND longterm_customer_id = ?
    `).all(carparkId, ltId);
    const reqMonths = parseInt(req.body?.months, 10);
    const months = Number.isFinite(reqMonths) && reqMonths >= 1
      ? Math.min(12, reqMonths)
      : suggestMonthsForPayment(lt, amt);
    const reqStart = req.body?.covers_from ? String(req.body.covers_from).slice(0, 10) : null;
    const startDate = reqStart && isPlausibleDate(reqStart)
      ? reqStart
      : (months === 1 ? pDate : suggestCoverageStart(lt, existingRows, pDate));

    const overlap = findOverlapMonths(existingRows, coverageMonths(startDate, months));
    if (overlap.length && !req.body?.allow_overlap) {
      return res.status(409).json({
        error: `This payment would be counted in ${overlap.join(', ')}, which an earlier payment already covers.`,
        overlapMonths: overlap, coversFrom: startDate, months,
      });
    }

    const proration = buildProratedPayments({
      totalAmountExGst: amt,
      cashReceivedDate: pDate,
      contractStartDate: startDate,
      months,
      baseNotes: payNotes,
      transactionReference: txRef,
    });
    if (months === 1) proration.rows[0].payment_date = startDate;

    const insert = db.prepare(`
      INSERT INTO longterm_payments
        (carpark_id, longterm_customer_id, payment_date, amount_ex_gst, payment_method,
         transaction_reference, notes, payment_batch_id, cash_received_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const row of proration.rows) {
      await insert.run(
        carparkId, ltId, row.payment_date, row.amount_ex_gst, method, txRef,
        row.notes, row.payment_batch_id, row.cash_received_date
      );
    }

    const paidRow = await db.prepare(`
      SELECT COALESCE(SUM(amount_ex_gst), 0) AS paid_ex_gst
      FROM longterm_payments
      WHERE carpark_id = ? AND longterm_customer_id = ?
    `).get(carparkId, ltId);

    const paidExGst = parseFloat(paidRow?.paid_ex_gst || 0);
    const contractExGst = lt.contract_amount != null && lt.contract_amount !== '' ? parseFloat(lt.contract_amount) : 0;

    let nextStatus = lt.payment_status || 'Unpaid';
    if (contractExGst > 0) {
      if (paidExGst <= 0) nextStatus = 'Unpaid';
      else if (paidExGst >= contractExGst) nextStatus = 'Paid';
      else nextStatus = 'Partial';
    } else {
      nextStatus = paidExGst > 0 ? 'Partial' : 'Unpaid';
    }

    await db.prepare(`
      UPDATE longterm_customers
      SET payment_status = ?
      WHERE id = ? AND carpark_id = ?
    `).run(nextStatus, ltId, carparkId);

    const remainingExGst = contractExGst > 0 ? Math.max(0, contractExGst - paidExGst) : 0;

    const { userId, userName } = actorFromReq(req);
    await logActivity(db, {
      carparkId, tableName: 'longterm_payments', recordId: ltId, action: 'create',
      before: null,
      after: { longterm_customer_id: ltId, amount_ex_gst: amt, payment_date: pDate, payment_method: method, batchId: proration.batchId, months: proration.months },
      userId, userName,
    });

    res.json({
      success: true,
      payment_status: nextStatus,
      paidExGst,
      contractExGst,
      remainingExGst,
      prorated: proration.months > 1,
      months: proration.months,
      batchId: proration.batchId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/longterm/:id/payments/:idOrBatch
// Edits an existing payment. A single-month entry (or a legacy row from
// before batch ids existed) can have every field corrected directly — date,
// amount, method, reference. A multi-month prepay spread can only have its
// shared metadata corrected here (method, reference, when the cash actually
// came in) — NOT the total amount or the per-month date split, since
// changing the total would require re-running the proration math over
// again. That's exactly what delete-the-batch + re-add already does safely,
// so a wrong total on a spread still goes through that flow.
router.put('/:id/payments/:idOrBatch', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const ltId = parseInt(req.params.id, 10);
    const idOrBatch = req.params.idOrBatch;
    if (!Number.isFinite(ltId)) return res.status(400).json({ error: 'Invalid id' });

    const isBatch = /^ltb-/.test(idOrBatch);
    const rows = isBatch
      ? await db.prepare(`
          SELECT * FROM longterm_payments
          WHERE carpark_id = ? AND longterm_customer_id = ? AND payment_batch_id = ?
        `).all(carparkId, ltId, idOrBatch)
      : await (async () => {
          const rowId = parseInt(idOrBatch, 10);
          if (!Number.isFinite(rowId)) return [];
          const row = await db.prepare(`
            SELECT * FROM longterm_payments WHERE id = ? AND carpark_id = ? AND longterm_customer_id = ?
          `).get(rowId, carparkId, ltId);
          return row ? [row] : [];
        })();
    if (rows.length === 0) return res.status(404).json({ error: 'Payment not found' });

    const { payment_date, amount_ex_gst, payment_method, transaction_reference, notes } = req.body || {};
    const method = payment_method ? String(payment_method).trim() : null;
    const txRef = transaction_reference ? String(transaction_reference).trim() : null;
    const payNotes = notes ? String(notes).trim() : null;
    const before = rows.map(r => ({ ...r }));

    if (rows.length === 1) {
      const pDate = payment_date ? String(payment_date).slice(0, 10) : String(rows[0].payment_date).slice(0, 10);
      const amt = amount_ex_gst != null && amount_ex_gst !== '' ? parseFloat(amount_ex_gst) : parseFloat(rows[0].amount_ex_gst);
      if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'amount_ex_gst must be > 0' });
      await db.prepare(`
        UPDATE longterm_payments
        SET payment_date = ?, amount_ex_gst = ?, payment_method = ?, transaction_reference = ?, notes = ?, cash_received_date = ?
        WHERE id = ?
      `).run(pDate, amt, method, txRef, payNotes, pDate, rows[0].id);
    } else {
      const cashDate = payment_date ? String(payment_date).slice(0, 10) : null;
      for (const r of rows) {
        await db.prepare(`
          UPDATE longterm_payments
          SET payment_method = ?, transaction_reference = ?, cash_received_date = COALESCE(?, cash_received_date)
          WHERE id = ?
        `).run(method, txRef, cashDate, r.id);
      }
    }

    const paidRow = await db.prepare(`
      SELECT COALESCE(SUM(amount_ex_gst), 0) AS paid_ex_gst
      FROM longterm_payments WHERE carpark_id = ? AND longterm_customer_id = ?
    `).get(carparkId, ltId);
    const lt = await db.prepare(`SELECT contract_amount FROM longterm_customers WHERE id = ? AND carpark_id = ?`).get(ltId, carparkId);
    const paidExGst = parseFloat(paidRow?.paid_ex_gst || 0);
    const contractExGst = lt && lt.contract_amount != null && lt.contract_amount !== '' ? parseFloat(lt.contract_amount) : 0;
    let nextStatus = 'Unpaid';
    if (contractExGst > 0) {
      nextStatus = paidExGst <= 0 ? 'Unpaid' : (paidExGst >= contractExGst ? 'Paid' : 'Partial');
    } else {
      nextStatus = paidExGst > 0 ? 'Partial' : 'Unpaid';
    }
    await db.prepare(`UPDATE longterm_customers SET payment_status = ? WHERE id = ? AND carpark_id = ?`).run(nextStatus, ltId, carparkId);

    const { userId, userName } = actorFromReq(req);
    await logActivity(db, {
      carparkId, tableName: 'longterm_payments', recordId: ltId, action: 'update',
      before, after: rows.length === 1 ? { id: rows[0].id, payment_date, amount_ex_gst, payment_method: method, transaction_reference: txRef } : null,
      notes: rows.length > 1 ? 'Edited shared metadata on a prepay spread' : 'Edited payment', userId, userName,
    });

    res.json({ success: true, payment_status: nextStatus, paidExGst, editedRows: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/longterm/:id/payments/:paymentId
// Removes a single payment ROW. For a prorated batch, this only removes the
// one month/leg selected — to reverse an entire mis-entered batch, delete
// each row with the same payment_batch_id (the UI does this in one action).
router.delete('/:id/payments/:paymentId', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const ltId = parseInt(req.params.id, 10);
    const paymentId = parseInt(req.params.paymentId, 10);
    if (!Number.isFinite(ltId) || !Number.isFinite(paymentId)) return res.status(400).json({ error: 'Invalid id' });

    const row = await db.prepare(`
      SELECT * FROM longterm_payments WHERE id = ? AND carpark_id = ? AND longterm_customer_id = ?
    `).get(paymentId, carparkId, ltId);
    if (!row) return res.status(404).json({ error: 'Payment not found' });

    await db.prepare('DELETE FROM longterm_payments WHERE id = ?').run(paymentId);

    const paidRow = await db.prepare(`
      SELECT COALESCE(SUM(amount_ex_gst), 0) AS paid_ex_gst
      FROM longterm_payments WHERE carpark_id = ? AND longterm_customer_id = ?
    `).get(carparkId, ltId);
    const lt = await db.prepare(`SELECT contract_amount, payment_status FROM longterm_customers WHERE id = ? AND carpark_id = ?`).get(ltId, carparkId);
    const paidExGst = parseFloat(paidRow?.paid_ex_gst || 0);
    const contractExGst = lt && lt.contract_amount != null && lt.contract_amount !== '' ? parseFloat(lt.contract_amount) : 0;
    let nextStatus = 'Unpaid';
    if (contractExGst > 0) {
      nextStatus = paidExGst <= 0 ? 'Unpaid' : (paidExGst >= contractExGst ? 'Paid' : 'Partial');
    } else {
      nextStatus = paidExGst > 0 ? 'Partial' : 'Unpaid';
    }
    await db.prepare(`UPDATE longterm_customers SET payment_status = ? WHERE id = ? AND carpark_id = ?`).run(nextStatus, ltId, carparkId);

    const { userId, userName } = actorFromReq(req);
    await logActivity(db, {
      carparkId, tableName: 'longterm_payments', recordId: paymentId, action: 'delete',
      before: row, after: null, userId, userName,
    });

    res.json({ success: true, payment_status: nextStatus, paidExGst });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/keybox', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const ltId = parseInt(req.params.id, 10);
    const { action, key_number } = req.body || {};
    const lt = await db.prepare('SELECT id, lt_number, name, active FROM longterm_customers WHERE id = ? AND carpark_id = ?').get(ltId, carparkId);
    if (!lt || lt.active !== 1) return res.status(404).json({ error: 'Long-term customer not found' });

    if (action === 'release') {
      await db.prepare(`UPDATE longterm_customers SET lt_in_yard = 0 WHERE id = ? AND carpark_id = ?`).run(ltId, carparkId);
      return res.json({ success: true, key_number: null, key_in_yard: false });
    }

    if (action !== 'assign') return res.status(400).json({ error: 'Invalid action' });
    let kn = parseKeyNumber(key_number);
    if (kn == null) {
      const fallback = parseInt(String(lt.lt_number || '').replace(/[^0-9]/g, ''), 10);
      if (!Number.isNaN(fallback) && fallback > 0) kn = fallback;
    }
    if (kn == null) return res.status(400).json({ error: 'Key number is required' });

    const conflict = await db.prepare(`
      SELECT id, lt_number, name
      FROM longterm_customers
      WHERE carpark_id = ? AND active = 1 AND lt_key_slot = ?
      LIMIT 1
    `).get(carparkId, kn);
    if (conflict) {
      const sameLt = Number(conflict.id) === ltId;
      if (!sameLt) {
        return res.status(400).json({ error: `LT key ${kn} is already in use by ${conflict.lt_number} (${conflict.name})` });
      }
    }
    await db.prepare(`UPDATE longterm_customers SET lt_key_slot = ?, lt_in_yard = 1 WHERE id = ? AND carpark_id = ?`).run(kn, ltId, carparkId);
    res.json({ success: true, key_number: kn, key_in_yard: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    req.body = withUppercaseFields(req.body);
    const carparkId = req.session.carparkId || 1;
    const { lt_number, name, rego_1, rego_2, phone, email, rate, rate_period, contract_start_date, expiry_date, notes, contract_amount, payment_status } = req.body;
    const existing = await db.prepare('SELECT id, active FROM longterm_customers WHERE lt_number = ? AND carpark_id = ?').get(lt_number, carparkId);

    if (existing) {
      if (existing.active === 1) return res.status(400).json({ error: 'LT number already exists' });
      // Don't silently overwrite an archived customer's name/rego/etc as a
      // side effect of "creating" a new one with the same number — that
      // would misattribute their preserved payment history to whoever gets
      // typed in next. Require an explicit unarchive instead.
      return res.status(400).json({ error: `LT number ${lt_number} belongs to an archived customer. Unarchive them from the Archived list, or choose a different LT #.` });
    }

    const result = await db.prepare(`
      INSERT INTO longterm_customers
        (lt_number, name, rego_1, rego_2, phone, email, rate, rate_period, contract_start_date, expiry_date, notes, carpark_id, contract_amount, payment_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      lt_number, name, rego_1, rego_2, phone, email, normalizedMoney(rate) || 0, rate_period || 'monthly', contract_start_date || null, expiry_date || null, notes, carparkId,
      contract_amount != null && contract_amount !== '' ? parseFloat(contract_amount) : null,
      payment_status || 'Unpaid'
    );

    const customer = await db.prepare('SELECT * FROM longterm_customers WHERE id = ?').get(result.lastInsertRowid);
    const { userId, userName } = actorFromReq(req);
    await logActivity(db, { carparkId, tableName: 'longterm_customers', recordId: customer.id, action: 'create', before: null, after: customer, userId, userName });
    res.status(201).json(customer);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    req.body = withUppercaseFields(req.body);
    const {
      lt_number,
      name, rego_1, rego_2, phone, email,
      rate, rate_period, expiry_date, notes,
      contract_start_date, contract_amount, payment_status
    } = req.body;

    const carparkId = req.session.carparkId || 1;
    const ltId = parseInt(req.params.id, 10);
    if (!ltId) return res.status(400).json({ error: 'Invalid id' });

    if (lt_number != null) {
      const norm = String(lt_number).trim().toUpperCase();
      const match = /^LT\s*(\d+)$/.exec(norm);
      if (!match) return res.status(400).json({ error: 'Invalid LT # format (example: LT9)' });

      const nextLtNumber = `LT${parseInt(match[1], 10)}`;
      const conflict = await db.prepare(`
        SELECT id, active
        FROM longterm_customers
        WHERE carpark_id = ?
          AND lt_number = ?
          AND id != ?
        LIMIT 1
      `).get(carparkId, nextLtNumber, ltId);

      if (conflict && conflict.active === 1) {
        return res.status(400).json({ error: 'LT number already exists' });
      }
      if (conflict && conflict.active !== 1) {
        // An archived customer holds this number. Do NOT silently delete
        // them to free it up — that would destroy their payment history,
        // exactly what archiving is meant to prevent. Block the rename
        // instead; staff can pick a different number or unarchive/renumber
        // the archived record first.
        return res.status(400).json({ error: `LT number ${nextLtNumber} belongs to an archived customer. Unarchive or renumber them first, or choose a different LT #.` });
      }

      // Use normalized value for the update.
      req.body.lt_number = nextLtNumber;
    }
    await db.prepare(`
      UPDATE longterm_customers
      SET
        lt_number = COALESCE(?, lt_number),
        name=?, rego_1=?, rego_2=?, phone=?, email=?,
        rate=COALESCE(?, rate), rate_period=COALESCE(?, rate_period), contract_start_date=?, expiry_date=?, notes=?,
        contract_amount=?, payment_status=?
      WHERE id = ? AND carpark_id = ?
    `).run(
      req.body.lt_number,
      name, rego_1, rego_2, phone, email,
      normalizedMoney(rate), rate_period || null, contract_start_date || null, expiry_date || null, notes,
      contract_amount != null && contract_amount !== '' ? parseFloat(contract_amount) : null,
      payment_status || 'Unpaid',
      ltId, carparkId
    );

    const customer = await db.prepare('SELECT * FROM longterm_customers WHERE id = ?').get(req.params.id);
    res.json(customer);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Hard delete. Not used by the normal customer-cleanup flow anymore — use
// PATCH /:id/archive instead, which keeps the row (and its payment history)
// intact. This stays only as a last-resort admin tool for correcting a
// genuinely erroneous entry (e.g. a duplicate created by mistake, never paid).
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const before = await db.prepare('SELECT * FROM longterm_customers WHERE id = ?').get(req.params.id);
    await db.prepare('DELETE FROM longterm_customers WHERE id = ?').run(req.params.id);
    if (before) {
      const { userId, userName } = actorFromReq(req);
      await logActivity(db, { carparkId, tableName: 'longterm_customers', recordId: req.params.id, action: 'delete', before, after: null, userId, userName });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/longterm/:id/archive — soft-delete. Sets active = 0 so the
// customer drops off the active list but the row (and every
// longterm_payments row referencing it) is preserved permanently.
router.patch('/:id/archive', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const ltId = parseInt(req.params.id, 10);
    if (!Number.isFinite(ltId)) return res.status(400).json({ error: 'Invalid id' });

    const before = await db.prepare('SELECT * FROM longterm_customers WHERE id = ? AND carpark_id = ?').get(ltId, carparkId);
    if (!before) return res.status(404).json({ error: 'Not found' });

    await db.prepare('UPDATE longterm_customers SET active = 0 WHERE id = ? AND carpark_id = ?').run(ltId, carparkId);
    const after = await db.prepare('SELECT * FROM longterm_customers WHERE id = ?').get(ltId);

    const { userId, userName } = actorFromReq(req);
    await logActivity(db, { carparkId, tableName: 'longterm_customers', recordId: ltId, action: 'archive', before, after, userId, userName });

    res.json(after);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/longterm/:id/unarchive — restores an archived customer to the
// active list. Blocked if another active customer has since taken the same
// LT # (that number would need to be freed up on the other customer first).
router.patch('/:id/unarchive', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const ltId = parseInt(req.params.id, 10);
    if (!Number.isFinite(ltId)) return res.status(400).json({ error: 'Invalid id' });

    const before = await db.prepare('SELECT * FROM longterm_customers WHERE id = ? AND carpark_id = ?').get(ltId, carparkId);
    if (!before) return res.status(404).json({ error: 'Not found' });

    const conflict = await db.prepare(`
      SELECT id FROM longterm_customers WHERE carpark_id = ? AND lt_number = ? AND active = 1 AND id != ?
    `).get(carparkId, before.lt_number, ltId);
    if (conflict) {
      return res.status(400).json({ error: `LT number ${before.lt_number} is already in use by an active customer. Change their LT # before unarchiving this one.` });
    }

    await db.prepare('UPDATE longterm_customers SET active = 1 WHERE id = ? AND carpark_id = ?').run(ltId, carparkId);
    const after = await db.prepare('SELECT * FROM longterm_customers WHERE id = ?').get(ltId);

    const { userId, userName } = actorFromReq(req);
    await logActivity(db, { carparkId, tableName: 'longterm_customers', recordId: ltId, action: 'unarchive', before, after, userId, userName });

    res.json(after);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/longterm/:id/payments/batch/:batchId
// Removes an ENTIRE prorated spread (all months of a single lump-sum swipe)
// in one action — the single-row DELETE above can't touch these since a
// batch's display "id" is the batch string, not a real row id.
router.delete('/:id/payments/batch/:batchId', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const ltId = parseInt(req.params.id, 10);
    const batchId = req.params.batchId;
    if (!Number.isFinite(ltId) || !batchId) return res.status(400).json({ error: 'Invalid id' });

    const rows = await db.prepare(`
      SELECT * FROM longterm_payments WHERE carpark_id = ? AND longterm_customer_id = ? AND payment_batch_id = ?
    `).all(carparkId, ltId, batchId);
    if (rows.length === 0) return res.status(404).json({ error: 'Payment batch not found' });

    await db.prepare(`DELETE FROM longterm_payments WHERE carpark_id = ? AND longterm_customer_id = ? AND payment_batch_id = ?`)
      .run(carparkId, ltId, batchId);

    const paidRow = await db.prepare(`
      SELECT COALESCE(SUM(amount_ex_gst), 0) AS paid_ex_gst
      FROM longterm_payments WHERE carpark_id = ? AND longterm_customer_id = ?
    `).get(carparkId, ltId);
    const lt = await db.prepare(`SELECT contract_amount FROM longterm_customers WHERE id = ? AND carpark_id = ?`).get(ltId, carparkId);
    const paidExGst = parseFloat(paidRow?.paid_ex_gst || 0);
    const contractExGst = lt && lt.contract_amount != null && lt.contract_amount !== '' ? parseFloat(lt.contract_amount) : 0;
    let nextStatus = 'Unpaid';
    if (contractExGst > 0) {
      nextStatus = paidExGst <= 0 ? 'Unpaid' : (paidExGst >= contractExGst ? 'Paid' : 'Partial');
    } else {
      nextStatus = paidExGst > 0 ? 'Partial' : 'Unpaid';
    }
    await db.prepare(`UPDATE longterm_customers SET payment_status = ? WHERE id = ? AND carpark_id = ?`).run(nextStatus, ltId, carparkId);

    const { userId, userName } = actorFromReq(req);
    await logActivity(db, {
      carparkId, tableName: 'longterm_payments', recordId: ltId, action: 'delete_batch',
      before: { batchId, rows }, after: null,
      notes: `Deleted entire ${rows.length}-month prepay spread (batch ${batchId})`,
      userId, userName,
    });

    res.json({ success: true, payment_status: nextStatus, paidExGst, deletedCount: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
