'use strict';

const crypto = require('crypto');

function csrfMiddleware(req, res, next) {
  // Exclude machine-to-machine sensor ingestion endpoint (authenticated via DEVICE_API_KEY)
  if ((req.originalUrl || req.path || '').split('?')[0] === '/api/device/sensor') {
    return next();
  }

  // Ensure session has a CSRF secret/token
  if (req.session) {
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    res.locals.csrfToken = req.session.csrfToken;
  }

  // State-changing HTTP methods require CSRF validation
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) {
    return next();
  }

  // Check token from form body or headers
  const token = (req.body && req.body._csrf) ||
                req.headers['x-csrf-token'] ||
                req.headers['csrf-token'];

  if (!req.session || !token || token !== req.session.csrfToken) {
    console.warn(`[Security] CSRF validation failed on ${req.method} ${req.path} from IP ${req.ip}`);
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Invalid or missing CSRF token' });
    }
    return res.status(403).render('layouts/main', {
      pageTitle: '403 Forbidden - CSRF Error',
      view: 'auth/csrfError',
      error: 'Security validation failed (CSRF token mismatch). Please refresh the page and try again.'
    });
  }

  next();
}

module.exports = csrfMiddleware;
