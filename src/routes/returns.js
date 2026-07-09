const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { businessDateYmd } = require('../utils/businessDate');
const { syncKeyBoxForPickedUp } = require('../utils/keyBoxSync');
const { checkAndCreateEarlyReturnCredit } = require('../utils/customerCredit');
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

router.post('/:id/pickup', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { picked_up } = req.body;
    const carparkId = req.session.carparkId || 1;
    const invoice = await db.prepare('SELECT * FROM invoices WHERE id = ? AND carpark_id = ?').get(id, carparkId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    const final = picked_up || 'Picked Up';
    await db.prepare("UPDATE invoices SET picked_up = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(final, id);
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

    res.json({ success: true, credit });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
