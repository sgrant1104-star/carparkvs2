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
 * Outstanding balance for a single invoice = total_price - SUM(allocations).
 * Void invoices are always treated as zero outstanding (nothing owed on a
 * cancelled booking).
 */
async function getInvoiceOutstanding(db, invoiceId) {
  const inv = await db.prepare('SELECT id, total_price, void FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv || inv.void) return 0;
  const allocRow = await db.prepare(`
    SELECT COALESCE(SUM(amount_allocated), 0) AS allocated
    FROM payment_allocations WHERE invoice_id = ?
  `).get(invoiceId);
  const allocated = parseFloat(allocRow?.allocated || 0) || 0;
  return Math.max(0, round2((parseFloat(inv.total_price) || 0) - allocated));
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
    const outstanding = Math.max(0, round2(total - allocated));
    return {
      ...inv,
      allocated_amount: allocated,
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

module.exports = {
  getInvoiceOutstanding,
  getAccountInvoicesWithOutstanding,
  allocateAccountPayment,
  deallocatePayment,
};
