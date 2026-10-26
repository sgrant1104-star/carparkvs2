#!/usr/bin/env node
/**
 * Customer-facing payment wording on receipts/invoices:
 * paid -> PAID IN FULL; unconfirmed internet banking -> "to be confirmed" (not
 * "pending confirmation") with a note; confirmed internet banking -> paid;
 * on account -> billed on the statement; unpaid -> amount due.
 */
const { invoiceStatusBanner } = require('../src/utils/invoiceDisplay');

let fail = false;
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail = true; } else { console.log('PASS:', msg); } };
const base = { total_price: 100, credit_applied: 0, paid_status_2: null, payment_amount_2: 0 };

let b = invoiceStatusBanner({ ...base, paid_status: 'Eftpos', payment_amount: 100 });
assert(b.kind === 'paid' && b.label === 'PAID IN FULL', 'Eftpos in full: PAID IN FULL');

b = invoiceStatusBanner({ ...base, paid_status: 'Internet Banking', payment_amount: 100, ib_confirmed: 0 });
assert(b.kind === 'pending' && /INTERNET BANKING \$100\.00: TO BE CONFIRMED/.test(b.label), `unconfirmed internet banking says "to be confirmed" (${b.label})`);
assert(!/PENDING CONFIRMATION/.test(b.label) && /confirm this once the payment shows/.test(b.note || ''), '...with a plain-English note, not "pending confirmation"');

b = invoiceStatusBanner({ ...base, paid_status: 'Internet Banking', payment_amount: 100, ib_confirmed: 1 });
assert(b.kind === 'paid', 'confirmed internet banking is PAID IN FULL');

b = invoiceStatusBanner({ ...base, paid_status: 'Eftpos', payment_amount: 40, paid_status_2: 'Internet Banking', payment_amount_2: 60, ib_confirmed_2: 0 });
assert(b.kind === 'pending' && /\$60\.00 TO BE CONFIRMED/.test(b.label) === false && /INTERNET BANKING \$60\.00: TO BE CONFIRMED/.test(b.label), `part Eftpos + part internet banking: only the $60.00 is "to be confirmed" (${b.label})`);

b = invoiceStatusBanner({ ...base, paid_status: 'Internet Banking', payment_amount: 60, ib_confirmed: 0 });
assert(b.kind === 'pending' && /\$60\.00 TO BE CONFIRMED \+ \$40\.00 DUE/.test(b.label), `internet banking part-payment shows what is still due (${b.label})`);

b = invoiceStatusBanner({ ...base, paid_status: 'OnAcc', payment_amount: 100 });
assert(b.kind === 'onaccount' && /monthly account statement/.test(b.note), 'on account: billed on the monthly statement');

b = invoiceStatusBanner({ ...base, paid_status: 'To Pay', payment_amount: 0 });
assert(b.kind === 'due' && /AMOUNT DUE: \$100\.00/.test(b.label), 'unpaid: amount due');

console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: PASS');
process.exit(fail ? 1 : 0);
