const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { getSessionSecret } = require('../utils/config');
const router = express.Router();

const JWT_SECRET = () => getSessionSecret();
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 8 * 60 * 60 * 1000,
};

// GET /api/admin/activity-log?table=invoices&record_id=123&from=&to=&limit=200
// Audit trail viewer — who changed/voided/deleted what, and what it looked
// like before/after. Admin-only since it can contain full row snapshots.
router.get('/activity-log', requireAuth, requireAdmin, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { table, record_id, from, to, action } = req.query;
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 200);

    const clauses = ['carpark_id = ?'];
    const params = [carparkId];
    if (table) { clauses.push('table_name = ?'); params.push(table); }
    if (record_id) { clauses.push('record_id = ?'); params.push(record_id); }
    if (action) { clauses.push('action = ?'); params.push(action); }
    if (from) { clauses.push("date(created_at) >= date(?)"); params.push(from); }
    if (to) { clauses.push("date(created_at) <= date(?)"); params.push(to); }

    const rows = await db.prepare(`
      SELECT * FROM activity_log
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `).all(...params);

    const parsed = rows.map(r => ({
      ...r,
      before: r.before_json ? JSON.parse(r.before_json) : null,
      after: r.after_json ? JSON.parse(r.after_json) : null,
    }));
    res.json(parsed);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await db.prepare('SELECT id, username, name, email, role, active, created_at FROM users WHERE carpark_id = ?').all(req.session.carparkId || 1);
    res.json(users);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { username, password, name, email, role, active } = req.body;
    const existing = await db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return res.status(400).json({ error: 'Username already exists' });
    const hash = bcrypt.hashSync(password, 10);
    const isActive = active === true || active === 1 || active === '1';
    const result = await db.prepare(`INSERT INTO users (username, password, name, email, role, active, carpark_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(username, hash, name, email, role || 'staff', isActive ? 1 : 0, carparkId);
    const user = await db.prepare('SELECT id, username, name, email, role, active FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { username, name, email, role, active, password } = req.body;
    const isActive = active === true || active === 1 || active === '1';

    // If username is being changed, ensure it is unique
    if (username) {
      const existing = await db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.params.id);
      if (existing) return res.status(400).json({ error: 'Username already exists' });
    }

    if (password) {
      const hash = bcrypt.hashSync(password, 10);
      await db.prepare('UPDATE users SET username=?, name=?, email=?, role=?, active=?, password=? WHERE id=?')
        .run(username, name, email, role, isActive ? 1 : 0, hash, req.params.id);
    } else {
      await db.prepare('UPDATE users SET username=?, name=?, email=?, role=?, active=? WHERE id=?')
        .run(username, name, email, role, isActive ? 1 : 0, req.params.id);
    }
    const user = await db.prepare('SELECT id, username, name, email, role, active FROM users WHERE id = ?').get(req.params.id);
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/carparks', requireAuth, requireAdmin, async (req, res) => {
  try {
    const carparks = await db.prepare('SELECT * FROM carparks').all();
    res.json(carparks);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/carparks/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, address, phone, email, capacity, bank_name, bank_account_name, bank_account_number, bank_reference } = req.body;
    await db.prepare(`UPDATE carparks SET name=?, address=?, phone=?, email=?, capacity=?,
      bank_name=?, bank_account_name=?, bank_account_number=?, bank_reference=? WHERE id=?`)
      .run(name, address, phone, email, capacity, bank_name||null, bank_account_name||null, bank_account_number||null, bank_reference||null, req.params.id);
    const carpark = await db.prepare('SELECT * FROM carparks WHERE id = ?').get(req.params.id);
    res.json(carpark);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/pricing', requireAuth, requireAdmin, async (req, res) => {
  try {
    const rules = await db.prepare('SELECT * FROM pricing_rules WHERE carpark_id = ? ORDER BY customer_type, days_from').all(req.session.carparkId || 1);
    res.json(rules);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/pricing', requireAuth, requireAdmin, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { customer_type, days_from, days_to, daily_rate, description } = req.body;
    const result = await db.prepare(`INSERT INTO pricing_rules (carpark_id, customer_type, days_from, days_to, daily_rate, description) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(carparkId, customer_type, days_from, days_to || null, daily_rate, description);
    const rule = await db.prepare('SELECT * FROM pricing_rules WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(rule);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/pricing/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { days_from, days_to, daily_rate, description, active } = req.body;
    await db.prepare('UPDATE pricing_rules SET days_from=?, days_to=?, daily_rate=?, description=?, active=? WHERE id=?')
      .run(days_from, days_to || null, daily_rate, description, active ? 1 : 0, req.params.id);
    const rule = await db.prepare('SELECT * FROM pricing_rules WHERE id = ?').get(req.params.id);
    res.json(rule);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/pricing/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.prepare('DELETE FROM pricing_rules WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/staff-list', requireAuth, async (req, res) => {
  try {
    const staff = await db.prepare('SELECT id, name FROM users WHERE carpark_id = ? AND active = 1 ORDER BY name').all(req.session.carparkId || 1);
    res.json(staff);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/admin/me — change own username and/or password (current password required)
router.put('/me', requireAuth, async (req, res) => {
  try {
    const { current_password, new_username, new_password, new_password_confirm } = req.body;
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!current_password || !bcrypt.compareSync(current_password, user.password)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const nuRaw = new_username != null ? String(new_username).trim() : '';
    const pwRaw = new_password != null ? String(new_password) : '';

    if (!nuRaw && !pwRaw) {
      return res.status(400).json({ error: 'Enter a new username and/or new password' });
    }

    let nextUsername = user.username;
    let nextHash = user.password;

    if (nuRaw) {
      if (nuRaw.length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters' });
      const taken = await db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(nuRaw, user.id);
      if (taken) return res.status(400).json({ error: 'Username already taken' });
      nextUsername = nuRaw;
    }

    if (pwRaw) {
      if (pwRaw.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
      if (pwRaw !== String(new_password_confirm || '')) {
        return res.status(400).json({ error: 'New passwords do not match' });
      }
      nextHash = bcrypt.hashSync(pwRaw, 10);
    }

    await db.prepare('UPDATE users SET username = ?, password = ? WHERE id = ?').run(nextUsername, nextHash, user.id);

    const updated = await db.prepare(
      'SELECT id, username, name, email, role, carpark_id FROM users WHERE id = ?'
    ).get(req.session.userId);

    const token = jwt.sign(
      {
        userId: updated.id,
        username: updated.username,
        name: updated.name,
        role: updated.role,
        carparkId: updated.carpark_id,
      },
      JWT_SECRET(),
      { expiresIn: '8h' }
    );
    res.cookie('auth_token', token, COOKIE_OPTS);
    res.json({ success: true, user: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
