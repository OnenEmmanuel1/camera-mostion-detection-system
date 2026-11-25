'use strict';

const { getDb } = require('../db/database');
const AuditService = require('../services/audit');

const audit = new AuditService();

function isApiRequest(req) {
  return (req.originalUrl || req.path || '').split('?')[0].startsWith('/api/');
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    if (isApiRequest(req)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    return res.redirect('/login');
  }

  // Check if account is still active in database
  const db = getDb();
  const user = db.prepare('SELECT user_id, username, role, active FROM users WHERE user_id = ?').get(req.session.userId);

  if (!user || user.active !== 1) {
    req.session.destroy(() => {
      if (isApiRequest(req)) {
        return res.status(401).json({ error: 'Account inactive or disabled' });
      }
      return res.redirect('/login?error=account_disabled');
    });
    return;
  }

  req.user = user;
  res.locals.currentUser = user;
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session || !req.session.userId) {
      if (isApiRequest(req)) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      return res.redirect('/login');
    }

    if (req.session.role !== role) {
      // Record denied access in audit log
      audit.log({
        userId: req.session.userId,
        action: 'AccessDenied',
        outcome: 'Denied',
        ipAddress: req.ip,
        details: { path: req.originalUrl, requiredRole: role, userRole: req.session.role }
      });

      if (isApiRequest(req)) {
        return res.status(403).json({ error: 'Forbidden: Insufficient privileges' });
      }
      return res.status(403).render('layouts/main', {
        pageTitle: '403 Forbidden - ISSS',
        view: 'auth/forbidden',
        error: 'You do not have permission to access this resource.'
      });
    }

    next();
  };
}

module.exports = {
  requireAuth,
  requireRole
};
