'use strict';

const rateLimit = require('express-rate-limit');

// Strict rate limiting on login to defend against credential brute-forcing
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many login attempts from this address. Please try again after 15 minutes.'
  },
  handler: (req, res, next, options) => {
    if (req.path.startsWith('/api/')) {
      return res.status(429).json(options.message);
    }
    return res.status(429).render('auth/login', {
      pageTitle: 'Login - ISSS',
      errorMessage: 'Too many failed login attempts. Please wait 15 minutes before trying again.',
      csrfToken: req.session ? req.session.csrfToken : ''
    });
  }
});

// General API rate limiter
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = {
  loginLimiter,
  apiLimiter
};
