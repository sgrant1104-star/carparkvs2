const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { db } = require('../database');
const { getSessionSecret } = require('../utils/config');
const { getTransporter, emailFrom, smtpErrorMessage } = require('../utils/mailer');
const router = express.Router();

const JWT_SECRET  = () => getSessionSecret();
const COOKIE_NAME = 'customer_auth_token';
// `secure` is derived per-request from req.secure (see the matching comment
// in src/routes/auth.js) so this cookie is marked Secure in production
// without breaking local plain-HTTP dev.
const cookieOpts = (req) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: req.secure,
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days — customers shouldn't need to re-login every 8h like staff
});
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─── Basic brute-force mitigation (same shape as src/routes/auth.js) ───────
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map(); // key -> { count, lockedUntil }

function attemptKey(prefix, req, identifier) {
  return `${prefix}:${req.ip || 'unknown'}:${String(identifier || '').trim().toLowerCase()}`;
}
function isLocked(key) {
  const rec = attempts.get(key);
  if (!rec || !rec.lockedUntil) return false;
  if (Date.now() > rec.lockedUntil) { attempts.delete(key); return false; }
  return true;
}
function recordFailure(key) {
  const rec = attempts.get(key) || { count: 0, lockedUntil: null };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) rec.lockedUntil = Date.now() + WINDOW_MS;
  attempts.set(key, rec);
}
function clearAttempts(key) {
  attempts.delete(key);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getBaseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

function signCustomerToken(customer) {
  return jwt.sign(
    { type: 'customer', customerId: customer.id, email: customer.email, firstName: customer.first_name },
    JWT_SECRET(),
    { expiresIn: '30d' }
  );
}

function publicProfile(c) {
  return {
    id: c.id,
    firstName: c.first_name,
    lastName: c.last_name,
    email: c.email,
    phone: c.phone,
  };
}

// POST /api/customer-auth/register
router.post('/register', async (req, res) => {
  try {
    const firstName = String(req.body?.firstName || '').trim();
    const lastName  = String(req.body?.lastName || '').trim();
    const phone     = String(req.body?.phone || '').trim();
    const email     = normalizeEmail(req.body?.email);
    const password  = String(req.body?.password || '');

    if (!firstName || !lastName) return res.status(400).json({ error: 'First and last name are required' });
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    // Same brute-force guard as login/forgot-password — without this, an
    // attacker could hammer this endpoint to mass-enumerate which emails
    // already have an account (via the 409 below) or spam-create accounts.
    const key = attemptKey('register', req, email);
    if (isLocked(key)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    recordFailure(key);

    const existing = await db.prepare('SELECT id FROM customer_accounts WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

    const passwordHash = bcrypt.hashSync(password, 10);
    const result = await db.prepare(`
      INSERT INTO customer_accounts (first_name, last_name, email, phone, password_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run(firstName, lastName, email, phone || null, passwordHash);

    const customer = await db.prepare('SELECT * FROM customer_accounts WHERE id = ?').get(result.lastInsertRowid);
    const token = signCustomerToken(customer);
    res.cookie(COOKIE_NAME, token, cookieOpts(req));
    res.status(201).json({ success: true, customer: publicProfile(customer) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/customer-auth/login
router.post('/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const key = attemptKey('login', req, email);
    if (isLocked(key)) return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });

    const customer = await db.prepare('SELECT * FROM customer_accounts WHERE email = ?').get(email);
    if (!customer) { recordFailure(key); return res.status(401).json({ error: 'Invalid email or password' }); }

    const valid = bcrypt.compareSync(password, customer.password_hash);
    if (!valid) { recordFailure(key); return res.status(401).json({ error: 'Invalid email or password' }); }

    clearAttempts(key);
    const token = signCustomerToken(customer);
    res.cookie(COOKIE_NAME, token, cookieOpts(req));
    res.json({ success: true, customer: publicProfile(customer) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/customer-auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax' });
  req.customerSession = {};
  res.json({ success: true });
});

// GET /api/customer-auth/me
// Deliberately does NOT use requireCustomerAuth: this endpoint is polled by
// every portal page via fetch() to silently check login state, and fetch()
// follows redirects transparently — a 302 here would resolve to login.html's
// 200 OK HTML, making r.ok true even when logged out. Always return JSON.
router.get('/me', async (req, res) => {
  if (!req.customerSession || !req.customerSession.customerId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const customer = await db.prepare('SELECT * FROM customer_accounts WHERE id = ?').get(req.customerSession.customerId);
    if (!customer) return res.status(401).json({ error: 'Not authenticated' });
    res.json(publicProfile(customer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/customer-auth/forgot-password
// Always responds with a generic success message, whether or not the email
// matches an account — avoids leaking which emails are registered.
router.post('/forgot-password', async (req, res) => {
  const GENERIC_OK = { success: true, message: 'If an account exists for that email, a reset link has been sent.' };
  try {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });

    const key = attemptKey('forgot', req, email);
    if (isLocked(key)) return res.status(429).json({ error: 'Too many requests. Try again in a few minutes.' });
    recordFailure(key); // counts requests regardless of outcome, so this can't be used to spam one inbox

    const customer = await db.prepare('SELECT * FROM customer_accounts WHERE email = ?').get(email);
    if (!customer) return res.json(GENERIC_OK);

    const transporter = getTransporter();
    if (!transporter) {
      console.warn('[customer-auth] Password reset requested but SMTP is not configured.');
      return res.json(GENERIC_OK);
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    await db.prepare('UPDATE customer_accounts SET reset_token = ?, reset_token_expires = ? WHERE id = ?')
      .run(token, expires, customer.id);

    const resetUrl = `${getBaseUrl(req)}/portal/reset-password.html?token=${token}`;
    const html = `<!DOCTYPE html><html><body style="font-family:Arial;max-width:600px;margin:0 auto;padding:20px;">
      <h2 style="color:#1a5276;">BOI Car Storage — Reset your password</h2>
      <p>Hi ${customer.first_name},</p>
      <p>We received a request to reset your password. Click the button below to choose a new one — this link expires in 1 hour.</p>
      <p style="margin:24px 0;"><a href="${resetUrl}" style="background:#1a5276;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">Reset Password</a></p>
      <p style="color:#666;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>
    </body></html>`;

    try {
      await transporter.sendMail({
        from: emailFrom(),
        to: customer.email,
        subject: 'BOI Car Storage — Reset your password',
        html,
      });
    } catch (err) {
      console.error('[customer-auth] Failed to send reset email:', smtpErrorMessage(err));
    }

    res.json(GENERIC_OK);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/customer-auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    const password = String(req.body?.password || '');
    if (!token) return res.status(400).json({ error: 'Reset token is required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const customer = await db.prepare('SELECT * FROM customer_accounts WHERE reset_token = ?').get(token);
    if (!customer || !customer.reset_token_expires || new Date(customer.reset_token_expires) < new Date()) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    await db.prepare('UPDATE customer_accounts SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?')
      .run(passwordHash, customer.id);

    res.json({ success: true, message: 'Password updated. You can now log in.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
