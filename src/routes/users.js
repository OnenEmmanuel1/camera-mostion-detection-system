'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getDb } = require('../db/database');
const AuditService = require('../services/audit');

const router = express.Router();
const audit = new AuditService();

router.use('/users', requireAuth, requireRole('Administrator'));

router.get('/users', (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT user_id, username, role, active, created_at
    FROM users
    ORDER BY created_at ASC
  `).all();

  const successMessage = req.query.success || null;
  const errorMessage = req.query.error || null;

  res.render('layouts/main', {
    pageTitle: 'User Accounts - ISSS',
    view: 'users/index',
    users,
    successMessage,
    errorMessage,
    activeNav: 'users'
  });
});

router.post('/users', async (req, res) => {
  const { username, password, role } = req.body;

  if (!username || !password || !role) {
    return res.redirect('/users?error=All+fields+are+required');
  }

  const cleanUsername = String(username).trim();
  if (!/^[a-zA-Z0-9_\-]{3,30}$/.test(cleanUsername)) {
    return res.redirect('/users?error=Username+must+be+3-30+alphanumeric+characters');
  }

  if (password.length < 8) {
    return res.redirect('/users?error=Password+must+be+at+least+8+characters+long');
  }

  if (!['Administrator', 'Viewer'].includes(role)) {
    return res.redirect('/users?error=Invalid+role+selected');
  }

  try {
    const db = getDb();
    const existing = db.prepare('SELECT user_id FROM users WHERE username = ?').get(cleanUsername);
    if (existing) {
      return res.redirect('/users?error=Username+already+exists');
    }

    const saltRounds = 12;
    const hash = await bcrypt.hash(password, saltRounds);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO users (username, password_hash, role, active, created_at)
      VALUES (?, ?, ?, 1, ?)
    `).run(cleanUsername, hash, role, now);

    audit.log({
      userId: req.user.user_id,
      action: 'UserCreated',
      outcome: 'Success',
      ipAddress: req.ip,
      details: { newUsername: cleanUsername, role }
    });

    res.redirect('/users?success=User+created+successfully');
  } catch (err) {
    console.error('[Users] Error creating user:', err.message);
    res.redirect(`/users?error=${encodeURIComponent(err.message)}`);
  }
});

router.post('/users/:id/toggle', (req, res) => {
  const targetId = parseInt(req.params.id, 10);

  // Prevent administrator from deactivating their own account
  if (targetId === req.user.user_id) {
    return res.redirect('/users?error=You+cannot+deactivate+your+own+account');
  }

  try {
    const db = getDb();
    const target = db.prepare('SELECT user_id, username, active FROM users WHERE user_id = ?').get(targetId);
    if (!target) {
      return res.redirect('/users?error=User+not+found');
    }

    const newStatus = target.active === 1 ? 0 : 1;
    db.prepare('UPDATE users SET active = ? WHERE user_id = ?').run(newStatus, targetId);

    audit.log({
      userId: req.user.user_id,
      action: newStatus === 1 ? 'UserActivated' : 'UserDeactivated',
      outcome: 'Success',
      ipAddress: req.ip,
      details: { targetUserId: targetId, username: target.username }
    });

    res.redirect(`/users?success=User+status+updated`);
  } catch (err) {
    console.error('[Users] Error toggling user status:', err.message);
    res.redirect(`/users?error=${encodeURIComponent(err.message)}`);
  }
});

router.post('/users/:id/reset-password', async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const { new_password } = req.body;

  if (!new_password || new_password.length < 8) {
    return res.redirect('/users?error=Password+must+be+at+least+8+characters+long');
  }

  try {
    const db = getDb();
    const target = db.prepare('SELECT user_id, username FROM users WHERE user_id = ?').get(targetId);
    if (!target) {
      return res.redirect('/users?error=User+not+found');
    }

    const hash = await bcrypt.hash(new_password, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE user_id = ?').run(hash, targetId);

    audit.log({
      userId: req.user.user_id,
      action: 'UserPasswordReset',
      outcome: 'Success',
      ipAddress: req.ip,
      details: { targetUserId: targetId, username: target.username }
    });

    res.redirect('/users?success=Password+reset+successfully');
  } catch (err) {
    console.error('[Users] Error resetting password:', err.message);
    res.redirect(`/users?error=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;
