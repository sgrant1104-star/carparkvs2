const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { businessDateYmd } = require('../utils/businessDate');
const { allocateAccountPayment, deallocatePayment, getAccountInvoicesWithOutstanding } = require('../utils/paymentAllocation');
const { logActivity, actorFromReq } = require('../utils/audit');
const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const today = businessDateYmd();
    const monthStart = `${today.slice(0, 7)}-01`;

    const accounts = await db.prepare(`
      SELECT a.*,
        (SELECT COALESCE(SUM(COALESCE(i.total_price,0)),0) FROM invoices i
         WHERE i.account_customer_id = a.id AND i.carpark_id = a.carpark_id AND i.void = 0
         AND substr(trim(COALESCE(i.date_in,'')),1,10) >= ?) AS month_billed
      FROM account_customers a
      WHERE a.carpark_id = ? AND a.active = 1 ORDER BY a.company_name
    `).all(monthStart, carparkId);

    // Outstanding must come from real per-invoice allocation (same source the
    // statement view and invoice table use) — not a raw "billed this month
    // minus paid this month" subtraction, which can contradict the per-invoice
    // breakdown whenever a payment settles an invoice from a different month
    // than the one it was dated in.
    const rows = [];
    for (const a of accounts) {
      const invoicesWithOutstanding = await getAccountInvoicesWithOutstanding(db, { carparkId: a.carpark_id || carparkId, accountCustomerId: a.id });
      const balanceOut = Math.round(invoicesWithOutstanding.reduce((s, i) => s + i.outstanding_amount, 0) * 100) / 100;
      const lifeBilled = Math.round(invoicesWithOutstanding.reduce((s, i) => s + (parseFloat(i.total_price) || 0), 0) * 100) / 100;

      const monthInvoices = invoicesWithOutstanding.filter(i => String(i.date_in || '').slice(0, 10) >= monthStart);
      const monthOut = Math.round(monthInvoices.reduce((s, i) => s + i.outstanding_amount, 0) * 100) / 100;
      const billed = parseFloat(a.month_billed) || 0;

      rows.push({
        ...a,
        month_outstanding: monthOut,
        month_payment_status: billed <= 0 ? '—' : (monthOut <= 0.01 ? 'Paid' : 'Outstanding'),
        balance_outstanding: balanceOut,
        balance_payment_status: lifeBilled <= 0 ? '—' : (balanceOut <= 0.01 ? 'Paid' : 'Outstanding'),
      });
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const account = await db.prepare('SELECT * FROM account_customers WHERE id = ?').get(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const invoices = await db.prepare(`SELECT * FROM invoices WHERE account_customer_id = ? AND void = 0 ORDER BY date_in DESC LIMIT 50`).all(req.params.id);
    res.json({ ...account, invoices });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/statement', requireAuth, async (req, res) => {
  try {
    const { month, year } = req.query;
    const carparkId = req.session.carparkId || 1;
    const account = await db.prepare('SELECT * FROM account_customers WHERE id = ? AND carpark_id = ?').get(req.params.id, carparkId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const today = businessDateYmd();
    const m = String(month || parseInt(today.slice(5, 7), 10)).padStart(2, '0');
    const y = parseInt(year || today.slice(0, 4), 10);
    const startDate = `${y}-${m}-01`;
    const endDate = `${y}-${m}-${String(new Date(y, parseInt(m, 10), 0).getDate()).padStart(2, '0')}`;
    const invoicesRaw = await db.prepare(`
      SELECT * FROM invoices
      WHERE account_customer_id = ? AND void = 0
        AND substr(trim(COALESCE(date_in,'')),1,10) >= ?
        AND substr(trim(COALESCE(date_in,'')),1,10) <= ?
      ORDER BY date_in ASC
    `).all(req.params.id, startDate, endDate);

    // Merge in real per-invoice allocated/outstanding amounts (across the invoice's
    // whole life, not just this month) so the statement shows what's actually owed
    // on each booking, not just a whole-period bucket total.
    const allInvoicesWithOutstanding = await getAccountInvoicesWithOutstanding(db, { carparkId, accountCustomerId: req.params.id });
    const outstandingById = new Map(allInvoicesWithOutstanding.map(i => [i.id, i]));
    const invoices = invoicesRaw.map(inv => {
      const withOutstanding = outstandingById.get(inv.id);
      return {
        ...inv,
        allocated_amount: withOutstanding ? withOutstanding.allocated_amount : 0,
        outstanding_amount: withOutstanding ? withOutstanding.outstanding_amount : (parseFloat(inv.total_price) || 0),
        invoice_payment_status: withOutstanding ? withOutstanding.invoice_payment_status : 'Outstanding',
      };
    });

    const total = invoices.reduce((sum, inv) => sum + (parseFloat(inv.total_price || 0) || 0), 0);
    // "Paid" and "Outstanding" for the summary boxes must be based on the SAME
    // allocation data as the per-invoice table below, or the two contradict
    // each other on screen (e.g. boxes say $0 outstanding while a specific
    // invoice in the table clearly still owes money). A payment dated THIS
    // month may have actually settled an OLDER invoice — so summing "payments
    // dated this month" and comparing to "invoiced this month" is a mismatched
    // question. Sum what's actually allocated against May's invoices instead.
    const paid = Math.round(invoices.reduce((s, inv) => s + (inv.allocated_amount || 0), 0) * 100) / 100;
    const outstanding = Math.round(invoices.reduce((s, inv) => s + (inv.outstanding_amount || 0), 0) * 100) / 100;

    // Still show actual cash received this month as its own figure — useful
    // for bank reconciliation — but it no longer drives the Outstanding box.
    const payments = await db.prepare(`
      SELECT * FROM account_payments
      WHERE carpark_id = ? AND account_customer_id = ?
        AND substr(trim(COALESCE(payment_date,'')),1,10) >= ?
        AND substr(trim(COALESCE(payment_date,'')),1,10) <= ?
      ORDER BY payment_date DESC, id DESC
    `).all(carparkId, req.params.id, startDate, endDate);
    const cashReceivedThisMonth = Math.round(payments.reduce((s, p) => s + (p.amount || 0), 0) * 100) / 100;

    // Attach allocation detail to each payment — which invoice(s) it actually
    // landed on — so staff can see this directly in the payment history
    // table instead of needing a separate lookup.
    const paymentsWithAllocation = [];
    for (const p of payments) {
      const allocRows = await db.prepare(`
        SELECT pa.amount_allocated, i.id as invoice_id, i.invoice_number, i.date_in
        FROM payment_allocations pa JOIN invoices i ON i.id = pa.invoice_id
        WHERE pa.payment_source = 'account' AND pa.payment_id = ?
        ORDER BY i.date_in ASC
      `).all(p.id);
      const allocatedTotal = Math.round(allocRows.reduce((s, r) => s + r.amount_allocated, 0) * 100) / 100;
      paymentsWithAllocation.push({
        ...p,
        allocations: allocRows,
        unallocated: Math.round(Math.max(0, (parseFloat(p.amount) || 0) - allocatedTotal) * 100) / 100,
      });
    }

    // Outstanding invoices across ALL periods (not just this month) — used to
    // populate the "apply payment to" picker so a payment can settle an older
    // unpaid invoice, not just ones in the currently-viewed month.
    const outstandingInvoicesForPicker = allInvoicesWithOutstanding
      .filter(i => i.outstanding_amount > 0.001)
      .map(i => ({ id: i.id, invoice_number: i.invoice_number, date_in: i.date_in, rego: i.rego, outstanding_amount: i.outstanding_amount }));

    res.json({ account, invoices, total, month: m, year: y, startDate, endDate, payments: paymentsWithAllocation, paid, outstanding, cashReceivedThisMonth, outstandingInvoicesForPicker });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/accounts/:id/invoices/outstanding
// Per-invoice breakdown of what's been allocated/paid vs still owed — the
// drill-down that a simple "billed vs paid" bucket total can't answer.
router.get('/:id/invoices/outstanding', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const invoices = await getAccountInvoicesWithOutstanding(db, { carparkId, accountCustomerId: req.params.id });
    const totalOutstanding = Math.round(invoices.reduce((s, i) => s + i.outstanding_amount, 0) * 100) / 100;
    res.json({ invoices, totalOutstanding });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/payments', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { from, to } = req.query;
    const today = businessDateYmd();
    const fromDate = from || `${today.slice(0, 7)}-01`;
    const toDate   = to || today;
    const payments = await db.prepare(`
      SELECT * FROM account_payments
      WHERE carpark_id = ? AND account_customer_id = ?
        AND substr(trim(COALESCE(payment_date,'')),1,10) >= ?
        AND substr(trim(COALESCE(payment_date,'')),1,10) <= ?
      ORDER BY payment_date DESC, id DESC
    `).all(carparkId, req.params.id, fromDate, toDate);
    res.json({ payments, fromDate, toDate });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/payments', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { payment_date, amount, payment_method, transaction_reference, notes, invoice_id } = req.body || {};
    const amt = parseFloat(amount);
    if (!payment_date) return res.status(400).json({ error: 'payment_date is required' });
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'amount must be > 0' });
    const result = await db.prepare(`
      INSERT INTO account_payments (carpark_id, account_customer_id, payment_date, amount, payment_method, transaction_reference, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(carparkId, req.params.id, payment_date, amt, payment_method || null, transaction_reference || null, notes || null);

    const paymentId = result.lastInsertRowid;
    const allocation = await allocateAccountPayment(db, {
      carparkId, accountCustomerId: req.params.id, paymentId, amount: amt,
      targetInvoiceId: invoice_id || null,
    });

    const { userId, userName } = actorFromReq(req);
    await logActivity(db, {
      carparkId, tableName: 'account_payments', recordId: paymentId, action: 'create',
      before: null,
      after: { account_customer_id: req.params.id, payment_date, amount: amt, payment_method, transaction_reference, allocation: allocation.splits },
      userId, userName,
    });

    res.status(201).json({ success: true, id: paymentId, allocation: allocation.splits, unallocated: allocation.unallocated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id/payments/:paymentId', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const accountId = req.params.id;
    const paymentId = req.params.paymentId;
    const row = await db.prepare(`
      SELECT * FROM account_payments
      WHERE id = ? AND carpark_id = ? AND account_customer_id = ?
    `).get(paymentId, carparkId, accountId);
    if (!row) return res.status(404).json({ error: 'Payment not found' });

    const removedAllocations = await deallocatePayment(db, { carparkId, paymentSource: 'account', paymentId });
    await db.prepare('DELETE FROM account_payments WHERE id = ?').run(paymentId);

    const { userId, userName } = actorFromReq(req);
    await logActivity(db, {
      carparkId, tableName: 'account_payments', recordId: paymentId, action: 'delete',
      before: { ...row, allocations: removedAllocations },
      after: null,
      userId, userName,
    });

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { company_name, contact_name, phone, email, billing_email, payment_link, discount_percent, notes, rego_1, rego_2 } = req.body;
    const result = await db.prepare(`INSERT INTO account_customers (company_name, contact_name, phone, email, billing_email, payment_link, discount_percent, notes, rego_1, rego_2, carpark_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(company_name, contact_name, phone, email, billing_email, payment_link || '', discount_percent || 0, notes, rego_1 || null, rego_2 || null, carparkId);
    const account = await db.prepare('SELECT * FROM account_customers WHERE id = ?').get(result.lastInsertRowid);
    const { userId, userName } = actorFromReq(req);
    await logActivity(db, { carparkId, tableName: 'account_customers', recordId: account.id, action: 'create', before: null, after: account, userId, userName });
    res.status(201).json(account);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const before = await db.prepare('SELECT * FROM account_customers WHERE id = ?').get(req.params.id);
    const { company_name, contact_name, phone, email, billing_email, payment_link, discount_percent, credit_balance, notes, rego_1, rego_2 } = req.body;
    await db.prepare(`UPDATE account_customers SET company_name=?, contact_name=?, phone=?, email=?, billing_email=?, payment_link=?, discount_percent=?, credit_balance=?, notes=?, rego_1=?, rego_2=? WHERE id = ?`)
      .run(company_name, contact_name, phone, email, billing_email, payment_link || '', discount_percent || 0, credit_balance || 0, notes, rego_1 || null, rego_2 || null, req.params.id);
    const account = await db.prepare('SELECT * FROM account_customers WHERE id = ?').get(req.params.id);
    const { userId, userName } = actorFromReq(req);
    await logActivity(db, { carparkId, tableName: 'account_customers', recordId: account.id, action: 'update', before, after: account, userId, userName });
    res.json(account);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const before = await db.prepare('SELECT * FROM account_customers WHERE id = ?').get(req.params.id);
    await db.prepare('UPDATE account_customers SET active = 0 WHERE id = ?').run(req.params.id);
    const { userId, userName } = actorFromReq(req);
    await logActivity(db, { carparkId, tableName: 'account_customers', recordId: req.params.id, action: 'deactivate', before, after: { ...before, active: 0 }, userId, userName });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/accounts/:id/payments/:paymentId/reallocate  { invoice_id }
// Moves an existing payment's allocation to a specific invoice (any leftover
// after that invoice is settled spills FIFO to the next-oldest outstanding
// invoice, same as a fresh payment). Use this to correct a payment that
// auto-allocated to the wrong invoice — e.g. staff can see from the amount
// or a transaction reference that it was clearly meant for a specific
// booking, even though FIFO picked an older one.
router.put('/:id/payments/:paymentId/reallocate', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { id: accountId, paymentId } = req.params;
    const { invoice_id } = req.body || {};

    const payment = await db.prepare(`
      SELECT * FROM account_payments WHERE id = ? AND carpark_id = ? AND account_customer_id = ?
    `).get(paymentId, carparkId, accountId);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });

    await deallocatePayment(db, { carparkId, paymentSource: 'account', paymentId });
    const result = await allocateAccountPayment(db, {
      carparkId, accountCustomerId: accountId, paymentId, amount: payment.amount,
      targetInvoiceId: invoice_id || null,
    });

    const { userId, userName } = actorFromReq(req);
    await logActivity(db, {
      carparkId, tableName: 'account_payments', recordId: paymentId, action: 'reallocate',
      before: null, after: { targeted_invoice_id: invoice_id || null, splits: result.splits },
      notes: `Manually reassigned payment allocation`, userId, userName,
    });

    res.json({ success: true, allocation: result.splits, unallocated: result.unallocated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
