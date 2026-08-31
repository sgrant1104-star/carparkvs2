// Short, staff-issued account numbers for on-account customers. Doubles as
// the credit-vetting mechanism for self-service portal bookings: staff only
// ever hand one to a business they've already approved for on-account
// billing, so a customer typing a valid number into the booking form has
// effectively already been vetted — no separate approval queue needed.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — avoids misreads over the phone

function randomCode(length = 6) {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return s;
}

async function generateAccountNumber(db) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = randomCode();
    const existing = await db.prepare('SELECT id FROM account_customers WHERE account_number = ?').get(code);
    if (!existing) return code;
  }
  throw new Error('Could not generate a unique account number');
}

module.exports = { generateAccountNumber };
