const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { parseKeyNumber } = require('../utils/keyBoxSync');
const {
  inferContractMonths,
  buildProratedPayments,
  collapsePaymentsForDisplay,
} = require('../utils/longtermProration');
const { logActivity, actorFromReq } = require('../utils/audit');
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
    const customers = await db.prepare(`
      SELECT * FROM longterm_customers WHERE carpark_id = ? AND active = 1
      ORDER BY CAST(REPLACE(lt_number, 'LT', '') AS INTEGER)
    `).all(carparkId);
    res.json(customers.map(c => withRenewalStatus(c, today)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/next-number', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    // Pick the smallest missing LT number among ACTIVE customers.
    // This ensures:
    // - Empty list => LT1
    // - If LT5 is deleted from the middle => next add uses LT5 again
    // - Easy + safe: no mass-renumbering of existing records required
    const rows = await db.prepare(`
      SELECT lt_number
      FROM longterm_customers
      WHERE carpark_id = ? AND active = 1
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

    const lt = await db.prepare(`
      SELECT id, contract_amount
      FROM longterm_customers
      WHERE id = ? AND carpark_id = ? AND active = 1
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

    const months = inferContractMonths(lt, amt);
    const startDate = lt.contract_start_date
      ? String(lt.contract_start_date).slice(0, 10)
      : pDate;
    const proration = buildProratedPayments({
      totalAmountExGst: amt,
      cashReceivedDate: pDate,
      contractStartDate: startDate,
      months,
      baseNotes: payNotes,
      transactionReference: txRef,
    });

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
    const carparkId = req.session.carparkId || 1;
    const { lt_number, name, rego_1, rego_2, phone, email, rate, rate_period, contract_start_date, expiry_date, notes, contract_amount, payment_status } = req.body;
    const existing = await db.prepare('SELECT id, active FROM longterm_customers WHERE lt_number = ? AND carpark_id = ?').get(lt_number, carparkId);

    // If the LT exists but is inactive, reuse the same LT# by reactivating it.
    // This is required because `lt_number` is UNIQUE in the DB schema.
    if (existing) {
      if (existing.active === 1) return res.status(400).json({ error: 'LT number already exists' });

      await db.prepare(`
        UPDATE longterm_customers
        SET active = 1, name=?, rego_1=?, rego_2=?, phone=?, email=?, rate=?, rate_period=?, expiry_date=?, notes=?,
            contract_start_date=?, contract_amount=?, payment_status=?
        WHERE id = ?
      `).run(
        name, rego_1, rego_2, phone, email,
        normalizedMoney(rate) || 0, rate_period || 'monthly', expiry_date || null, notes,
        contract_start_date || null,
        contract_amount != null && contract_amount !== '' ? parseFloat(contract_amount) : null,
        payment_status || 'Unpaid',
        existing.id
      );

      const customer = await db.prepare('SELECT * FROM longterm_customers WHERE id = ?').get(existing.id);
      return res.json(customer);
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
        // If there is a non-active row holding the number, remove it to free the unique constraint.
        await db.prepare('DELETE FROM longterm_customers WHERE id = ? AND carpark_id = ?').run(conflict.id, carparkId);
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

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const before = await db.prepare('SELECT * FROM longterm_customers WHERE id = ?').get(req.params.id);
    // Hard delete so `lt_number` (UNIQUE) is actually free to reuse.
    // Soft-delete would keep the lt_number occupied and block "next" numbering.
    await db.prepare('DELETE FROM longterm_customers WHERE id = ?').run(req.params.id);
    if (before) {
      const { userId, userName } = actorFromReq(req);
      await logActivity(db, { carparkId, tableName: 'longterm_customers', recordId: req.params.id, action: 'delete', before, after: null, userId, userName });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
