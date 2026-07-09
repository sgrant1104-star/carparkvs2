const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { EFFECTIVE_PAY1_DAY, EFFECTIVE_PAY2_DAY } = require('../utils/invoicePaymentDates');
const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { from, to } = req.query;
    const today = new Date().toISOString().split('T')[0];
    const fromDate = from || new Date(new Date().setDate(1)).toISOString().split('T')[0];
    const toDate = to || today;
    const records = await db.prepare(`SELECT b.*, u.name as staff_name FROM banking b LEFT JOIN users u ON b.staff_id = u.id WHERE b.carpark_id = ? AND b.date >= ? AND b.date <= ? ORDER BY b.date DESC`).all(carparkId, fromDate, toDate);
    const summary = await db.prepare(`SELECT COALESCE(SUM(eftpos_total),0) as eftpos, COALESCE(SUM(cash_total),0) as cash, COALESCE(SUM(account_total),0) as account, COALESCE(SUM(other_total),0) as other FROM banking WHERE carpark_id = ? AND date >= ? AND date <= ?`).get(carparkId, fromDate, toDate);
    res.json({ records, summary, fromDate, toDate });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { date, eftpos_total, cash_total, account_total, other_total, notes } = req.body;
    const d = date || new Date().toISOString().split('T')[0];
    const existing = await db.prepare('SELECT id FROM banking WHERE carpark_id = ? AND date = ?').get(carparkId, d);
    if (existing) {
      await db.prepare(`UPDATE banking SET eftpos_total=?, cash_total=?, account_total=?, other_total=?, notes=?, staff_id=? WHERE id=?`)
        .run(eftpos_total || 0, cash_total || 0, account_total || 0, other_total || 0, notes, req.session.userId, existing.id);
      const record = await db.prepare('SELECT * FROM banking WHERE id = ?').get(existing.id);
      return res.json(record);
    }
    const result = await db.prepare(`INSERT INTO banking (carpark_id, date, eftpos_total, cash_total, account_total, other_total, notes, staff_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(carparkId, d, eftpos_total || 0, cash_total || 0, account_total || 0, other_total || 0, notes, req.session.userId);
    const record = await db.prepare('SELECT * FROM banking WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(record);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/banking/autofill?date=YYYY-MM-DD
// Builds banking fields from invoice payment lines posted on the selected date.
// payment_date_1/payment_date_2 are set when a "To Pay" line becomes a real payment.
router.get('/autofill', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const rows = await db.prepare(`
      SELECT
        paid_status, payment_amount, payment_date_1, date_in,
        paid_status_2, payment_amount_2, payment_date_2
      FROM invoices
      WHERE carpark_id = ? AND void = 0
        AND (
          (${EFFECTIVE_PAY1_DAY}) = ?
          OR ((${EFFECTIVE_PAY2_DAY}) IS NOT NULL AND (${EFFECTIVE_PAY2_DAY}) = ?)
        )
    `).all(carparkId, date, date);

    let eftpos = 0;
    let cash = 0;
    let account = 0;
    let other = 0;
    let creditRedeemed = 0;

    const addByStatus = (statusRaw, amountRaw) => {
      const status = String(statusRaw || '').trim();
      const amount = parseFloat(amountRaw || 0) || 0;
      if (amount <= 0) return;
      if (status === 'Eftpos') eftpos += amount;
      else if (status === 'Cash') cash += amount;
      else if (status === 'OnAcc') account += amount;
      else if (status === 'Internet Banking') other += amount;
      // Customer Credit isn't physical money received today — it's value the
      // customer already paid for on an earlier visit. Track separately so
      // it doesn't inflate what actually needs to go to the bank/till.
      else if (status === 'Customer Credit') creditRedeemed += amount;
      else if (status && status !== 'To Pay') other += amount;
    };

    const day = String(date).trim();
    const eff1 = (r) => {
      const p = String(r.payment_date_1 || '').trim().slice(0, 10);
      if (p) return p;
      return String(r.date_in || '').trim().slice(0, 10);
    };
    const eff2 = (r) => {
      const a2 = parseFloat(r.payment_amount_2 || 0) || 0;
      const s2 = String(r.paid_status_2 || '').trim();
      if (a2 <= 0 || !s2 || s2 === 'To Pay') return '';
      const p = String(r.payment_date_2 || '').trim().slice(0, 10);
      if (p) return p;
      return String(r.date_in || '').trim().slice(0, 10);
    };
    for (const r of rows) {
      if (eff1(r) === day) addByStatus(r.paid_status, r.payment_amount);
      if (eff2(r) === day) addByStatus(r.paid_status_2, r.payment_amount_2);
    }

    // Long-term prepayments — attribute by cash_received_date (the day the money
    // actually arrived), NOT payment_date (which may be a future recognition
    // month for prorated prepays). Without this, LT cash never showed up here.
    const ltRows = await db.prepare(`
      SELECT payment_method, amount_ex_gst, cash_received_date, payment_date
      FROM longterm_payments
      WHERE carpark_id = ?
        AND substr(trim(COALESCE(NULLIF(trim(cash_received_date), ''), payment_date)), 1, 10) = ?
    `).all(carparkId, day);
    for (const r of ltRows) addByStatus(r.payment_method, r.amount_ex_gst);

    // Account-customer payments — attribute by payment_date.
    const acctRows = await db.prepare(`
      SELECT payment_method, amount, payment_date
      FROM account_payments
      WHERE carpark_id = ? AND substr(trim(COALESCE(payment_date, '')), 1, 10) = ?
    `).all(carparkId, day);
    for (const r of acctRows) addByStatus(r.payment_method, r.amount);

    const round2 = (n) => Math.round((n || 0) * 100) / 100;
    res.json({
      date,
      eftpos: round2(eftpos),
      cash: round2(cash),
      account: round2(account),
      other: round2(other),
      creditRedeemed: round2(creditRedeemed),
      total: round2(eftpos + cash + account + other)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/petty-cash', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { from, to } = req.query;
    const today = new Date().toISOString().split('T')[0];
    const fromDate = from || new Date(new Date().setDate(1)).toISOString().split('T')[0];
    const toDate = to || today;
    const records = await db.prepare(`SELECT pc.*, u.name as staff_name FROM petty_cash pc LEFT JOIN users u ON pc.staff_id = u.id WHERE pc.carpark_id = ? AND pc.date >= ? AND pc.date <= ? ORDER BY pc.date DESC, pc.id DESC`).all(carparkId, fromDate, toDate);
    const summary = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END), 0) as income, COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END), 0) as expense FROM petty_cash WHERE carpark_id = ? AND date >= ? AND date <= ?`).get(carparkId, fromDate, toDate);
    res.json({ records, summary, fromDate, toDate });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/petty-cash', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { date, description, amount, type, category } = req.body;
    const result = await db.prepare(`INSERT INTO petty_cash (carpark_id, date, description, amount, type, category, staff_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(carparkId, date || new Date().toISOString().split('T')[0], description, amount, type, category, req.session.userId);
    const record = await db.prepare('SELECT * FROM petty_cash WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(record);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/petty-cash/:id', requireAuth, async (req, res) => {
  try {
    await db.prepare('DELETE FROM petty_cash WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
