# Carpark Management — Fix Hand-off (June 2026)

## Summary

Implemented client-requested fixes for **returns tracking**, **long-term payment proration**, and **accounts/invoice presentation**, plus a platform review with follow-up recommendations.

---

## What was fixed

### 1. Returns — pickup removes car from list

**Problem:** After clicking **Pick Up**, cars still appeared on the Returns page and inflated “Returning Today” counts.

**Fix:**
- `src/routes/returns.js` — return-date view now only includes cars **still in yard** (`picked_up` = Car In Yard / blank).
- `src/routes/dashboard.js` — menu stat **Returning Today** uses the same in-yard filter.
- `src/routes/endday.js` — corrected inverted query (was listing already-collected cars).

**How to verify:** Open Returns → pick up a car → row disappears; menu count drops.

---

### 2. Long-term — prepay spread across contract months

**Problem:** A single lump-sum prepayment (e.g. 12 months) hit one month in revenue reports.

**Fix:**
- New `src/utils/longtermProration.js` — detects term length from contract dates / known totals ($200, $500, $1000, $1650) and splits payments.
- `POST /api/longterm/:id/payments` — creates one ledger row per month with recognition `payment_date`; `cash_received_date` stores actual receipt date.
- DB columns added: `payment_batch_id`, `cash_received_date` on `longterm_payments`.
- Payment history UI groups prorated batches with a monthly breakdown.

**Reporting:** Revenue / dashboard / reports already sum by `payment_date` — prorated rows now land in the correct months automatically.

**Note:** Payments recorded **before** this deploy remain as single rows. Re-enter or contact support for a one-time data migration if historical months need correction.

---

### 3. Accounts & statements — cleaner UI

- Summary cards: **Invoiced / Paid / Outstanding** per month.
- Improved statement table layout and PDF download link.
- Account invoice PDF header styling aligned with receipts.

---

### 4. Invoice / receipt PDFs

- Receipt PDF (`/api/invoices/:id/pdf`) — branded header, two-column layout, clearer totals and bank details.

---

## Files changed

| Area | Files |
|------|--------|
| LT proration | `src/utils/longtermProration.js`, `src/routes/longterm.js`, `src/database.js` |
| Returns | `src/routes/returns.js`, `src/routes/dashboard.js`, `src/routes/endday.js` |
| UI | `public/longterm.html`, `public/returns.html`, `public/accounts.html`, `public/css/style.css` |
| PDFs | `src/routes/invoices.js`, `src/routes/email.js` |
| Tests | `scripts/test-longterm-proration.js` |

---

## Testing

```bash
node scripts/test-longterm-proration.js
npm start
```

Manual checks:
1. **Returns** — pick up a car; confirm count decreases.
2. **Long Term** — record $1650 payment on 12-month contract; payment history shows “12 mo” batch; Reports → revenue spreads across months.
3. **Accounts** — load statement; summary cards and PDF download work.

**Railway:** Deploy this branch, then repeat the same checks on the live URL. No env vars required for these fixes.

---

## Platform review & recommendations

### Payment processing
| Item | Status | Recommendation |
|------|--------|----------------|
| Short-term invoice payments | OK | Payment-date logic already separates paid vs outstanding |
| LT prepay proration | **Fixed** | Reconcile old lump-sum rows if needed |
| Banking / end-of-day | Partial | LT cash not auto-fed to Banking page — consider summing `cash_received_date` on payment day |
| Account payments | OK | Monthly paid vs outstanding works; add auto-match when payment reference includes invoice # |

### User interface — quick wins
1. **Menu** — add “still to collect” vs “returned today” as two small stats.
2. **Returns** — optional sound/toast when count hits zero at end of day.
3. **Long Term** — show next recognition month on list cards for prepaid customers.
4. **Accounts** — email statement button on same row as PDF (done in detail view).
5. **Global** — breadcrumb on inner pages (Invoice ← Returns).

### Traceability
1. **Audit log** — who changed `picked_up`, payments, voids (single `activity_log` table).
2. **Payment batch IDs** — already on LT payments; expose in CSV export.
3. **Invoice versioning** — store snapshot on save for dispute resolution.

### Security / ops
1. Rotate admin password after deploy (`admin123` was reset locally).
2. Set `SESSION_SECRET` and `INITIAL_ADMIN_*` on Railway if DB is ever wiped.
3. Back up `carpark.db` / Railway volume regularly.

---

## Deploy notes

1. Push to Railway; restart service (schema migration runs on boot via `ALTER TABLE`).
2. Existing LT payments are unchanged.
3. New prepayments from deploy onward are prorated automatically.

---

*Prepared for client hand-off — implementer should run live smoke tests on Railway after deploy.*

---

# Fix Hand-off (July 2026) — Payment traceability, audit log, Eftpos reconciliation

## Summary

This round implements the traceability/reconciliation gaps flagged in the June 2026 platform review, plus the specific request to make End of Day banking checkable against the physical Eftpos terminal.

## What was built

### 1. Payment ⇄ invoice allocation (accounts)
- New table `payment_allocations` links an `account_payments` row to the specific `invoices` it settles.
- `POST /api/accounts/:id/payments` now auto-allocates the new payment across the account's outstanding invoices, **oldest first**. Overpayment is left unallocated (shown as `unallocated`, i.e. a credit).
- New `GET /api/accounts/:id/invoices/outstanding` — per-invoice paid/outstanding breakdown, not just a monthly bucket total.
- Deleting a payment (`DELETE /api/accounts/:id/payments/:paymentId`) removes its allocations and the affected invoices' outstanding balances are restored automatically.
- Files: `src/utils/paymentAllocation.js` (new), `src/routes/accounts.js`, `src/database.js`.

### 2. Audit log
- New table `activity_log` — append-only, records `before`/`after` JSON snapshots, the acting user, and a timestamp.
- Wired into: invoice update (only when a payment-relevant field changes), void, refund, delete; account payment create/delete; account customer create/update/deactivate; long-term payment create/delete; long-term customer create/delete.
- Deletes are **hard deletes** in the underlying tables (unchanged from before, to avoid touching every query that filters active/void rows) but the full row is preserved in `activity_log.before_json` first, so nothing is actually lost — it's just no longer in the "live" table.
- New `GET /api/admin/activity-log` (admin-only) — filter by `table`, `record_id`, `action`, date range.
- Long-term payments previously had **no delete endpoint at all** — a mis-entered LT payment couldn't be corrected. Added `DELETE /api/longterm/:id/payments/:paymentId`.
- Files: `src/utils/audit.js` (new), touched across `src/routes/invoices.js`, `accounts.js`, `longterm.js`, `admin.js`.

### 3. Eftpos terminal reconciliation
- New `src/utils/eftposReconciliation.js` builds the itemised list of everything the system thinks went through the Eftpos terminal on a given date, across **all three payment sources** (short-stay invoices, long-term prepayments, account payments) — not just invoices.
- Long-term prepay swipes are grouped by the actual swipe (`cash_received_date`/batch), so a single 12-month prepay reconciles as **one** terminal transaction, not twelve.
- End of Day page (`endday.html`) now has an "Eftpos Terminal Check" panel: enter the terminal's Z-report total, hit Check, and it shows a match/mismatch badge plus an itemised trace table (source, reference, description, time, amount) to find the discrepancy.
- `POST /api/endday` now accepts `eftpos_machine_total`; it's stored alongside a computed `eftpos_variance` on the `end_day` row, and a mismatch is written to the audit log. History table shows Terminal / Variance columns for every past day.
- New `GET /api/endday/eftpos-reconciliation?date=&machine_total=` for ad-hoc checks without saving.
- Files: `src/utils/eftposReconciliation.js` (new), `src/routes/endday.js`, `public/endday.html`, `src/database.js`.

### 4. Banking autofill gap closed
- `GET /api/banking/autofill` previously only read `invoices`. It now also sums long-term payments (by `cash_received_date`, the actual receipt date — not the accrual `payment_date`) and account payments (by `payment_date`) into the same eftpos/cash/account/other buckets.
- File: `src/routes/banking.js`.

### 5. Security
- Removed the hardcoded fallback JWT secret (`'carpark_secret_2026'`) that was baked into `server.js`, `auth.js`, and `admin.js`. Centralized in `src/utils/config.js`: uses `SESSION_SECRET` if set, otherwise generates a random per-process secret and logs a loud warning (sessions won't survive a restart until `SESSION_SECRET` is set — **set this in your environment now**).
- Removed the hardcoded Gmail app-password fallback in the month-end email cron job. **Rotate that Gmail app password now** if it was ever live — it was sitting in plain source.
- Added basic in-memory login rate limiting (5 failed attempts per username+IP locks for 15 minutes). Note: in-memory only, resets on restart and isn't shared across multiple server instances — fine for a single-instance Railway deploy, not a substitute for a persistent rate limiter if you scale out.

## Required action before/after deploy

1. **Set `SESSION_SECRET`** in your environment (Railway/Vercel/local `.env`) — a long random string. Without it, every restart logs everyone out.
2. **Rotate the Gmail app password** referenced in the old `server.js` fallback, if it was ever a real, live credential.
3. Run the new test scripts locally once dependencies are installed: `node scripts/test-payment-allocation.js` and `node scripts/test-eftpos-reconciliation.js` (these weren't executable in the environment this change was authored in — no network access to install `node_modules` — so they're written and reviewed carefully, but not yet actually run. Run them before deploying).
4. Existing account/LT payments made **before** this deploy have no `payment_allocations` rows — `GET /invoices/outstanding` will show them as fully outstanding until a new payment is recorded against that account (which will then allocate forward). A one-time backfill script can be written if historical per-invoice status matters.

## Deliberately not done this round (documented trade-offs)

- **Invoices are still hard-deleted**, not soft-deleted. Full soft-delete would need every query that currently filters `void = 0` to also filter a new `deleted = 0`, across ~8 route files — too invasive to do safely without being able to run the app end-to-end here. The audit log captures the full row before deletion as a mitigation.
- **CSRF protection / `helmet`-style headers** were not added (would require adding new npm dependencies, and this environment has no network access to install/verify them). Recommended as a near-term follow-up.
- **Payment method fields on LT/account payment forms** are already `<select>` dropdowns using the same value `'Eftpos'` as invoices, so reconciliation matching works out of the box — but this is a soft convention (free-typed values would silently fall through to "other"), worth keeping an eye on if the dropdowns are ever changed to free text.


