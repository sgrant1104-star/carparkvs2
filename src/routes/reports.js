const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { businessDateYmd } = require('../utils/businessDate');
const {
  invDay,
  effectivePay1Day,
  effectivePay2Day,
  l1PaidTotal,
  l2PaidTotal,
  l1Eftpos,
  l2Eftpos,
  l1Cash,
  l2Cash,
  l1OnAcc,
  l2OnAcc,
  sumBothLinesInRange,
  EFFECTIVE_PAY1_DAY,
  EFFECTIVE_PAY2_DAY,
  L1_PAID_TOTAL,
  L2_PAID_TOTAL,
  L1_EFTPOS,
  L2_EFTPOS,
  L1_CASH,
  L2_CASH,
  L1_ONACC,
  L2_ONACC,
} = require('../utils/invoicePaymentDates');
const PDFDocument = require('pdfkit');
const router = express.Router();

// Calendar date from stored values (handles YYYY-MM-DD and ISO timestamps; avoids SQLite DATE() quirks on some rows)
const INV_DAY = invDay();
const RET_DAY = `substr(trim(COALESCE(return_date,'')), 1, 10)`;
const LT_DAY = `substr(trim(COALESCE(payment_date,'')), 1, 10)`;
const INV_MONTH = `substr(trim(COALESCE(date_in,'')), 1, 7)`;
const LT_MONTH = `substr(trim(COALESCE(payment_date,'')), 1, 7)`;

/** Paid invoice lines in date range (payment / settlement day), for matching EFTPOS terminal totals. */
function sqlPaidLinesUnion() {
  const E1 = effectivePay1Day('i');
  const E2 = effectivePay2Day('i');
  return `
  SELECT i.id AS invoice_id,
    ${E1} AS d,
    ${l1PaidTotal('i')} AS line_total,
    ${l1Eftpos('i')} AS line_eftpos,
    ${l1Cash('i')} AS line_cash,
    ${l1OnAcc('i')} AS line_onacc
  FROM invoices i
  WHERE i.carpark_id = ? AND i.void = 0
  AND (${E1}) >= ? AND (${E1}) <= ?
  UNION ALL
  SELECT i.id,
    ${E2},
    ${l2PaidTotal('i')},
    ${l2Eftpos('i')},
    ${l2Cash('i')},
    ${l2OnAcc('i')}
  FROM invoices i
  WHERE i.carpark_id = ? AND i.void = 0
  AND (${E2}) IS NOT NULL
  AND (${E2}) >= ? AND (${E2}) <= ?
  `;
}

router.get('/revenue', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { from, to, group_by } = req.query;
    const today = businessDateYmd();
    const firstOfMonth = today.substring(0, 8) + '01';
    const fromDate = from || firstOfMonth;
    const toDate   = to || today;
    let groupExprLt  = LT_DAY;
    if (group_by === 'week')  { groupExprLt = "strftime('%Y-W%W', payment_date)"; }
    else if (group_by === 'month') { groupExprLt = LT_MONTH; }

    let groupPaidPeriod = 'u.d';
    if (group_by === 'week') groupPaidPeriod = `strftime('%Y-W%W', u.d)`;
    else if (group_by === 'month') groupPaidPeriod = `substr(u.d, 1, 7)`;

    let groupExprOut = INV_DAY;
    if (group_by === 'week') groupExprOut = "strftime('%Y-W%W', date_in)";
    else if (group_by === 'month') groupExprOut = INV_MONTH;

    const unionSql = sqlPaidLinesUnion();
    const invPaid = await db.prepare(`
      SELECT ${groupPaidPeriod} AS period,
        COUNT(DISTINCT u.invoice_id) AS invoices,
        COALESCE(SUM(u.line_total), 0) AS total,
        COALESCE(SUM(u.line_eftpos), 0) AS eftpos,
        COALESCE(SUM(u.line_cash), 0) AS cash,
        COALESCE(SUM(u.line_onacc), 0) AS on_account
      FROM (${unionSql}) u
      GROUP BY period
      ORDER BY period DESC
    `).all(carparkId, fromDate, toDate, carparkId, fromDate, toDate);

    const invOutstanding = await db.prepare(`
      SELECT ${groupExprOut} AS period,
        COALESCE(SUM(CASE WHEN paid_status = 'To Pay' THEN total_price ELSE 0 END), 0) AS outstanding
      FROM invoices WHERE carpark_id = ? AND void = 0
      AND ${INV_DAY} >= ? AND ${INV_DAY} <= ?
      GROUP BY period
    `).all(carparkId, fromDate, toDate);

    const outMap = new Map(invOutstanding.map((r) => [String(r.period), r.outstanding]));
    const invRevenue = invPaid.map((r) => ({
      ...r,
      outstanding: outMap.get(String(r.period)) || 0,
    }));

    // Long-term payments: stored ex GST; reports display inc GST to match invoice revenue fields.
    const ltRevenue = await db.prepare(`
      SELECT ${groupExprLt} as period, COUNT(*) as lt_payments,
        COALESCE(SUM(amount_ex_gst * 1.15), 0) as longterm_total
      FROM longterm_payments
      WHERE carpark_id = ?
        AND ${LT_DAY} >= ? AND ${LT_DAY} <= ?
      GROUP BY ${groupExprLt} ORDER BY period DESC
    `).all(carparkId, fromDate, toDate);

    const byPeriod = new Map();
    for (const r of invRevenue) byPeriod.set(String(r.period), { ...r, longterm: 0 });
    for (const r of ltRevenue) {
      const k = String(r.period);
      const existing = byPeriod.get(k) || { period: r.period, invoices: 0, total: 0, eftpos: 0, cash: 0, on_account: 0, outstanding: 0, longterm: 0 };
      existing.longterm = (existing.longterm || 0) + (r.longterm_total || 0);
      existing.total = (existing.total || 0) + (r.longterm_total || 0);
      existing.lt_payments = (existing.lt_payments || 0) + (r.lt_payments || 0);
      byPeriod.set(k, existing);
    }
    const revenue = Array.from(byPeriod.values()).sort((a, b) => String(b.period).localeCompare(String(a.period)));

    const invSummary = await db.prepare(`
      SELECT
        (${sumBothLinesInRange(L1_PAID_TOTAL, L2_PAID_TOTAL)}) AS total_revenue,
        (${sumBothLinesInRange(L1_EFTPOS, L2_EFTPOS)}) AS eftpos_total,
        (${sumBothLinesInRange(L1_CASH, L2_CASH)}) AS cash_total,
        (${sumBothLinesInRange(L1_ONACC, L2_ONACC)}) AS on_account_total,
        COALESCE(SUM(CASE WHEN (${INV_DAY}) >= ? AND (${INV_DAY}) <= ? AND paid_status = 'To Pay' THEN total_price ELSE 0 END), 0) AS outstanding_total
      FROM invoices WHERE carpark_id = ? AND void = 0
    `).get(
      fromDate, toDate, fromDate, toDate,
      fromDate, toDate, fromDate, toDate,
      fromDate, toDate, fromDate, toDate,
      fromDate, toDate, fromDate, toDate,
      fromDate, toDate,
      carparkId
    );

    const invCountRow = await db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT id FROM invoices WHERE carpark_id = ? AND void = 0
          AND (${EFFECTIVE_PAY1_DAY}) >= ? AND (${EFFECTIVE_PAY1_DAY}) <= ? AND paid_status != 'To Pay' AND ABS(COALESCE(payment_amount,0)) > 0.0001
        UNION
        SELECT id FROM invoices WHERE carpark_id = ? AND void = 0
          AND (${EFFECTIVE_PAY2_DAY}) IS NOT NULL AND (${EFFECTIVE_PAY2_DAY}) >= ? AND (${EFFECTIVE_PAY2_DAY}) <= ? AND COALESCE(payment_amount_2,0) > 0
      )
    `).get(carparkId, fromDate, toDate, carparkId, fromDate, toDate);

    const ltSummary = await db.prepare(`
      SELECT COUNT(*) as lt_payments,
        COALESCE(SUM(amount_ex_gst * 1.15), 0) as longterm_total
      FROM longterm_payments
      WHERE carpark_id = ?
        AND ${LT_DAY} >= ? AND ${LT_DAY} <= ?
    `).get(carparkId, fromDate, toDate);

    const summary = {
      total_invoices: invCountRow.n || 0,
      total_revenue: (invSummary.total_revenue || 0) + (ltSummary.longterm_total || 0),
      eftpos_total: invSummary.eftpos_total || 0,
      cash_total: invSummary.cash_total || 0,
      on_account_total: invSummary.on_account_total || 0,
      outstanding_total: invSummary.outstanding_total || 0,
      longterm_total: ltSummary.longterm_total || 0,
    };
    res.json({ revenue, summary, fromDate, toDate });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/occupancy', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { from, to } = req.query;
    const today = businessDateYmd();
    const firstOfMonth = today.substring(0, 8) + '01';
    const fromDate = from || firstOfMonth;
    const toDate   = to || today;
    const carpark  = await db.prepare('SELECT capacity FROM carparks WHERE id = ?').get(carparkId);
    const capacity = carpark ? carpark.capacity : 100;
    const occupancy = await db.prepare(`
      SELECT ${INV_DAY} as date, COUNT(*) as cars_in,
        COUNT(CASE WHEN ${RET_DAY} = ${INV_DAY} THEN 1 END) as same_day,
        COUNT(CASE WHEN ${RET_DAY} > ${INV_DAY} THEN 1 END) as overnight
      FROM invoices WHERE carpark_id = ? AND void = 0
      AND ${INV_DAY} >= ? AND ${INV_DAY} <= ?
      GROUP BY ${INV_DAY} ORDER BY date DESC
    `).all(carparkId, fromDate, toDate);
    res.json({ occupancy, capacity, fromDate, toDate });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/customers', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { from, to } = req.query;
    const today = businessDateYmd();
    const firstOfMonth = today.substring(0, 8) + '01';
    const fromDate = from || firstOfMonth;
    const toDate   = to || today;
    const topCustomers = await db.prepare(`
      SELECT first_name || ' ' || last_name as name, phone, COUNT(*) as visits,
        COALESCE(SUM(total_price), 0) as total_spent, MAX(date_in) as last_visit
      FROM invoices WHERE carpark_id = ? AND void = 0
      AND ${INV_DAY} >= ? AND ${INV_DAY} <= ?
      AND (first_name IS NOT NULL OR last_name IS NOT NULL)
      GROUP BY LOWER(COALESCE(first_name,'') || LOWER(COALESCE(last_name,'')))
      ORDER BY visits DESC LIMIT 50
    `).all(carparkId, fromDate, toDate);
    const accountUsage = await db.prepare(`
      SELECT ac.company_name, COUNT(i.id) as visits, COALESCE(SUM(i.payment_amount + COALESCE(i.payment_amount_2,0)), 0) as total_billed
      FROM invoices i JOIN account_customers ac ON i.account_customer_id = ac.id
      WHERE i.carpark_id = ? AND i.void = 0 AND substr(trim(COALESCE(i.date_in,'')),1,10) >= ? AND substr(trim(COALESCE(i.date_in,'')),1,10) <= ?
      GROUP BY i.account_customer_id ORDER BY total_billed DESC
    `).all(carparkId, fromDate, toDate);
    res.json({ topCustomers, accountUsage, fromDate, toDate });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/revenue/csv', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { from, to } = req.query;
    const today = businessDateYmd();
    const firstOfMonth = today.substring(0, 8) + '01';
    const fromDate = from || firstOfMonth;
    const toDate   = to || today;
    const invoices = await db.prepare(`
      SELECT i.invoice_number, i.date_in, i.return_date, i.stay_nights,
             i.first_name || ' ' || i.last_name as customer_name,
             i.rego, i.total_price, i.paid_status, i.payment_amount, i.payment_amount_2,
             u.name as staff, COALESCE(ac.company_name, '') as account
      FROM invoices i
      LEFT JOIN users u ON i.staff_id = u.id
      LEFT JOIN account_customers ac ON i.account_customer_id = ac.id
      WHERE i.carpark_id = ? AND i.void = 0
      AND substr(trim(COALESCE(i.date_in,'')),1,10) >= ? AND substr(trim(COALESCE(i.date_in,'')),1,10) <= ?
      ORDER BY i.date_in ASC
    `).all(carparkId, fromDate, toDate);
    const ltPayments = await db.prepare(`
      SELECT p.payment_date, p.amount_ex_gst, p.payment_method, p.transaction_reference,
             lt.lt_number, lt.name
      FROM longterm_payments p
      JOIN longterm_customers lt ON lt.id = p.longterm_customer_id
      WHERE p.carpark_id = ?
        AND substr(trim(COALESCE(p.payment_date,'')),1,10) >= ? AND substr(trim(COALESCE(p.payment_date,'')),1,10) <= ?
      ORDER BY p.payment_date ASC
    `).all(carparkId, fromDate, toDate);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="revenue-${fromDate}-to-${toDate}.csv"`);
    const header = 'Invoice,Date In,Return Date,Nights,Customer,Rego,Total Price,Status,Payment 1,Payment 2,Account,Staff\n';
    const invRows = invoices.map(i =>
      `${i.invoice_number},"${i.date_in}","${i.return_date || ''}",${i.stay_nights},"${i.customer_name}","${i.rego || ''}",${i.total_price},${i.paid_status},${i.payment_amount},${i.payment_amount_2},"${i.account}","${i.staff || ''}"`
    ).join('\n');
    const ltRows = ltPayments.map(p => {
      const inc = (parseFloat(p.amount_ex_gst || 0) * 1.15);
      const cust = `${p.lt_number || ''} ${p.name || ''}`.trim();
      return `LT-PAY,"${p.payment_date}","",,"${cust}","",${inc.toFixed(2)},LongTerm,${inc.toFixed(2)},0.00,"","${p.payment_method || ''}${p.transaction_reference ? ` (${p.transaction_reference})` : ''}"`;
    }).join('\n');
    const rows = [invRows, ltRows].filter(Boolean).join('\n');
    res.send(header + rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/revenue/pdf', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { from, to } = req.query;
    const today = businessDateYmd();
    const firstOfMonth = today.substring(0, 8) + '01';
    const fromDate = from || firstOfMonth;
    const toDate   = to || today;
    const carpark  = await db.prepare('SELECT * FROM carparks WHERE id = ?').get(carparkId);
    const invSummary  = await db.prepare(`
      SELECT
        (${sumBothLinesInRange(L1_PAID_TOTAL, L2_PAID_TOTAL)}) AS total_revenue,
        (${sumBothLinesInRange(L1_EFTPOS, L2_EFTPOS)}) AS eftpos,
        (${sumBothLinesInRange(L1_CASH, L2_CASH)}) AS cash,
        (${sumBothLinesInRange(L1_ONACC, L2_ONACC)}) AS on_account
      FROM invoices WHERE carpark_id = ? AND void = 0
    `).get(
      fromDate, toDate, fromDate, toDate,
      fromDate, toDate, fromDate, toDate,
      fromDate, toDate, fromDate, toDate,
      fromDate, toDate, fromDate, toDate,
      carparkId
    );
    const invCountPdf = await db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT id FROM invoices WHERE carpark_id = ? AND void = 0
          AND (${EFFECTIVE_PAY1_DAY}) >= ? AND (${EFFECTIVE_PAY1_DAY}) <= ? AND paid_status != 'To Pay' AND ABS(COALESCE(payment_amount,0)) > 0.0001
        UNION
        SELECT id FROM invoices WHERE carpark_id = ? AND void = 0
          AND (${EFFECTIVE_PAY2_DAY}) IS NOT NULL AND (${EFFECTIVE_PAY2_DAY}) >= ? AND (${EFFECTIVE_PAY2_DAY}) <= ? AND COALESCE(payment_amount_2,0) > 0
      )
    `).get(carparkId, fromDate, toDate, carparkId, fromDate, toDate);
    const ltSummary = await db.prepare(`
      SELECT COUNT(*) as lt_payments, COALESCE(SUM(amount_ex_gst * 1.15), 0) as longterm_total
      FROM longterm_payments
      WHERE carpark_id = ? AND ${LT_DAY} >= ? AND ${LT_DAY} <= ?
    `).get(carparkId, fromDate, toDate);
    const summary = {
      total_invoices: invCountPdf.n || 0,
      eftpos: invSummary.eftpos || 0,
      cash: invSummary.cash || 0,
      on_account: invSummary.on_account || 0,
      longterm_total: ltSummary.longterm_total || 0,
      total_revenue: (invSummary.total_revenue || 0) + (ltSummary.longterm_total || 0),
    };
    const dailyUnion = sqlPaidLinesUnion();
    const dailyRevenue = await db.prepare(`
      SELECT u.d AS date, COUNT(DISTINCT u.invoice_id) AS count, COALESCE(SUM(u.line_total), 0) AS total
      FROM (${dailyUnion}) u
      GROUP BY u.d ORDER BY date ASC
    `).all(carparkId, fromDate, toDate, carparkId, fromDate, toDate);
    const dailyLt = await db.prepare(`
      SELECT ${LT_DAY} as date, COUNT(*) as count, COALESCE(SUM(amount_ex_gst * 1.15), 0) as total
      FROM longterm_payments
      WHERE carpark_id = ? AND ${LT_DAY} >= ? AND ${LT_DAY} <= ?
      GROUP BY ${LT_DAY} ORDER BY date ASC
    `).all(carparkId, fromDate, toDate);
    const byDay = new Map();
    dailyRevenue.forEach(r => byDay.set(r.date, { date: r.date, count: r.count || 0, total: r.total || 0 }));
    dailyLt.forEach(r => {
      const ex = byDay.get(r.date) || { date: r.date, count: 0, total: 0 };
      ex.count = (ex.count || 0) + 0; // keep "invoices" count unchanged in PDF; totals include LT
      ex.total = (ex.total || 0) + (r.total || 0);
      byDay.set(r.date, ex);
    });
    const dailyCombined = Array.from(byDay.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="revenue-report-${fromDate}.pdf"`);
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    doc.pipe(res);
    doc.fontSize(18).font('Helvetica-Bold').text((carpark && carpark.name) || 'Car Storage Yard', { align: 'center' });
    doc.fontSize(12).font('Helvetica').text(`Revenue Report: ${fromDate} to ${toDate}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(13).font('Helvetica-Bold').text('Summary');
    doc.fontSize(10).font('Helvetica');
    doc.text(`Total Invoices: ${summary.total_invoices}`);
    doc.text(`Total Revenue: $${parseFloat(summary.total_revenue).toFixed(2)}`);
    doc.text(`Eftpos: $${parseFloat(summary.eftpos).toFixed(2)}`);
    doc.text(`Cash: $${parseFloat(summary.cash).toFixed(2)}`);
    doc.text(`On Account: $${parseFloat(summary.on_account).toFixed(2)}`);
    doc.text(`Long Term Payments: $${parseFloat(summary.longterm_total || 0).toFixed(2)}`);
    doc.moveDown();
    doc.fontSize(13).font('Helvetica-Bold').text('Daily Breakdown');
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica-Bold');
    doc.text('Date', 40, doc.y, { width: 100, continued: true });
    doc.text('Invoices', 140, doc.y - doc.currentLineHeight(), { width: 80, continued: true });
    doc.text('Revenue', 220, doc.y - doc.currentLineHeight(), { width: 100 });
    doc.moveDown(0.3);
    doc.moveTo(40, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(9);
    dailyCombined.forEach(row => {
      if (doc.y > 750) doc.addPage();
      const y = doc.y;
      doc.text(row.date, 40, y, { width: 100, continued: true });
      doc.text(String(row.count), 140, y, { width: 80, continued: true });
      doc.text(`$${parseFloat(row.total).toFixed(2)}`, 220, y, { width: 100 });
      doc.moveDown(0.2);
    });
    doc.end();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/customers/csv', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { from, to } = req.query;
    const today = businessDateYmd();
    const firstOfMonth = today.substring(0, 8) + '01';
    const fromDate = from || firstOfMonth;
    const toDate   = to || today;
    const customers = await db.prepare(`
      SELECT first_name || ' ' || last_name as name, phone, rego,
        COUNT(*) as visits, COALESCE(SUM(total_price), 0) as total_spent, MAX(date_in) as last_visit
      FROM invoices WHERE carpark_id = ? AND void = 0
      AND ${INV_DAY} >= ? AND ${INV_DAY} <= ?
      GROUP BY LOWER(COALESCE(first_name,'') || LOWER(COALESCE(last_name,'')))
      ORDER BY visits DESC
    `).all(carparkId, fromDate, toDate);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="customer-report.csv"');
    const header = 'Name,Phone,Rego,Visits,Total Spent,Last Visit\n';
    const rows = customers.map(c =>
      `"${c.name}","${c.phone || ''}","${c.rego || ''}",${c.visits},${c.total_spent},"${c.last_visit || ''}"`
    ).join('\n');
    res.send(header + rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
