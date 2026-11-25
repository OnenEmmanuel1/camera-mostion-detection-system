'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const { getDb } = require('../db/database');
const AuditService = require('../services/audit');
const { loginLimiter } = require('../middleware/rateLimiter');

const router = express.Router();
const audit = new AuditService();

router.get('/login', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect('/dashboard');
  }

  let errorMessage = null;
  if (req.query.error === 'account_disabled') {
    errorMessage = 'Your account has been deactivated. Please contact an administrator.';
  } else if (req.query.error === 'invalid') {
    errorMessage = 'Invalid username or password.';
  }

  res.render('auth/login', {
    pageTitle: 'Sign In - ISSS',
    errorMessage,
    csrfToken: req.session ? req.session.csrfToken : ''
  });
});

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const ipAddress = req.ip;

  if (!username || !password) {
    return res.status(400).render('auth/login', {
      pageTitle: 'Sign In - ISSS',
      errorMessage: 'Invalid username or password.',
      csrfToken: req.session.csrfToken
    });
  }

  try {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());

    if (!user) {
      // Timing attack mitigation: always run bcrypt compare even if user not found
      await bcrypt.compare(password, '$2b$12$e8xL4zJ5gI0w8o0N6r7Niu1V8B8A7j9K6P5L4M3N2O1P0Q9R8S7Tu');
      audit.log({
        userId: null,
        action: 'UserLoginFailed',
        outcome: 'Failure',
        ipAddress,
        details: { attemptedUsername: username, reason: 'User not found' }
      });
      return res.status(401).render('auth/login', {
        pageTitle: 'Sign In - ISSS',
        errorMessage: 'Invalid username or password.',
        csrfToken: req.session.csrfToken
      });
    }

    if (user.active !== 1) {
      audit.log({
        userId: user.user_id,
        action: 'UserLoginFailed',
        outcome: 'Failure',
        ipAddress,
        details: { username: user.username, reason: 'Account disabled' }
      });
      return res.status(401).render('auth/login', {
        pageTitle: 'Sign In - ISSS',
        errorMessage: 'Invalid username or password.',
        csrfToken: req.session.csrfToken
      });
    }

    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) {
      audit.log({
        userId: user.user_id,
        action: 'UserLoginFailed',
        outcome: 'Failure',
        ipAddress,
        details: { username: user.username, reason: 'Password mismatch' }
      });
      return res.status(401).render('auth/login', {
        pageTitle: 'Sign In - ISSS',
        errorMessage: 'Invalid username or password.',
        csrfToken: req.session.csrfToken
      });
    }

    // Login successful
    req.session.userId = user.user_id;
    req.session.username = user.username;
    req.session.role = user.role;

    audit.log({
      userId: user.user_id,
      action: 'UserLoginSuccess',
      outcome: 'Success',
      ipAddress,
      details: { role: user.role }
    });

    req.session.save(() => {
      res.redirect('/dashboard');
    });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).render('auth/login', {
      pageTitle: 'Sign In - ISSS',
      errorMessage: 'An internal error occurred. Please try again.',
      csrfToken: req.session.csrfToken
    });
  }
});

router.all('/logout', (req, res) => {
  const userId = req.session ? req.session.userId : null;
  const ipAddress = req.ip;

  if (userId) {
    audit.log({
      userId,
      action: 'UserLogout',
      outcome: 'Success',
      ipAddress
    });
  }

  if (req.session) {
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.redirect('/login');
    });
  } else {
    res.redirect('/login');
  }
});

module.exports = router;
