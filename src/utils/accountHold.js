/**
 * Putting an on-account customer "on hold": while an account is on hold and
 * still has overdue invoices, no NEW on-account booking or invoice can be
 * made for it — by staff or through the online booking form. The hold lifts
 * by itself as soon as nothing is overdue any more (or staff release it).
 */
const { getAccountInvoicesWithOutstanding } = require('./paymentAllocation');
const { invoiceDueYmd } = require('./accountReminders');
const { logActivity } = require('./audit');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ymd = (v) => String(v || '').slice(0, 10);

/** Overdue = unpaid and past its due date (the 20th of the month after issue). */
function overdueOf(invoices, todayYmd) {
  const late = (invoices || []).filter((i) => {
    const d = ymd(i.date_in);
    const due = invoiceDueYmd(d);
    return (i.outstanding_amount || 0) > 0.01 && d && d <= todayYmd && due && due < todayYmd;
  });
  return { count: late.length, amount: round2(late.reduce((t, i) => t + i.outstanding_amount, 0)) };
}

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

function staffMessage(account, state) {
  const what = `${state.overdueCount} overdue invoice${state.overdueCount === 1 ? '' : 's'} totalling ${money(state.overdueAmt)}`;
  const why = account.hold_reason ? ` (${account.hold_reason})` : '';
  return `${account.company_name} is ON HOLD — ${what} still unpaid${why}. Take payment now instead, or record their payment / release the hold on the Accounts page first.`;
}

const CUSTOMER_MESSAGE = "This account is currently on hold, so we can't take an on-account booking. Please contact us to arrange payment.";

/** Current hold position for one account row. Lifts a stale hold (nothing overdue) as it goes. */
async function holdState(db, { carparkId = 1, account, todayYmd, autoRelease = true }) {
  const onHold = !!(account && account.on_hold);
  if (!onHold) return { onHold: false, blocked: false, overdueCount: 0, overdueAmt: 0 };
  const inv = await getAccountInvoicesWithOutstanding(db, { carparkId, accountCustomerId: account.id });
  const { count, amount } = overdueOf(inv, todayYmd);
  const blocked = amount > 0.01;
  if (!blocked && autoRelease) {
    await db.prepare(`UPDATE account_customers SET on_hold = 0, hold_reason = NULL, held_at = NULL, held_by = NULL WHERE id = ?`).run(account.id);
    await logActivity(db, {
      carparkId, tableName: 'account_customers', recordId: account.id, action: 'update',
      before: { on_hold: 1 }, after: { on_hold: 0 },
      notes: `Hold on ${account.company_name} lifted automatically — nothing overdue any more`, userName: 'Automatic',
    });
  }
  return { onHold: true, blocked, overdueCount: count, overdueAmt: amount };
}

/**
 * null when the account can be used; otherwise { staffMessage, customerMessage, ... }.
 * Pass either an account row or an id.
 */
async function blockFor(db, { carparkId = 1, account = null, accountId = null, todayYmd }) {
  const acct = account || await db.prepare('SELECT * FROM account_customers WHERE id = ? AND carpark_id = ?').get(accountId, carparkId);
  if (!acct || !acct.on_hold) return null;
  const state = await holdState(db, { carparkId, account: acct, todayYmd });
  if (!state.blocked) return null;
  return { staffMessage: staffMessage(acct, state), customerMessage: CUSTOMER_MESSAGE, overdueAmt: state.overdueAmt, overdueCount: state.overdueCount };
}

async function setHold(db, { carparkId = 1, accountId, reason = null, todayYmd, userId = null, userName = 'staff' }) {
  const account = await db.prepare('SELECT * FROM account_customers WHERE id = ? AND carpark_id = ?').get(accountId, carparkId);
  if (!account) { const e = new Error('Account not found'); e.status = 404; throw e; }
  const inv = await getAccountInvoicesWithOutstanding(db, { carparkId, accountCustomerId: account.id });
  const { count, amount } = overdueOf(inv, todayYmd);
  if (amount <= 0.01) { const e = new Error('Nothing is overdue on this account, so there is nothing to hold it for.'); e.status = 400; throw e; }
  const clean = String(reason || '').trim().slice(0, 200) || null;
  await db.prepare(`UPDATE account_customers SET on_hold = 1, hold_reason = ?, held_at = CURRENT_TIMESTAMP, held_by = ? WHERE id = ?`).run(clean, userName, account.id);
  await logActivity(db, {
    carparkId, tableName: 'account_customers', recordId: account.id, action: 'update',
    before: { on_hold: account.on_hold ? 1 : 0 }, after: { on_hold: 1, reason: clean },
    notes: `${account.company_name} put on hold — ${count} overdue invoice(s), ${money(amount)}${clean ? ` (${clean})` : ''}`, userId, userName,
  });
  return { overdueCount: count, overdueAmt: amount };
}

async function releaseHold(db, { carparkId = 1, accountId, userId = null, userName = 'staff' }) {
  const account = await db.prepare('SELECT * FROM account_customers WHERE id = ? AND carpark_id = ?').get(accountId, carparkId);
  if (!account) { const e = new Error('Account not found'); e.status = 404; throw e; }
  await db.prepare(`UPDATE account_customers SET on_hold = 0, hold_reason = NULL, held_at = NULL, held_by = NULL WHERE id = ?`).run(account.id);
  await logActivity(db, {
    carparkId, tableName: 'account_customers', recordId: account.id, action: 'update',
    before: { on_hold: account.on_hold ? 1 : 0 }, after: { on_hold: 0 },
    notes: `Hold on ${account.company_name} released`, userId, userName,
  });
}

module.exports = { overdueOf, holdState, blockFor, setHold, releaseHold, staffMessage, CUSTOMER_MESSAGE };
