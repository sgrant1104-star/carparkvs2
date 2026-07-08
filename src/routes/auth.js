const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../database');
const { getSessionSecret } = require('../utils/config');
const router = express.Router();

const JWT_SECRET  = () => getSessionSecret();
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 8 * 60 * 60 * 1000
};

// ─── Basic brute-force mitigation ──────────────────────────────────────────
// In-memory only (resets on restart, not shared across serverless instances)
// but it's a real improvement over "no limit at all": 5 bad passwords for a
// given username+IP locks that combination out for 15 minutes.
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map(); // key -> { count, lockedUntil }

function attemptKey(req, username) {
  return `${req.ip || 'unknown'}:${String(username || '').trim().toLowerCase()}`;
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

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const u = String(username).trim();
  const key = attemptKey(req, u);
  if (isLocked(key)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
  }

  const user = await db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(u);
  if (!user) { recordFailure(key); return res.status(401).json({ error: 'Invalid username or password' }); }

  const valid = bcrypt.compareSync(password, user.password);
  if (!valid) { recordFailure(key); return res.status(401).json({ error: 'Invalid username or password' }); }

  clearAttempts(key);
  const token = jwt.sign(
    { userId: user.id, username: user.username, name: user.name, role: user.role, carparkId: user.carpark_id },
    JWT_SECRET(),
    { expiresIn: '8h' }
  );
  res.cookie('auth_token', token, COOKIE_OPTS);
  res.json({ success: true, user: { id: user.id, username: user.username, name: user.name, role: user.role, carparkId: user.carpark_id } });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('auth_token', { httpOnly: true, sameSite: 'lax' });
  req.session = {};
  res.json({ success: true });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ id: req.session.userId, username: req.session.username, name: req.session.name, role: req.session.role, carparkId: req.session.carparkId });
});

module.exports = router;
