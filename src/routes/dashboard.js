const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { businessDateYmd, addCalendarDaysYmd } = require('../utils/businessDate');
const { sumBothLinesInRange, L1_PAID_TOTAL, L2_PAID_TOTAL } = require('../utils/invoicePaymentDates');
const router = express.Router();

// GET /api/dashboard/stats
router.get('/stats', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const carparkId = req.session.carparkId || 1;
    const today = businessDateYmd();
    const firstOfMonth = today.substring(0, 8) + '01';

    const carsInYard     = await db.prepare(`SELECT COUNT(*) as count FROM invoices WHERE carpark_id = ? AND void = 0 AND picked_up = 'Car In Yard'`).get(carparkId);
    const invDay = `substr(trim(COALESCE(date_in,'')), 1, 10)`;
    const invRevenueToday = await db.prepare(`
      SELECT (${sumBothLinesInRange(L1_PAID_TOTAL, L2_PAID_TOTAL)}) AS total
      FROM invoices WHERE carpark_id = ? AND void = 0
    `).get(today, today, today, today, carparkId);
    const invRevenueMonth = await db.prepare(`
      SELECT (${sumBothLinesInRange(L1_PAID_TOTAL, L2_PAID_TOTAL)}) AS total
      FROM invoices WHERE carpark_id = ? AND void = 0
    `).get(firstOfMonth, today, firstOfMonth, today, carparkId);
    // Long-term payments are stored ex GST; dashboard revenue is shown inc GST (same as invoice totals).
    const ltDay = `substr(trim(COALESCE(payment_date,'')), 1, 10)`;
    const ltRevenueToday  = await db.prepare(`SELECT COALESCE(SUM(amount_ex_gst * 1.15), 0) as total FROM longterm_payments WHERE carpark_id = ? AND ${ltDay} = ?`).get(carparkId, today);
    const ltRevenueMonth  = await db.prepare(`SELECT COALESCE(SUM(amount_ex_gst * 1.15), 0) as total FROM longterm_payments WHERE carpark_id = ? AND ${ltDay} >= ?`).get(carparkId, firstOfMonth);
    const revenueTodayTotal = (invRevenueToday.total || 0) + (ltRevenueToday.total || 0);
    const revenueMonthTotal = (invRevenueMonth.total || 0) + (ltRevenueMonth.total || 0);
    const carpark        = await db.prepare('SELECT capacity FROM carparks WHERE id = ?').get(carparkId);
    const carparkCapacity = carpark ? carpark.capacity : 100;
    // Short-term occupancy: same basis as Key Box — standard slots only (not LT), % = in_use / total slots
    const keyBoxFilter = `carpark_id = ? AND COALESCE(holder_type,'standard') != 'longterm'`;
    const keySlotsRow   = await db.prepare(`SELECT COUNT(*) as count FROM key_box WHERE ${keyBoxFilter}`).get(carparkId);
    const keysInUseRow  = await db.prepare(`SELECT COUNT(*) as count FROM key_box WHERE ${keyBoxFilter} AND status = 'in_use'`).get(carparkId);
    const totalSlots    = keySlotsRow.count || 0;
    const inUseSlots    = keysInUseRow.count || 0;
    // One decimal so e.g. 3/60 (5.0%) vs 3/64 (4.7%) don’t look identical after adding keys
    const occupancyRate = totalSlots > 0
      ? Math.min(100, Math.round((inUseSlots / totalSlots) * 1000) / 10)
      : 0;
    const carsInToday    = await db.prepare(`SELECT COUNT(*) as count FROM invoices WHERE carpark_id = ? AND ${invDay} = ? AND void = 0`).get(carparkId, today);
    // Cars still to collect today (matches Returns page — excludes picked up)
    const carsReturnToday= await db.prepare(`
      SELECT COUNT(*) as count FROM invoices
      WHERE carpark_id = ? AND DATE(return_date) = ? AND void = 0
        AND (picked_up IS NULL OR picked_up = '' OR picked_up = 'Car In Yard')
    `).get(carparkId, today);
    const revenueByMethod= await db.prepare(`SELECT paid_status, COALESCE(SUM(payment_amount), 0) as total FROM invoices WHERE carpark_id = ? AND ${invDay} >= ? AND void = 0 GROUP BY paid_status`).all(carparkId, firstOfMonth);
    // Add long-term revenue into the breakdown so the chart matches the month total.
    if ((ltRevenueMonth.total || 0) > 0) {
      revenueByMethod.push({ paid_status: 'LongTerm', total: ltRevenueMonth.total });
    }
    const recentInvoices = await db.prepare(`SELECT i.*, u.name as staff_name FROM invoices i LEFT JOIN users u ON i.staff_id = u.id WHERE i.carpark_id = ? AND i.void = 0 ORDER BY i.created_at DESC LIMIT 10`).all(carparkId);
    const onAccountBalance = await db.prepare(`SELECT COALESCE(SUM(payment_amount), 0) as total FROM invoices WHERE carpark_id = ? AND paid_status = 'OnAcc' AND void = 0`).get(carparkId);
    const availableKeys  = await db.prepare(`SELECT COUNT(*) as count FROM key_box WHERE carpark_id = ? AND status = 'available'`).get(carparkId);

    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const dateStr = addCalendarDaysYmd(today, -i);
      const invRev = await db.prepare(`
        SELECT (${sumBothLinesInRange(L1_PAID_TOTAL, L2_PAID_TOTAL)}) AS total
        FROM invoices WHERE carpark_id = ? AND void = 0
      `).get(dateStr, dateStr, dateStr, dateStr, carparkId);
      const ltRev  = await db.prepare(`SELECT COALESCE(SUM(amount_ex_gst * 1.15), 0) as total FROM longterm_payments WHERE carpark_id = ? AND ${ltDay} = ?`).get(carparkId, dateStr);
      last7Days.push({ date: dateStr, total: (invRev.total || 0) + (ltRev.total || 0) });
    }

    res.json({
      businessDate: today,
      carsInYard: carsInYard.count || 0,
      carparkCapacity,
      keySlotsTotal: totalSlots,
      keysInUse: inUseSlots,
      // legacy: occupancy denominator is now key slots (same as Key Box total), not carpark.capacity
      capacity: totalSlots,
      occupancyRate,
      revenueToday: revenueTodayTotal, revenueMonth: revenueMonthTotal,
      carsInToday: carsInToday.count || 0, carsReturnToday: carsReturnToday.count || 0,
      revenueByMethod, recentInvoices, last7Days,
      onAccountBalance: onAccountBalance.total || 0, availableKeys: availableKeys.count || 0
    });
  } catch (err) {
    console.error('Dashboard stats error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// GET /api/dashboard/carpark-info
router.get('/carpark-info', requireAuth, async (req, res) => {
  try {
    const carpark = await db.prepare('SELECT * FROM carparks WHERE id = ?').get(req.session.carparkId || 1);
    res.json(carpark || {});
  } catch (err) {
    res.status(500).json({ error: 'Failed to load carpark info' });
  }
});

module.exports = router;
