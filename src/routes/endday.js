const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { businessDateYmd } = require('../utils/businessDate');
const { EFFECTIVE_PAY1_DAY, EFFECTIVE_PAY2_DAY } = require('../utils/invoicePaymentDates');
const { getEftposReconciliation, buildVarianceReport, findMismatchSuspects } = require('../utils/eftposReconciliation');
const { logActivity, actorFromReq } = require('../utils/audit');
const router = express.Router();

async function ensureEndDayInternetColumn() {
  try {
    await db.prepare(`ALTER TABLE end_day ADD COLUMN internet_banking_total REAL DEFAULT 0`).run();
  } catch (_) {
    // Column already exists (or migration already applied).
  }
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const today = req.query.date || businessDateYmd();
    const stats = await db.prepare(`
      SELECT
        COUNT(CASE WHEN DATE(date_in) = ? THEN 1 END) as cars_in,
        COUNT(CASE WHEN DATE(return_date) = ? AND picked_up != 'Car In Yard' THEN 1 END) as cars_out,
        COALESCE(SUM(
          COALESCE(CASE WHEN (${EFFECTIVE_PAY1_DAY}) = ? AND paid_status = 'Eftpos' THEN payment_amount ELSE 0 END, 0) +
          COALESCE(CASE WHEN (${EFFECTIVE_PAY2_DAY}) IS NOT NULL AND (${EFFECTIVE_PAY2_DAY}) = ? AND paid_status_2 = 'Eftpos' THEN payment_amount_2 ELSE 0 END, 0)
        ), 0) as eftpos,
        COALESCE(SUM(
          COALESCE(CASE WHEN (${EFFECTIVE_PAY1_DAY}) = ? AND paid_status = 'Cash' THEN payment_amount ELSE 0 END, 0) +
          COALESCE(CASE WHEN (${EFFECTIVE_PAY2_DAY}) IS NOT NULL AND (${EFFECTIVE_PAY2_DAY}) = ? AND paid_status_2 = 'Cash' THEN payment_amount_2 ELSE 0 END, 0)
        ), 0) as cash,
        COALESCE(SUM(
          COALESCE(CASE WHEN (${EFFECTIVE_PAY1_DAY}) = ? AND paid_status = 'OnAcc' THEN payment_amount ELSE 0 END, 0) +
          COALESCE(CASE WHEN (${EFFECTIVE_PAY2_DAY}) IS NOT NULL AND (${EFFECTIVE_PAY2_DAY}) = ? AND paid_status_2 = 'OnAcc' THEN payment_amount_2 ELSE 0 END, 0)
        ), 0) as on_account,
        COALESCE(SUM(
          COALESCE(CASE WHEN (${EFFECTIVE_PAY1_DAY}) = ? AND paid_status = 'Internet Banking' THEN payment_amount ELSE 0 END, 0) +
          COALESCE(CASE WHEN (${EFFECTIVE_PAY2_DAY}) IS NOT NULL AND (${EFFECTIVE_PAY2_DAY}) = ? AND paid_status_2 = 'Internet Banking' THEN payment_amount_2 ELSE 0 END, 0)
        ), 0) as internet_banking,
        COALESCE(SUM(
          COALESCE(CASE WHEN (${EFFECTIVE_PAY1_DAY}) = ? AND paid_status = 'Customer Credit' THEN payment_amount ELSE 0 END, 0) +
          COALESCE(CASE WHEN (${EFFECTIVE_PAY2_DAY}) IS NOT NULL AND (${EFFECTIVE_PAY2_DAY}) = ? AND paid_status_2 = 'Customer Credit' THEN payment_amount_2 ELSE 0 END, 0)
        ), 0) as credit_redeemed,
        COALESCE(SUM(
          COALESCE(CASE WHEN (${EFFECTIVE_PAY1_DAY}) = ? AND paid_status != 'To Pay' THEN payment_amount ELSE 0 END, 0) +
          COALESCE(CASE WHEN (${EFFECTIVE_PAY2_DAY}) IS NOT NULL AND (${EFFECTIVE_PAY2_DAY}) = ? AND paid_status_2 != 'To Pay' THEN payment_amount_2 ELSE 0 END, 0)
        ), 0) as total_revenue
      FROM invoices WHERE carpark_id = ? AND void = 0
    `).get(today, today, today, today, today, today, today, today, today, today, today, today, today, today, carparkId);
    const carsInYard   = await db.prepare(`SELECT COUNT(*) as count FROM invoices WHERE carpark_id = ? AND void = 0 AND picked_up = 'Car In Yard'`).get(carparkId);
    const invoices     = await db.prepare(`SELECT i.*, u.name as staff_name FROM invoices i LEFT JOIN users u ON i.staff_id = u.id WHERE i.carpark_id = ? AND DATE(i.date_in) = ? AND i.void = 0 ORDER BY i.time_in`).all(carparkId, today);
    const returningToday = await db.prepare(`
      SELECT i.*, u.name as staff_name FROM invoices i
      LEFT JOIN users u ON i.staff_id = u.id
      WHERE i.carpark_id = ? AND DATE(i.return_date) = ? AND i.void = 0
        AND (i.picked_up IS NULL OR i.picked_up = '' OR i.picked_up = 'Car In Yard')
      ORDER BY i.return_time
    `).all(carparkId, today);
    const record       = await db.prepare('SELECT * FROM end_day WHERE carpark_id = ? AND date = ?').get(carparkId, today);

    const reconciliation = await getEftposReconciliation(db, { carparkId, date: today });
    const savedMachineTotal = record && record.eftpos_machine_total != null ? parseFloat(record.eftpos_machine_total) : null;
    const eftposCheck = buildVarianceReport(reconciliation, savedMachineTotal);
    const suspects = eftposCheck.matched === false ? await findMismatchSuspects(db, { carparkId, date: today }) : null;

    res.json({
      date: today,
      stats: { ...stats, cars_in_yard: carsInYard.count || 0 },
      invoices,
      returningToday,
      record,
      eftposReconciliation: { ...reconciliation, ...eftposCheck, suspects },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/endday/eftpos-reconciliation?date=YYYY-MM-DD&machine_total=123.45
// Ad-hoc check (doesn't require saving the end-of-day record first).
router.get('/eftpos-reconciliation', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const date = req.query.date || businessDateYmd();
    const machineTotalRaw = req.query.machine_total;
    const machineTotal = machineTotalRaw != null && machineTotalRaw !== '' ? parseFloat(machineTotalRaw) : null;

    const reconciliation = await getEftposReconciliation(db, { carparkId, date });
    const check = buildVarianceReport(reconciliation, Number.isFinite(machineTotal) ? machineTotal : null);
    const suspects = check.matched === false ? await findMismatchSuspects(db, { carparkId, date }) : null;
    res.json({ ...reconciliation, ...check, suspects });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { date, notes, eftpos_machine_total } = req.body;
    const today = date || businessDateYmd();
    await ensureEndDayInternetColumn();
    const stats = await db.prepare(`
      SELECT
        COUNT(CASE WHEN DATE(date_in) = ? THEN 1 END) as cars_in,
        COALESCE(SUM(
          COALESCE(CASE WHEN (${EFFECTIVE_PAY1_DAY}) = ? AND paid_status != 'To Pay' THEN payment_amount ELSE 0 END, 0) +
          COALESCE(CASE WHEN (${EFFECTIVE_PAY2_DAY}) IS NOT NULL AND (${EFFECTIVE_PAY2_DAY}) = ? AND paid_status_2 != 'To Pay' THEN payment_amount_2 ELSE 0 END, 0)
        ), 0) as total_revenue,
        COALESCE(SUM(
          COALESCE(CASE WHEN (${EFFECTIVE_PAY1_DAY}) = ? AND paid_status = 'Eftpos' THEN payment_amount ELSE 0 END, 0) +
          COALESCE(CASE WHEN (${EFFECTIVE_PAY2_DAY}) IS NOT NULL AND (${EFFECTIVE_PAY2_DAY}) = ? AND paid_status_2 = 'Eftpos' THEN payment_amount_2 ELSE 0 END, 0)
        ), 0) as eftpos,
        COALESCE(SUM(
          COALESCE(CASE WHEN (${EFFECTIVE_PAY1_DAY}) = ? AND paid_status = 'Cash' THEN payment_amount ELSE 0 END, 0) +
          COALESCE(CASE WHEN (${EFFECTIVE_PAY2_DAY}) IS NOT NULL AND (${EFFECTIVE_PAY2_DAY}) = ? AND paid_status_2 = 'Cash' THEN payment_amount_2 ELSE 0 END, 0)
        ), 0) as cash,
        COALESCE(SUM(
          COALESCE(CASE WHEN (${EFFECTIVE_PAY1_DAY}) = ? AND paid_status = 'OnAcc' THEN payment_amount ELSE 0 END, 0) +
          COALESCE(CASE WHEN (${EFFECTIVE_PAY2_DAY}) IS NOT NULL AND (${EFFECTIVE_PAY2_DAY}) = ? AND paid_status_2 = 'OnAcc' THEN payment_amount_2 ELSE 0 END, 0)
        ), 0) as on_account,
        COALESCE(SUM(
          COALESCE(CASE WHEN (${EFFECTIVE_PAY1_DAY}) = ? AND paid_status = 'Internet Banking' THEN payment_amount ELSE 0 END, 0) +
          COALESCE(CASE WHEN (${EFFECTIVE_PAY2_DAY}) IS NOT NULL AND (${EFFECTIVE_PAY2_DAY}) = ? AND paid_status_2 = 'Internet Banking' THEN payment_amount_2 ELSE 0 END, 0)
        ), 0) as internet_banking,
        COALESCE(SUM(
          COALESCE(CASE WHEN (${EFFECTIVE_PAY1_DAY}) = ? AND paid_status = 'Customer Credit' THEN payment_amount ELSE 0 END, 0) +
          COALESCE(CASE WHEN (${EFFECTIVE_PAY2_DAY}) IS NOT NULL AND (${EFFECTIVE_PAY2_DAY}) = ? AND paid_status_2 = 'Customer Credit' THEN payment_amount_2 ELSE 0 END, 0)
        ), 0) as credit_redeemed
      FROM invoices WHERE carpark_id = ? AND void = 0
    `).get(today, today, today, today, today, today, today, today, today, today, today, today, today, carparkId);
    const carsInYard = await db.prepare(`SELECT COUNT(*) as count FROM invoices WHERE carpark_id = ? AND void = 0 AND picked_up = 'Car In Yard'`).get(carparkId);

    const reconciliation = await getEftposReconciliation(db, { carparkId, date: today });
    const existing = await db.prepare('SELECT * FROM end_day WHERE carpark_id = ? AND date = ?').get(carparkId, today);

    const submittedMachineTotal = eftpos_machine_total != null && eftpos_machine_total !== ''
      ? parseFloat(eftpos_machine_total) : null;
    // If this save didn't include a new terminal figure, keep whatever was
    // already checked/saved for this date instead of silently wiping it —
    // e.g. revisiting later just to add a note shouldn't erase an already-
    // confirmed match. To genuinely clear a check, re-enter a value (even
    // the same one) rather than leaving the field blank.
    const machineTotal = Number.isFinite(submittedMachineTotal)
      ? submittedMachineTotal
      : (existing && existing.eftpos_machine_total != null ? parseFloat(existing.eftpos_machine_total) : null);

    const eftposCheck = buildVarianceReport(reconciliation, Number.isFinite(machineTotal) ? machineTotal : null);

    const variance = eftposCheck.variance;
    const variance_notes = eftposCheck.matched === false ? eftposCheck.warnings.join(' ') : null;

    if (existing) {
      await db.prepare(`UPDATE end_day SET total_revenue=?, cars_in=?, cars_in_yard=?, eftpos_total=?, cash_total=?, account_total=?, internet_banking_total=?, credit_redeemed_total=?, notes=?, staff_id=?, eftpos_machine_total=?, eftpos_variance=?, eftpos_variance_notes=? WHERE id=?`)
        .run(stats.total_revenue, stats.cars_in, carsInYard.count || 0, stats.eftpos, stats.cash, stats.on_account, stats.internet_banking, stats.credit_redeemed, notes, req.session.userId, machineTotal, variance, variance_notes, existing.id);
    } else {
      await db.prepare(`INSERT INTO end_day (carpark_id, date, total_revenue, cars_in, cars_in_yard, eftpos_total, cash_total, account_total, internet_banking_total, credit_redeemed_total, notes, staff_id, eftpos_machine_total, eftpos_variance, eftpos_variance_notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(carparkId, today, stats.total_revenue, stats.cars_in, carsInYard.count || 0, stats.eftpos, stats.cash, stats.on_account, stats.internet_banking, stats.credit_redeemed, notes, req.session.userId, machineTotal, variance, variance_notes);
    }

    if (eftposCheck.matched === false) {
      const { userId, userName } = actorFromReq(req);
      await logActivity(db, {
        carparkId, tableName: 'end_day', recordId: existing ? existing.id : null, action: 'eftpos_variance',
        before: null,
        after: { date: today, expected: eftposCheck.expected, machine: eftposCheck.machine, variance },
        notes: variance_notes, userId, userName,
      });
    }

    res.json({ success: true, stats, eftposReconciliation: { ...reconciliation, ...eftposCheck, suspects: eftposCheck.matched === false ? await findMismatchSuspects(db, { carparkId, date: today }) : null } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/history', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const records = await db.prepare(`SELECT ed.*, u.name as staff_name FROM end_day ed LEFT JOIN users u ON ed.staff_id = u.id WHERE ed.carpark_id = ? ORDER BY ed.date DESC LIMIT 30`).all(carparkId);
    res.json(records);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
