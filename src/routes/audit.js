'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const AuditService = require('../services/audit');

const router = express.Router();
const audit = new AuditService();

router.use('/audit', requireAuth, requireRole('Administrator'));

router.get('/audit', (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = 25;
    const offset = (page - 1) * limit;
    const outcome = req.query.outcome || null;
    const action = req.query.action || null;

    const result = audit.getLogs({ limit, offset, outcome, action });

    res.render('layouts/main', {
      pageTitle: 'Security Audit Log - ISSS',
      view: 'audit/index',
      logs: result.logs,
      total: result.total,
      page,
      totalPages: Math.ceil(result.total / limit) || 1,
      query: req.query,
      activeNav: 'audit'
    });
  } catch (err) {
    console.error('[Audit] Error fetching audit logs:', err.message);
    res.status(500).render('layouts/main', {
      pageTitle: 'Audit Log Error - ISSS',
      view: 'audit/index',
      logs: [],
      total: 0,
      page: 1,
      totalPages: 1,
      query: req.query,
      error: 'Failed to retrieve audit records from database.',
      activeNav: 'audit'
    });
  }
});

module.exports = router;
