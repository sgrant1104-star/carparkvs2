const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { releaseKey } = require('../utils/keyBoxSync');
const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const standardKeys = await db.prepare(`
      SELECT k.*, i.invoice_number, i.first_name, i.last_name, i.rego, i.return_date,
             lt.lt_number, lt.name as lt_name, lt.rego_1 as lt_rego_1, lt.rego_2 as lt_rego_2
      FROM key_box k
      LEFT JOIN invoices i ON k.invoice_id = i.id AND i.void = 0
      LEFT JOIN longterm_customers lt ON k.longterm_customer_id = lt.id
      WHERE k.carpark_id = ? AND COALESCE(k.holder_type,'standard') != 'longterm'
      ORDER BY k.key_number
    `).all(carparkId);
    const ltKeys = await db.prepare(`
      SELECT
        s.id as slot_id,
        s.key_number,
        lt.id as longterm_customer_id,
        lt.lt_number,
        lt.name,
        lt.rego_1,
        lt.rego_2,
        COALESCE(lt.lt_in_yard, 0) as in_yard
      FROM lt_key_slots s
      LEFT JOIN longterm_customers lt
        ON lt.carpark_id = s.carpark_id
       AND lt.active = 1
       AND lt.lt_key_slot = s.key_number
      WHERE s.carpark_id = ? AND s.active = 1
      ORDER BY s.key_number
    `).all(carparkId);

    const available = standardKeys.filter(k => k.status === 'available').length;
    const inUse     = standardKeys.filter(k => k.status === 'in_use').length;
    const ltInYard  = ltKeys.filter(k => Number(k.in_yard) === 1 && k.longterm_customer_id).length;
    res.json({ keys: standardKeys, available, inUse, total: standardKeys.length, ltKeys, ltInYard });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/lt-slots', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const slots = await db.prepare(`
      SELECT
        s.key_number,
        lt.id as longterm_customer_id,
        lt.lt_number,
        lt.name,
        COALESCE(lt.lt_in_yard, 0) as in_yard
      FROM lt_key_slots s
      LEFT JOIN longterm_customers lt
        ON lt.carpark_id = s.carpark_id
       AND lt.active = 1
       AND lt.lt_key_slot = s.key_number
      WHERE s.carpark_id = ? AND s.active = 1
      ORDER BY s.key_number
    `).all(carparkId);
    res.json(slots);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/available', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const keys = await db.prepare("SELECT key_number FROM key_box WHERE carpark_id = ? AND status = 'available' AND COALESCE(holder_type,'available') != 'longterm' ORDER BY key_number").all(carparkId);
    res.json(keys.map(k => k.key_number));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:key_number/release', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    await releaseKey(db, carparkId, req.params.key_number);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/add', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { key_number } = req.body;
    const existing = await db.prepare('SELECT id FROM key_box WHERE carpark_id = ? AND key_number = ?').get(carparkId, key_number);
    if (existing) return res.status(400).json({ error: 'Key number already exists' });
    await db.prepare('INSERT INTO key_box (carpark_id, key_number, status) VALUES (?, ?, ?)').run(carparkId, key_number, 'available');
    res.json({ success: true, key_number });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/lt-slots/add', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const keyNumber = parseInt(req.body?.key_number, 10);
    if (!Number.isFinite(keyNumber) || keyNumber <= 0) {
      return res.status(400).json({ error: 'Valid LT box number required' });
    }
    const existing = await db.prepare('SELECT id, active FROM lt_key_slots WHERE carpark_id = ? AND key_number = ?').get(carparkId, keyNumber);
    if (existing && Number(existing.active) === 1) {
      return res.status(400).json({ error: 'LT box number already exists' });
    }
    if (existing && Number(existing.active) !== 1) {
      await db.prepare('UPDATE lt_key_slots SET active = 1 WHERE id = ?').run(existing.id);
      return res.json({ success: true, key_number: keyNumber, reactivated: true });
    }
    await db.prepare('INSERT INTO lt_key_slots (carpark_id, key_number, active) VALUES (?, ?, 1)').run(carparkId, keyNumber);
    res.json({ success: true, key_number: keyNumber });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/lt-slots/:key_number', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const keyNumber = parseInt(req.params.key_number, 10);
    if (!Number.isFinite(keyNumber) || keyNumber <= 0) {
      return res.status(400).json({ error: 'Invalid LT box number' });
    }
    const slot = await db.prepare('SELECT * FROM lt_key_slots WHERE carpark_id = ? AND key_number = ? AND active = 1').get(carparkId, keyNumber);
    if (!slot) return res.status(404).json({ error: 'LT box not found' });
    const linked = await db.prepare(`
      SELECT id, lt_number, name
      FROM longterm_customers
      WHERE carpark_id = ? AND active = 1 AND lt_key_slot = ?
      LIMIT 1
    `).get(carparkId, keyNumber);
    if (linked) {
      return res.status(400).json({ error: `Cannot remove LT${keyNumber}; assigned to ${linked.lt_number} (${linked.name})` });
    }
    await db.prepare('UPDATE lt_key_slots SET active = 0 WHERE carpark_id = ? AND key_number = ?').run(carparkId, keyNumber);
    res.json({ success: true, key_number: keyNumber });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:key_number', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const keyNumber = parseInt(req.params.key_number, 10);
    if (Number.isNaN(keyNumber)) return res.status(400).json({ error: 'Invalid key number' });
    const key = await db.prepare('SELECT * FROM key_box WHERE carpark_id = ? AND key_number = ?').get(carparkId, keyNumber);
    if (!key) return res.status(404).json({ error: 'Key not found' });
    if (key.status === 'in_use') return res.status(400).json({ error: 'Cannot remove key while it is in use' });
    await db.prepare('DELETE FROM key_box WHERE id = ?').run(key.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
