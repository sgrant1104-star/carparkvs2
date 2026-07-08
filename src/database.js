/**
 * database.js — sql.js SQLite (single backend, no external services)
 *
 * Data is kept in an sql.js in-memory database and flushed to a file:
 *   • Local / Railway / Render  →  <project-root>/carpark.db
 *   • Vercel (serverless)       →  /tmp/carpark.db  (persists within a
 *                                   container, NOT across cold-starts)
 *
 * All route handlers must await every db call:
 *   const row  = await db.prepare('SELECT …').get(p1, p2);
 *   const rows = await db.prepare('SELECT …').all(p1);
 *   const r    = await db.prepare('INSERT …').run(p1, p2);
 *   // r.lastInsertRowid, r.changes
 */

const bcrypt = require('bcryptjs');
const path   = require('path');
const fs     = require('fs');

// ─── State ────────────────────────────────────────────────────────────────────
let _SQL = null;  // sql.js WASM constructor
let _db  = null;  // sql.js Database instance

// ─── Database path resolution ─────────────────────────────────────────────────
//
//  Platform          | Path used
//  ──────────────────|──────────────────────────────────────────────────────────
//  Local / Railway   | <project-root>/carpark.db  (writable persistent disk)
//  Railway + Volume  | $DB_FILE_PATH (set in Railway env vars, e.g. /data/carpark.db)
//  Vercel serverless | /tmp/carpark.db  (writable but ephemeral per-container)
//
//  On Railway with a Volume mounted at /data, set env var DB_FILE_PATH=/data/carpark.db
//  The app will bootstrap from the committed seed file on first run, then
//  persist ALL changes to the volume — surviving restarts AND re-deployments.
//
const COMMITTED_DB = path.join(__dirname, '..', 'carpark.db'); // always in repo
const DB_PATH = process.env.DB_FILE_PATH          // Railway volume override
  || (process.env.VERCEL ? '/tmp/carpark.db'      // Vercel serverless (ephemeral)
  : COMMITTED_DB);                                // local / default

// ─── Disk helpers ─────────────────────────────────────────────────────────────
function saveToDisk() {
  if (!_db) return;
  try {
    fs.writeFileSync(DB_PATH, Buffer.from(_db.export()));
  } catch (e) {
    console.error('[DB] save error:', e.message);
  }
}

// ─── sql.js parameter normalisation ──────────────────────────────────────────
function norm(args) {
  if (args.length === 0) return [];
  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    const obj = {};
    for (const [k, v] of Object.entries(args[0])) obj[k] = v === undefined ? null : v;
    return obj;
  }
  return args.map(v => (v === undefined ? null : v));
}

// ─── sql.js statement wrapper (async interface) ───────────────────────────────
function wrap(sql) {
  return {
    async get(...args) {
      const stmt = _db.prepare(sql);
      try {
        stmt.bind(norm(args));
        return stmt.step() ? stmt.getAsObject() : undefined;
      } finally { stmt.free(); }
    },
    async all(...args) {
      const stmt = _db.prepare(sql);
      const rows = [];
      try {
        stmt.bind(norm(args));
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally { stmt.free(); }
    },
    async run(...args) {
      const stmt = _db.prepare(sql);
      try {
        stmt.run(norm(args));
        const lastInsertRowid = _db.exec('SELECT last_insert_rowid()')[0].values[0][0];
        const changes         = _db.exec('SELECT changes()')[0].values[0][0];
        saveToDisk();
        return { lastInsertRowid, changes };
      } finally { stmt.free(); }
    }
  };
}

// ─── Exported db proxy ────────────────────────────────────────────────────────
const db = new Proxy({}, {
  get(_, prop) {
    if (prop === 'prepare') return (sql) => wrap(sql);

    if (prop === 'exec') {
      return (sql) => { _db.run(sql); saveToDisk(); };
    }
    if (prop === 'pragma') {
      return (str) => { try { _db.run(`PRAGMA ${str}`); } catch (_) {} };
    }
    if (prop === 'transaction') {
      return (fn) => async (...args) => {
        _db.run('BEGIN');
        try {
          const result = fn(...args);
          _db.run('COMMIT');
          saveToDisk();
          return result;
        } catch (e) {
          try { _db.run('ROLLBACK'); } catch (_) {}
          throw e;
        }
      };
    }
    return undefined;
  }
});

// ─── initializeDatabase ───────────────────────────────────────────────────────
async function initializeDatabase() {
  if (!_SQL) {
    const initSqlJs = require('sql.js');
    const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
    _SQL = await initSqlJs({ locateFile: f => path.join(wasmDir, f) });
    console.log('[DB] sql.js WASM loaded');
  }

  if (!_db) {
    // If the live DB path doesn't exist yet, bootstrap from the committed seed
    // file.  This handles three cases:
    //   1. Vercel cold-start  (/tmp/carpark.db missing → copy seed)
    //   2. Railway Volume first run (/data/carpark.db missing → copy seed,
    //      then ALL future writes persist to the volume across deployments)
    //   3. Fresh local checkout (carpark.db missing → copy seed, or create blank)
    if (!fs.existsSync(DB_PATH) && DB_PATH !== COMMITTED_DB && fs.existsSync(COMMITTED_DB)) {
      const dir = path.dirname(DB_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(COMMITTED_DB, DB_PATH);
      console.log(`[DB] Bootstrapped ${DB_PATH} from committed seed file`);
    }

    if (fs.existsSync(DB_PATH)) {
      _db = new _SQL.Database(fs.readFileSync(DB_PATH));
      console.log(`[DB] Loaded existing database from ${DB_PATH}`);
    } else {
      _db = new _SQL.Database();
      console.log(`[DB] Created new in-memory database (will save to ${DB_PATH})`);
    }

    // Flush to disk every 10 seconds and on process exit
    setInterval(saveToDisk, 10000);
    process.on('exit', saveToDisk);
    process.on('SIGINT', () => { saveToDisk(); process.exit(); });
  }

  // ── Schema (IF NOT EXISTS – safe to run on every cold start) ────────────────
  const x = (sql) => _db.run(sql);

  x(`PRAGMA foreign_keys = ON`);

  x(`CREATE TABLE IF NOT EXISTS carparks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    address TEXT,
    phone TEXT,
    email TEXT,
    capacity INTEGER DEFAULT 100,
    bank_name TEXT,
    bank_account_name TEXT,
    bank_account_number TEXT,
    bank_reference TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Migrate: add bank columns to existing carparks table if not present
  ['bank_name','bank_account_name','bank_account_number','bank_reference'].forEach(col => {
    try { x(`ALTER TABLE carparks ADD COLUMN ${col} TEXT`); } catch (_) {}
  });

  x(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT,
    role TEXT DEFAULT 'staff',
    carpark_id INTEGER DEFAULT 1,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  x(`CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT,
    last_name TEXT,
    phone TEXT,
    email TEXT,
    notes TEXT,
    alert_message TEXT,
    carpark_id INTEGER DEFAULT 1,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  x(`CREATE TABLE IF NOT EXISTS longterm_customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lt_number TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    rego_1 TEXT,
    rego_2 TEXT,
    phone TEXT,
    email TEXT,
    rate REAL DEFAULT 0,
    rate_period TEXT DEFAULT 'monthly',
    expiry_date DATE,
    notes TEXT,
    carpark_id INTEGER DEFAULT 1,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  try { x(`ALTER TABLE longterm_customers ADD COLUMN contract_amount REAL`); } catch (_) {}
  try { x(`ALTER TABLE longterm_customers ADD COLUMN payment_status TEXT DEFAULT 'Unpaid'`); } catch (_) {}
  try { x(`ALTER TABLE longterm_customers ADD COLUMN contract_start_date DATE`); } catch (_) {}
  try { x(`ALTER TABLE longterm_customers ADD COLUMN lt_key_slot INTEGER`); } catch (_) {}
  try { x(`ALTER TABLE longterm_customers ADD COLUMN lt_in_yard INTEGER DEFAULT 0`); } catch (_) {}
  try { x(`UPDATE longterm_customers SET payment_status = 'Unpaid' WHERE payment_status IS NULL OR payment_status = ''`); } catch (_) {}

  // Long-term payment records (monthly/annual plans tracked via payment history)
  x(`CREATE TABLE IF NOT EXISTS longterm_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carpark_id INTEGER DEFAULT 1,
    longterm_customer_id INTEGER NOT NULL,
    payment_date DATE NOT NULL,
    amount_ex_gst REAL NOT NULL,
    payment_method TEXT,
    transaction_reference TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  try { x(`CREATE INDEX IF NOT EXISTS lt_payments_by_customer ON longterm_payments (carpark_id, longterm_customer_id, payment_date DESC)`); } catch (_) {}
  ['payment_batch_id', 'cash_received_date'].forEach((col) => {
    try { x(`ALTER TABLE longterm_payments ADD COLUMN ${col} TEXT`); } catch (_) {}
  });

  x(`CREATE TABLE IF NOT EXISTS account_customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    contact_name TEXT,
    phone TEXT,
    email TEXT,
    billing_email TEXT,
    payment_link TEXT,
    credit_balance REAL DEFAULT 0,
    discount_percent REAL DEFAULT 0,
    notes TEXT,
    carpark_id INTEGER DEFAULT 1,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Account payment records (for tracking paid vs outstanding on monthly invoices)
  x(`CREATE TABLE IF NOT EXISTS account_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carpark_id INTEGER DEFAULT 1,
    account_customer_id INTEGER NOT NULL,
    payment_date DATE NOT NULL,
    amount REAL NOT NULL,
    payment_method TEXT,
    transaction_reference TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  try { x(`CREATE INDEX IF NOT EXISTS account_payments_by_account ON account_payments (carpark_id, account_customer_id, payment_date DESC)`); } catch (_) {}

  ['rego_1', 'rego_2'].forEach((col) => {
    try { x(`ALTER TABLE account_customers ADD COLUMN ${col} TEXT`); } catch (_) {}
  });

  x(`CREATE TABLE IF NOT EXISTS pricing_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carpark_id INTEGER DEFAULT 1,
    customer_type TEXT DEFAULT 'short',
    days_from INTEGER DEFAULT 1,
    days_to INTEGER,
    daily_rate REAL NOT NULL,
    description TEXT,
    active INTEGER DEFAULT 1
  )`);

  x(`CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number INTEGER UNIQUE,
    carpark_id INTEGER DEFAULT 1,
    customer_id INTEGER,
    account_customer_id INTEGER,
    key_number INTEGER,
    no_key INTEGER DEFAULT 0,
    rego TEXT,
    make TEXT,
    first_name TEXT,
    last_name TEXT,
    phone TEXT,
    email TEXT,
    date_in DATE,
    time_in TEXT,
    return_date DATE,
    return_time TEXT,
    stay_nights INTEGER DEFAULT 0,
    flight_info TEXT,
    flight_type TEXT DEFAULT 'Standard - On Flight',
    total_price REAL DEFAULT 0,
    credit_applied REAL DEFAULT 0,
    discount_percent REAL DEFAULT 0,
    paid_status TEXT DEFAULT 'To Pay',
    payment_amount REAL DEFAULT 0,
    payment_method TEXT,
    paid_status_2 TEXT,
    payment_amount_2 REAL DEFAULT 0,
    payment_method_2 TEXT,
    do_not_move INTEGER DEFAULT 0,
    picked_up TEXT DEFAULT 'Car In Yard',
    staff_id INTEGER,
    notes TEXT,
    customer_alert TEXT,
    void INTEGER DEFAULT 0,
    refund_amount REAL DEFAULT 0,
    refund_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  try { x(`ALTER TABLE invoices ADD COLUMN payment_date_1 DATE`); } catch (_) {}
  try { x(`ALTER TABLE invoices ADD COLUMN payment_date_2 DATE`); } catch (_) {}

  x(`CREATE TABLE IF NOT EXISTS key_box (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carpark_id INTEGER DEFAULT 1,
    key_number INTEGER NOT NULL,
    status TEXT DEFAULT 'available',
    invoice_id INTEGER,
    longterm_customer_id INTEGER,
    holder_type TEXT DEFAULT 'invoice',
    UNIQUE(carpark_id, key_number)
  )`);
  try { x(`ALTER TABLE key_box ADD COLUMN longterm_customer_id INTEGER`); } catch (_) {}
  try { x(`ALTER TABLE key_box ADD COLUMN holder_type TEXT DEFAULT 'invoice'`); } catch (_) {}
  try { x(`UPDATE key_box SET holder_type = 'available' WHERE status = 'available'`); } catch (_) {}
  try { x(`UPDATE key_box SET holder_type = 'invoice' WHERE status = 'in_use' AND invoice_id IS NOT NULL`); } catch (_) {}
  try { x(`UPDATE key_box SET holder_type = 'longterm' WHERE status = 'in_use' AND longterm_customer_id IS NOT NULL`); } catch (_) {}
  // LT locker is now separate from Standard key_box; free any legacy LT-held standard rows.
  try { x(`UPDATE key_box SET status='available', invoice_id=NULL, longterm_customer_id=NULL, holder_type='available' WHERE holder_type='longterm' OR longterm_customer_id IS NOT NULL`); } catch (_) {}

  x(`CREATE TABLE IF NOT EXISTS lt_key_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carpark_id INTEGER DEFAULT 1,
    key_number INTEGER NOT NULL,
    active INTEGER DEFAULT 1,
    UNIQUE(carpark_id, key_number)
  )`);

  x(`CREATE TABLE IF NOT EXISTS petty_cash (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carpark_id INTEGER DEFAULT 1,
    date DATE NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    type TEXT NOT NULL,
    category TEXT,
    staff_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  x(`CREATE TABLE IF NOT EXISTS banking (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carpark_id INTEGER DEFAULT 1,
    date DATE UNIQUE NOT NULL,
    eftpos_total REAL DEFAULT 0,
    cash_total REAL DEFAULT 0,
    account_total REAL DEFAULT 0,
    other_total REAL DEFAULT 0,
    notes TEXT,
    staff_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  x(`CREATE TABLE IF NOT EXISTS end_day (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carpark_id INTEGER DEFAULT 1,
    date DATE UNIQUE NOT NULL,
    total_revenue REAL DEFAULT 0,
    cars_in INTEGER DEFAULT 0,
    cars_out INTEGER DEFAULT 0,
    cars_in_yard INTEGER DEFAULT 0,
    eftpos_total REAL DEFAULT 0,
    cash_total REAL DEFAULT 0,
    account_total REAL DEFAULT 0,
    internet_banking_total REAL DEFAULT 0,
    notes TEXT,
    staff_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  try { x(`ALTER TABLE end_day ADD COLUMN internet_banking_total REAL DEFAULT 0`); } catch (_) {}
  // Eftpos terminal (Z-report) reconciliation: what the terminal says vs what the system expected.
  try { x(`ALTER TABLE end_day ADD COLUMN eftpos_machine_total REAL`); } catch (_) {}
  try { x(`ALTER TABLE end_day ADD COLUMN eftpos_variance REAL`); } catch (_) {}
  try { x(`ALTER TABLE end_day ADD COLUMN eftpos_variance_notes TEXT`); } catch (_) {}

  // ── Activity / audit log ────────────────────────────────────────────────
  // Generic append-only log for anything that touches money or deletes data:
  // invoice edits/voids/refunds/deletes, account & LT payment create/delete,
  // account/LT customer edits. before_json/after_json are full row snapshots
  // (JSON) so a deleted row's data is never actually lost, even though the
  // underlying table row itself may be removed.
  x(`CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carpark_id INTEGER DEFAULT 1,
    table_name TEXT NOT NULL,
    record_id INTEGER,
    action TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    notes TEXT,
    user_id INTEGER,
    user_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  try { x(`CREATE INDEX IF NOT EXISTS activity_log_lookup ON activity_log (carpark_id, table_name, record_id, created_at DESC)`); } catch (_) {}

  // ── Payment ⇄ invoice allocation ────────────────────────────────────────
  // Links a payment (account_payments or longterm_payments row) to the
  // specific invoice(s) it settles, so "outstanding" can be answered per
  // invoice instead of as a date-range bucket subtraction.
  x(`CREATE TABLE IF NOT EXISTS payment_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carpark_id INTEGER DEFAULT 1,
    payment_source TEXT NOT NULL,   -- 'account' | 'longterm'
    payment_id INTEGER NOT NULL,    -- FK -> account_payments.id / longterm_payments.id
    invoice_id INTEGER NOT NULL,    -- FK -> invoices.id
    amount_allocated REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  try { x(`CREATE INDEX IF NOT EXISTS payment_allocations_by_payment ON payment_allocations (carpark_id, payment_source, payment_id)`); } catch (_) {}
  try { x(`CREATE INDEX IF NOT EXISTS payment_allocations_by_invoice ON payment_allocations (carpark_id, invoice_id)`); } catch (_) {}

  x(`CREATE TABLE IF NOT EXISTS email_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carpark_id INTEGER DEFAULT 1,
    account_customer_id INTEGER,
    account_name TEXT,
    month INTEGER NOT NULL,
    year INTEGER NOT NULL,
    sent_at DATETIME,
    status TEXT DEFAULT 'pending',
    error_msg TEXT,
    recipient_email TEXT
  )`);

  // ── Seed data (INSERT OR IGNORE / check-first so re-runs are safe) ─────────
  const cp = await db.prepare('SELECT id FROM carparks WHERE id = 1').get();
  if (!cp) {
    await db.prepare(`INSERT INTO carparks (id, name, address, phone, email, capacity) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(1,
        process.env.CARPARK_NAME    || 'BOI Car Storage Yard',
        process.env.CARPARK_ADDRESS || 'Bay of Islands, Northland, New Zealand',
        process.env.CARPARK_PHONE   || '+64 9 000 0000',
        process.env.SMTP_USER       || 'admin@carparkyard.co.nz',
        100);
  }

  // First admin user: only when there are zero users, and only if env vars are set (no hardcoded credentials).
  const userCountRow = await db.prepare('SELECT COUNT(*) as c FROM users').get();
  const userCount = userCountRow && userCountRow.c != null ? Number(userCountRow.c) : 0;
  if (userCount === 0) {
    const initUser = (process.env.INITIAL_ADMIN_USERNAME || '').trim();
    const initPass = process.env.INITIAL_ADMIN_PASSWORD || '';
    const initName = (process.env.INITIAL_ADMIN_NAME || 'Administrator').trim() || 'Administrator';
    if (initUser && initPass.length >= 6) {
      const hash = bcrypt.hashSync(initPass, 10);
      await db.prepare(`INSERT INTO users (username, password, name, email, role, carpark_id) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(initUser, hash, initName, '', 'admin', 1);
      console.log('[DB] Created initial admin user from INITIAL_ADMIN_USERNAME / INITIAL_ADMIN_PASSWORD');
    } else {
      console.warn('[DB] No users found. Set INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD (min 6 characters) in the environment, then restart, or insert a user manually.');
    }
  }

  // Pricing rules
  const priceRow = await db.prepare(`SELECT id FROM pricing_rules WHERE carpark_id = 1 AND customer_type = 'short'`).get();
  if (!priceRow) {
    const ip = db.prepare(`INSERT INTO pricing_rules (carpark_id, customer_type, days_from, days_to, daily_rate, description) VALUES (?, ?, ?, ?, ?, ?)`);
    await ip.run(1, 'short',  1,  1, 18.00, '1 day');
    await ip.run(1, 'short',  2,  3, 16.00, '2-3 days');
    await ip.run(1, 'short',  4,  7, 14.00, '4-7 days');
    await ip.run(1, 'short',  8, 14, 12.00, '8-14 days');
    await ip.run(1, 'short', 15, 30, 10.00, '15-30 days');
    await ip.run(1, 'short', 31, null, 8.00, '31+ days');
  }

  // Key box (60 keys)
  const keyRow = await db.prepare('SELECT id FROM key_box WHERE carpark_id = 1').get();
  if (!keyRow) {
    const ik = db.prepare('INSERT OR IGNORE INTO key_box (carpark_id, key_number, status) VALUES (?, ?, ?)');
    for (let i = 1; i <= 60; i++) await ik.run(1, i, 'available');
  }

  // LT locker slots (seed 60 slots, then ensure any assigned LT slots also exist)
  const ltSlotRow = await db.prepare('SELECT id FROM lt_key_slots WHERE carpark_id = 1').get();
  if (!ltSlotRow) {
    const ils = db.prepare('INSERT OR IGNORE INTO lt_key_slots (carpark_id, key_number, active) VALUES (?, ?, 1)');
    for (let i = 1; i <= 60; i++) await ils.run(1, i);
  }
  try {
    await db.prepare(`
      INSERT OR IGNORE INTO lt_key_slots (carpark_id, key_number, active)
      SELECT carpark_id, lt_key_slot, 1
      FROM longterm_customers
      WHERE lt_key_slot IS NOT NULL AND lt_key_slot > 0
    `).run();
  } catch (_) {}

  // Account customers
  const acctRow = await db.prepare('SELECT id FROM account_customers WHERE carpark_id = 1').get();
  if (!acctRow) {
    const ia = db.prepare(`INSERT INTO account_customers (company_name, contact_name, phone, email, billing_email, payment_link, carpark_id) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    await ia.run('CTM Corrections Travel Team', 'John Smith',  '09 000 0001', 'accounts@ctm.co.nz',      'accounts@ctm.co.nz',      '', 1);
    await ia.run('Far North District Council',  'Sarah Jones', '09 000 0002', 'accounts@fndc.govt.nz',    'accounts@fndc.govt.nz',    '', 1);
    await ia.run('Top Energy',                  'Mike Brown',  '09 000 0003', 'accounts@topenergy.co.nz', 'accounts@topenergy.co.nz', '', 1);
  }

  // Long-term customers
  const ltRow = await db.prepare('SELECT id FROM longterm_customers WHERE carpark_id = 1').get();
  if (!ltRow) {
    const il = db.prepare(`INSERT INTO longterm_customers (lt_number, name, rego_1, rego_2, phone, rate, carpark_id) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    await il.run('LT1',  'Melissa Gate',    'GUA500', '',       '',             120.00, 1);
    await il.run('LT2',  'Steve Hindmarsh', 'GZK80',  '',       '0279601425',   120.00, 1);
    await il.run('LT3',  'Ben Dalton',      'QTB341', '',       '021432566',    120.00, 1);
    await il.run('LT4',  'Franco Lovrich',  'ZS6398', '',       '02041802939',  120.00, 1);
    await il.run('LT5',  'Jan Carter',      'KDS554', '',       '',             120.00, 1);
    await il.run('LT6',  'Tony Chapman',    'LNP252', 'EUT929', '0272428605',   120.00, 1);
    await il.run('LT7',  'Adam Parore',     'AWY148', '',       '021781250',    120.00, 1);
    await il.run('LT8',  'Geoff Tane',      'KXN786', '',       '',             120.00, 1);
    await il.run('LT9',  'Paul Houghton',   'PKB220', '',       '021549833',    120.00, 1);
    await il.run('LT10', 'Helen Rodgers',   'LDT299', '',       '',             120.00, 1);
    await il.run('LT11', 'Chris Moore',     'HVX801', '',       '0276543219',   120.00, 1);
    await il.run('LT12', 'Jane Baker',      'GUW543', '',       '',             120.00, 1);
    await il.run('LT13', 'Tony Packer',     'NPL423', 'CAB309', '0211234567',   120.00, 1);
    await il.run('LT14', 'Sam Wheeler',     'PWX311', '',       '',             120.00, 1);
    await il.run('LT15', 'Bob Williams',    'HYP677', '',       '0279876543',   120.00, 1);
  }

  // Sample customers
  const custRow = await db.prepare('SELECT id FROM customers WHERE carpark_id = 1').get();
  if (!custRow) {
    const ic = db.prepare(`INSERT INTO customers (first_name, last_name, phone, email, carpark_id) VALUES (?, ?, ?, ?, ?)`);
    await ic.run('Michael', 'Knight',  '02102624420', 'michael@email.com', 1);
    await ic.run('Adelice', 'Whitaker','0212277897',  'adelice@email.com', 1);
    await ic.run('Maurice', 'Daniels', '0274133677',  'maurice@email.com', 1);
  }

  // Sample invoices
  const todayStr = new Date().toISOString().split('T')[0];
  const invRow = await db.prepare('SELECT id FROM invoices WHERE carpark_id = 1').get();
  if (!invRow) {
    const ii = db.prepare(`INSERT INTO invoices
      (invoice_number, carpark_id, customer_id, account_customer_id, key_number, rego,
       first_name, last_name, phone, email, date_in, time_in, return_date, return_time,
       stay_nights, total_price, paid_status, payment_amount, payment_amount_2, staff_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    await ii.run(18974, 1, 1, null, 25, 'NZC356',
      'Michael', 'Knight', '02102624420', 'michael@email.com',
      todayStr, '14:37', todayStr, '14:35', 3, 48.00, 'Eftpos', 48.00, 0, 1);

    await ii.run(18978, 1, 2, 1, 4, 'ESKPE',
      'Adelice', 'Whitaker', '0212277897', 'adelice@email.com',
      todayStr, '10:00', todayStr, '17:05', 2, 33.00, 'OnAcc', 33.00, 0, 1);

    await ii.run(18973, 1, 3, null, 22, 'KJM451',
      'Maurice', 'Daniels', '0274133677', 'maurice@email.com',
      todayStr, '09:00', todayStr, '17:05', 3, 43.20, 'Eftpos', 43.20, 0, 1);

    await db.prepare("UPDATE key_box SET status = 'in_use', invoice_id = 1, longterm_customer_id = NULL, holder_type = 'invoice' WHERE carpark_id = 1 AND key_number = 25").run();
    await db.prepare("UPDATE key_box SET status = 'in_use', invoice_id = 2, longterm_customer_id = NULL, holder_type = 'invoice' WHERE carpark_id = 1 AND key_number = 4").run();
    await db.prepare("UPDATE key_box SET status = 'in_use', invoice_id = 3, longterm_customer_id = NULL, holder_type = 'invoice' WHERE carpark_id = 1 AND key_number = 22").run();
  }

  saveToDisk();
  console.log('[DB] Database ready');
}

// Wipe and re-initialise (called by admin /reset-db endpoint)
async function resetDatabase() {
  _db  = null;
  await initializeDatabase();
}

module.exports = { db, initializeDatabase, resetDatabase };
