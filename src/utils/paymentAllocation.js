/**
 * Payment ⇄ invoice allocation.
 *
 * Account customers (and long-term customers, in future) accrue charges as
 * invoices, then pay them off — sometimes in full, sometimes partially,
 * sometimes one payment covers several invoices at once. Historically this
 * system only compared "total billed in period" vs "total paid in period",
 * which can't answer "which invoices does this payment cover?" or "is THIS
 * invoice paid?". This module allocates a payment across outstanding
 * invoices (oldest first) and records the split in `payment_allocations` so
 * that question has a real answer.
 *
 * Money is allocated oldest-invoice-first (standard AR practice) unless a
 * specific invoice_id is passed in, in which case the whole payment (or
 * whatever it can cover) is targeted at that invoice first before spilling
 * over to the next-oldest outstanding invoice.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * How much of an invoice was settled DIRECTLY on the invoice itself — e.g.
 * the customer paid by card at pickup — as opposed to via the account's
 * bulk monthly payment process (which shows up in payment_allocations
 * instead). 'OnAcc' and 'To Pay' don't count here; those mean "relies on
 * the account being paid later," not "already settled."
 */
function directlyPaidAmount(inv) {
  let paid = 0;
  const DIRECT_METHODS = new Set(['Eftpos', 'Cash', 'Internet Banking', 'Customer Credit']);
  const s1 = String(inv.paid_status || '').trim();
  if (DIRECT_METHODS.has(s1)) paid += parseFloat(inv.payment_amount) || 0;
  const s2 = String(inv.paid_status_2 || '').trim();
  if (DIRECT_METHODS.has(s2)) paid += parseFloat(inv.payment_amount_2) || 0;
  return round2(paid);
}

/**
 * Outstanding balance for a single invoice = total_price - (direct payment
 * on the invoice + account-level allocations). Void invoices are always
 * treated as zero outstanding (nothing owed on a cancelled booking).
 */
async function getInvoiceOutstanding(db, invoiceId) {
  const inv = await db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv || inv.void) return 0;
  const allocRow = await db.prepare(`
    SELECT COALESCE(SUM(amount_allocated), 0) AS allocated
    FROM payment_allocations WHERE invoice_id = ?
  `).get(invoiceId);
  const allocated = parseFloat(allocRow?.allocated || 0) || 0;
  const totalPaid = round2(allocated + directlyPaidAmount(inv));
  return Math.max(0, round2((parseFloat(inv.total_price) || 0) - totalPaid));
}

/**
 * All non-void invoices for an account, each annotated with allocated /
 * outstanding amounts, oldest first.
 */
async function getAccountInvoicesWithOutstanding(db, { carparkId, accountCustomerId }) {
  const invoices = await db.prepare(`
    SELECT * FROM invoices
    WHERE carpark_id = ? AND account_customer_id = ? AND void = 0
    ORDER BY date_in ASC, id ASC
  `).all(carparkId, accountCustomerId);

  const allocRows = await db.prepare(`
    SELECT invoice_id, COALESCE(SUM(amount_allocated), 0) AS allocated
    FROM payment_allocations
    WHERE carpark_id = ? AND payment_source = 'account' AND invoice_id IN (
      SELECT id FROM invoices WHERE carpark_id = ? AND account_customer_id = ?
    )
    GROUP BY invoice_id
  `).all(carparkId, carparkId, accountCustomerId);
  const allocatedByInvoice = new Map(allocRows.map(r => [r.invoice_id, parseFloat(r.allocated) || 0]));

  return invoices.map((inv) => {
    const total = parseFloat(inv.total_price) || 0;
    const allocated = round2(allocatedByInvoice.get(inv.id) || 0);
    const directPaid = directlyPaidAmount(inv);
    const totalPaidAllSources = round2(allocated + directPaid);
    const outstanding = Math.max(0, round2(total - totalPaidAllSources));
    return {
      ...inv,
      allocated_amount: totalPaidAllSources,
      outstanding_amount: outstanding,
      invoice_payment_status: total <= 0 ? '—' : (outstanding <= 0.01 ? 'Paid' : (allocated > 0 ? 'Partial' : 'Outstanding')),
    };
  });
}

/**
 * Allocate `amount` (from a newly-created account_payments row) across the
 * account's outstanding invoices. If `targetInvoiceId` is given, that
 * invoice is settled first (up to what it needs); any leftover spills into
 * the next-oldest outstanding invoices, oldest first. Without a target, the
 * whole payment is applied oldest-first from the start.
 *
 * Any amount left over after all outstanding invoices are covered is left
 * unallocated (shows up as a credit — the account paid ahead).
 *
 * Returns { splits: [{invoice_id, invoice_number, amount_allocated}], unallocated }.
 */
async function allocateAccountPayment(db, { carparkId, accountCustomerId, paymentId, amount, targetInvoiceId = null }) {
  let remaining = round2(amount);
  if (remaining <= 0) return { splits: [], unallocated: 0 };

  let outstandingInvoices = (await getAccountInvoicesWithOutstanding(db, { carparkId, accountCustomerId }))
    .filter(inv => inv.outstanding_amount > 0.001);

  if (targetInvoiceId != null) {
    const idx = outstandingInvoices.findIndex(inv => String(inv.id) === String(targetInvoiceId));
    if (idx > 0) {
      const [target] = outstandingInvoices.splice(idx, 1);
      outstandingInvoices.unshift(target);
    }
  }

  const splits = [];
  const insert = db.prepare(`
    INSERT INTO payment_allocations (carpark_id, payment_source, payment_id, invoice_id, amount_allocated)
    VALUES (?, 'account', ?, ?, ?)
  `);

  for (const inv of outstandingInvoices) {
    if (remaining <= 0.001) break;
    const take = round2(Math.min(remaining, inv.outstanding_amount));
    if (take <= 0) continue;
    await insert.run(carparkId, paymentId, inv.id, take);
    splits.push({ invoice_id: inv.id, invoice_number: inv.invoice_number, amount_allocated: take });
    remaining = round2(remaining - take);
  }

  return { splits, unallocated: round2(Math.max(0, remaining)) };
}

/** Remove all allocations tied to a payment (used when a payment is deleted/corrected). */
async function deallocatePayment(db, { carparkId, paymentSource, paymentId }) {
  const rows = await db.prepare(`
    SELECT * FROM payment_allocations WHERE carpark_id = ? AND payment_source = ? AND payment_id = ?
  `).all(carparkId, paymentSource, paymentId);
  await db.prepare(`DELETE FROM payment_allocations WHERE carpark_id = ? AND payment_source = ? AND payment_id = ?`)
    .run(carparkId, paymentSource, paymentId);
  return rows;
}

/**
 * Builds the data for an account statement — filtered to only the invoices
 * that still have a real outstanding balance, with accurate paid/outstanding
 * amounts from the allocation system. Shared by the PDF download, the manual
 * "send accounts" email, and the automated month-end cron, so all three
 * always agree with each other and with the Accounts page itself.
 */
async function getAccountStatementData(db, { carparkId, accountIds, startDate, endDate }) {
  const ph = accountIds.map(() => '?').join(',');
  const invoicesRaw = await db.prepare(`
    SELECT * FROM invoices
    WHERE account_customer_id IN (${ph}) AND void = 0
      AND substr(trim(COALESCE(date_in,'')),1,10) >= ? AND substr(trim(COALESCE(date_in,'')),1,10) <= ?
    ORDER BY date_in ASC
  `).all(...accountIds, startDate, endDate);

  const outstandingByInvoiceId = new Map();
  for (const accountId of accountIds) {
    const list = await getAccountInvoicesWithOutstanding(db, { carparkId, accountCustomerId: accountId });
    for (const inv of list) outstandingByInvoiceId.set(inv.id, inv);
  }

  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const allInvoices = invoicesRaw.map(inv => {
    const info = outstandingByInvoiceId.get(inv.id);
    return {
      ...inv,
      allocated_amount: info ? info.allocated_amount : 0,
      outstanding_amount: info ? info.outstanding_amount : round2(inv.total_price),
    };
  });

  const outstandingInvoices = allInvoices.filter(i => i.outstanding_amount > 0.01);
  const grossInvoiced = round2(allInvoices.reduce((s, i) => s + (parseFloat(i.total_price) || 0), 0));
  const totalPaid = round2(allInvoices.reduce((s, i) => s + i.allocated_amount, 0));
  const totalOutstanding = round2(outstandingInvoices.reduce((s, i) => s + i.outstanding_amount, 0));

  return { allInvoices, outstandingInvoices, grossInvoiced, totalPaid, totalOutstanding };
}

/**
 * Frees up whatever's allocated to a specific invoice — used when an invoice
 * is voided or deleted, so any money that was allocated to it becomes
 * available credit again instead of silently vanishing. Without this, a
 * voided/deleted invoice would leave its payment_allocations rows pointing
 * at a gone/cancelled invoice, and that money would drop out of every
 * "paid" total without ever coming back as usable credit.
 */
async function deallocateInvoice(db, { carparkId, invoiceId }) {
  const rows = await db.prepare(`
    SELECT * FROM payment_allocations WHERE carpark_id = ? AND invoice_id = ?
  `).all(carparkId, invoiceId);
  if (rows.length === 0) return rows;
  await db.prepare(`DELETE FROM payment_allocations WHERE carpark_id = ? AND invoice_id = ?`).run(carparkId, invoiceId);
  return rows;
}

module.exports = {
  getInvoiceOutstanding,
  getAccountInvoicesWithOutstanding,
  allocateAccountPayment,
  deallocatePayment,
  deallocateInvoice,
  getAccountStatementData,
};
