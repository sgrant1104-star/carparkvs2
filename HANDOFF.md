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

# Fix Hand-off (July 2026, round 4) — "Customer Credit" as a real payment status

## What changed

Applying customer credit to a booking previously had no clean way to be recorded — there was no payment status that meant "settled via credit, not new money." Added one properly:

- **New payment status: "Customer Credit"** — available in both payment slots on the booking form, alongside Eftpos/Cash/Internet Banking/OnAcc.
- **Revenue reporting**: the core `l1PaidTotal`/`l2PaidTotal` SQL expressions (used everywhere — Dashboard, Reports, End of Day) now explicitly include Customer Credit, so a credit-covered stay still counts as real revenue. This was a genuine gap: before this fix, simply adding the new status without updating this shared calculation would have made credit-covered bookings **invisible to revenue reporting entirely** — worse than not having the feature. Caught and fixed before it shipped.
- **Banking/reconciliation**: explicitly excluded from the Eftpos/Cash/Account/Other buckets in both the Banking autofill and the Eftpos terminal reconciliation — it's not physical money that needs to go to the bank or match the card terminal. Tracked as its own separate `creditRedeemed` figure instead.
- **End of Day breakdown**: new "Credit Redeemed (not new money)" line so the breakdown visibly reconciles (Eftpos + Cash + Internet + Credit + Account = Total revenue) instead of leaving an unexplained gap.
- **Apply Credit flow** (`invoice.js`): clicking "Apply" on the credit banner now actually sets `PAID STATUS = Customer Credit` and the payment amount, rather than just being a display-only staging step. If the credit only partially covers the booking, it automatically opens the 2nd payment slot with the remaining balance pre-filled, so staff pick the real method (Eftpos/Cash/etc.) for what's left.

## Required action after deploy

No new migration script needed — the new `credit_redeemed_total` column on `end_day` is created automatically via the same `IF NOT EXISTS`/`ALTER TABLE` pattern used throughout, safe against the existing live database.



---

# Fix Hand-off (July 2026, round 3) — XSS hardening + customer credit system

## 1. Stored XSS fix

Every place customer/staff-entered free text (names, notes, references, company names, etc.) was inserted into the page via `innerHTML` is now passed through a shared `escapeHtml()` helper (added to `public/js/common.js`, loaded on every page). 69 spots were fixed programmatically across 14 files (13 HTML pages + `invoice.js`), then verified file-by-file for valid syntax, plus 3 additional spots found via manual grep that used string concatenation/function calls the automated pass didn't catch (`invoices.html`, `keybox.html`, `longterm.html`).

`escapeHtml()` is safe to apply broadly — it neutralises `< > & " '`, and reading it back via `.dataset`/`.value` (not `.innerHTML`) automatically decodes the entities, so nothing that relies on those data attributes downstream was broken.

**Not yet done:** a small number of very unusual interpolation patterns (e.g. deeply nested ternaries) may not have been caught by the automated pass. If you spot a page showing `&amp;` or similar literally instead of the real character, or conversely spot a field that still isn't escaped, flag it and it can be patched individually.

## 2. Customer credit system (early-return refunds)

Implements: *"customer books 10 nights and pays, returns after 8 → the 2 unused nights become credit against their name, auto-surfaced next time they book."*

Turned out the UI already had a placeholder for this (`Credit $` display on the booking form, and a `credit_applied` column on invoices) that was never wired up — likely planned by a previous developer and left unfinished. Completed it:

- New `customer_credits` table — a simple ledger: who, how much, from which booking, used/unused.
- New `src/utils/customerCredit.js`:
  - `checkAndCreateEarlyReturnCredit()` — fires automatically when a booking is marked picked up (from the Returns page, or by editing the invoice directly) **before** its paid return date. Credit = `(total_price / booked_nights) × unused_nights`. Idempotent — never double-creates for the same booking. Skips bookings that were never actually paid.
  - `findAvailableCredit()` — matches by phone number first (most reliable), falling back to exact first+last name if no phone match.
  - `applyCreditToInvoice()` — consumes oldest credit first, and is capped server-side at what the invoice actually owes (can't push an invoice into a negative balance — any excess just stays available for next time).
- Booking form (`invoice.html`/`invoice.js`): entering a phone number or last name on a **new** booking triggers a lookup; if credit is found, the existing `Credit $` display shows it with an **Apply** button. Applying shows a live "Amount due: $X (after $Y credit)" hint next to the Payment field. The credit is only actually deducted from the ledger once the booking is successfully saved (so a booking that's abandoned mid-entry never consumes credit).
- Returns page and invoice save both show a toast when a new credit is created: *"💰 Early return — $X credit saved to this customer's name for next visit."*

### Known limitations (documented, not silently glossed over)

- **Pricing is an average-rate approximation** — `total_price ÷ booked_nights × unused_nights`. It is NOT aware of tiered daily pricing (e.g. if day 9-10 is cheaper per-night than day 1-2 on your rate card). If exact tiered proration matters, that's a follow-up enhancement.
- **"Actual return date" = the day staff click pickup**, not a separately-entered date — there's no field elsewhere in the app for backdating a pickup, so this matches how the rest of the system already works.
- **Credit lookup only runs for brand-new bookings**, not when re-editing an already-saved invoice — this avoids a double-counting risk against that invoice's own credit ledger entry. A customer with credit who needs it applied to an *existing* booking would need a new booking created (or this can be extended later if that scenario comes up in practice).
- **Matching is phone-first, name-fallback** — two different customers who happen to share both an identical first+last name AND have no phone on file could theoretically be matched to each other's credit. Low risk in practice but worth knowing.

## Required action after deploy

Run the new test scripts locally once `npm install` succeeds (not executable in the authoring environment — no network access there):
```
node scripts/test-payment-allocation.js
node scripts/test-eftpos-reconciliation.js
node scripts/test-lt-payment-delete.js
node scripts/test-customer-credit.js
```
All were carefully hand-traced against the implementation (including catching and fixing two real bugs — a credit double-counting risk and an uncapped over-application risk — before they'd have surfaced live), but none have actually been executed given the lack of network access in this environment.



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


