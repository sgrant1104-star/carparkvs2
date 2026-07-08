const express = require('express');
const { db } = require('../database');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { search } = req.query;
    let query = 'SELECT * FROM customers WHERE carpark_id = ? AND active = 1';
    const params = [carparkId];
    if (search) {
      query += ` AND (last_name LIKE ? OR first_name LIKE ? OR phone LIKE ? OR email LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    query += ' ORDER BY last_name, first_name LIMIT 50';
    const customers = await db.prepare(query).all(...params);
    res.json(customers);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const customer = await db.prepare('SELECT * FROM customers WHERE id = ? AND active = 1').get(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const invoices = await db.prepare('SELECT * FROM invoices WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10').all(req.params.id);
    res.json({ ...customer, invoices });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const carparkId = req.session.carparkId || 1;
    const { first_name, last_name, phone, email, notes, alert_message } = req.body;
    const result = await db.prepare(`INSERT INTO customers (first_name, last_name, phone, email, notes, alert_message, carpark_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(first_name, last_name, phone, email, notes, alert_message, carparkId);
    const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(customer);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { first_name, last_name, phone, email, notes, alert_message } = req.body;
    await db.prepare(`UPDATE customers SET first_name = ?, last_name = ?, phone = ?, email = ?, notes = ?, alert_message = ? WHERE id = ?`)
      .run(first_name, last_name, phone, email, notes, alert_message, req.params.id);
    const customer = await db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    res.json(customer);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
