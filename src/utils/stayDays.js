// How many days a stay is billed for, and whether a car collected late owes more.
//
// A stay is billed in whole 24-hour blocks counted from the DROP-OFF time (not from
// midnight), minimum 1. A car collected up to GRACE_MINUTES after a block ends does not
// start another block — so drop-off 11:50am, collected 12:20pm the next day is still 1 day.
//
// Kept in step by hand with calcNights24h in public/js/common.js and public/portal/book.html.

const { DEFAULT_TZ } = require('./businessDate');
const { calculateShortStayPrice } = require('./pricing');

const GRACE_MINUTES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Billed days between two clock times (ms, same clock), with the grace after each 24h block. */
function nightsWithGrace(startMs, endMs) {
  const diff = endMs - startMs;
  if (!Number.isFinite(diff) || diff <= 0) return 1;
  return Math.max(1, Math.ceil((diff - GRACE_MINUTES * 60000) / DAY_MS));
}

/** "Wall clock" ms for a date + HH:MM (the app stores NZ local clock values, no timezone). */
function clockMs(ymd, hm) {
  const t = Date.parse(`${String(ymd).slice(0, 10)}T${/^\d{1,2}:\d{2}/.test(String(hm || '')) ? String(hm).slice(0, 5).padStart(5, '0') : '00:00'}:00Z`);
  return t;
}

/** Right now as the same kind of wall-clock ms, in the business timezone. */
function nowClockMs(now = new Date(), timeZone = DEFAULT_TZ) {
  const s = now.toLocaleString('sv-SE', { timeZone }); // 'YYYY-MM-DD HH:MM:SS'
  return Date.parse(`${s.replace(' ', 'T')}Z`);
}

/**
 * What a car being collected NOW owes beyond what it was booked for.
 * Returns null when nothing is owed (on time / within grace / can't be worked out).
 * extraAmount is priced with the same rules as check-in (the account's rate card when on account),
 * as the price of the longer stay minus the price of the booked stay, less any 10% discount on the invoice.
 */
async function overstayFor(db, invoice, { carparkId = 1, now = new Date() } = {}) {
  if (!invoice || invoice.void) return null;
  const booked = parseInt(invoice.stay_nights, 10) || 0;
  if (booked < 1 || !invoice.date_in) return null;
  // Long-term contracts are billed by the month, not by the day.
  if (invoice.paid_status === 'OnAcc' && !invoice.account_customer_id) return null;

  const start = clockMs(invoice.date_in, invoice.time_in);
  const nowMs = nowClockMs(now);
  const actual = nightsWithGrace(start, nowMs);
  const extraDays = actual - booked;
  if (extraDays < 1) return null;

  const acct = invoice.account_customer_id || null;
  const [was, will] = await Promise.all([
    calculateShortStayPrice(db, { carparkId, nights: booked, accountCustomerId: acct }),
    calculateShortStayPrice(db, { carparkId, nights: actual, accountCustomerId: acct }),
  ]);
  let extraAmount = will.total - was.total;
  const dp = Number(invoice.discount_percent) || 0;
  if (dp > 0) extraAmount *= (1 - dp / 100);
  extraAmount = Math.max(0, round2(extraAmount));

  const blockEnd = start + booked * DAY_MS;
  return {
    bookedDays: booked, actualDays: actual, extraDays, extraAmount,
    minutesPastBlock: Math.round((nowMs - blockEnd) / 60000),
    graceMinutes: GRACE_MINUTES,
  };
}

module.exports = { GRACE_MINUTES, nightsWithGrace, clockMs, nowClockMs, overstayFor };
