'use strict';

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const session = require('express-session');
const { config } = require('./config');
const SqliteSessionStore = require('./db/sessionStore');
const csrfMiddleware = require('./middleware/csrf');

// Import routes
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const cameraRoutes = require('./routes/cameras');
const eventsRoutes = require('./routes/events');
const liveRoutes = require('./routes/live');
const settingsRoutes = require('./routes/settings');
const usersRoutes = require('./routes/users');
const auditRoutes = require('./routes/audit');
const helpRoutes = require('./routes/help');
const mediaRoutes = require('./routes/media');

// Import API routes
const apiHealthRoutes = require('./routes/api/health');
const apiEventsRoutes = require('./routes/api/events');
const apiSensorRoutes = require('./routes/api/sensor');
const apiStreamRoutes = require('./routes/api/stream');

function createApp() {
  const app = express();

  // Trust proxy for reverse proxy setups (e.g. Caddy/Nginx)
  app.set('trust proxy', 1);

  // Security Headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // Allow UI interaction scripts
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false
  }));

  // Body parsers
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(express.json({ limit: '2mb' }));

  // Static Assets
  app.use('/public', express.static(path.join(config.ROOT_DIR, 'public'), {
    maxAge: '1d'
  }));

  // Persistent SQLite Session Store
  app.use(session({
    store: new SqliteSessionStore(),
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: 'isss.sid',
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
  }));

  // View Engine Setup (EJS)
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.ROOT_DIR, 'views'));
  // Keep demo/development templates fresh while the UI is being iterated.
  app.set('view cache', config.APP_ENV === 'production');

  // Global locals for views
  app.use((req, res, next) => {
    res.locals.appName = 'ISSS - IoT-Based Smart Surveillance System';
    res.locals.softwareVersion = config.SOFTWARE_VERSION;
    res.locals.appEnv = config.APP_ENV;
    res.locals.displayTz = config.DISPLAY_TZ;
    res.locals.currentUser = req.session && req.session.userId ? {
      userId: req.session.userId,
      username: req.session.username,
      role: req.session.role
    } : null;
    res.locals.lastCameraStatus = req.app.locals.cameraManager
      ? req.app.locals.cameraManager.getAggregateStatus()
      : (req.app.locals.lastCameraStatus || { status: 'Unknown' });
    res.locals.activeNav = '';
    res.locals.error = null;
    res.locals.success = null;
    next();
  });

  // CSRF errors can render a page, so establish the view locals first.
  app.use(csrfMiddleware);

  // Base Redirect
  app.get('/', (req, res) => {
    if (req.session && req.session.userId) {
      return res.redirect('/dashboard');
    }
    res.redirect('/login');
  });

  // Mount Application Routes
  app.use('/', authRoutes);
  app.use('/', dashboardRoutes);
  app.use('/', cameraRoutes);
  app.use('/', eventsRoutes);
  app.use('/', liveRoutes);
  app.use('/', settingsRoutes);
  app.use('/', usersRoutes);
  app.use('/', auditRoutes);
  app.use('/', helpRoutes);
  app.use('/', mediaRoutes);

  // Mount API Routes
  app.use('/api', apiHealthRoutes);
  app.use(apiSensorRoutes);                 // machine-to-machine, no session auth
  app.use('/api/events', apiEventsRoutes); // session-auth'd; mount at specific prefix to avoid overlap
  app.use('/api', apiStreamRoutes);

  // 404 Handler
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Endpoint not found' });
    }
    res.status(404).render('layouts/main', {
      pageTitle: '404 Not Found - ISSS',
      view: 'auth/notFound',
      error: 'The requested page does not exist.'
    });
  });

  // Global Error Handler
  app.use((err, req, res, next) => {
    console.error(`[Express] Unhandled Error [${req.method} ${req.url}]:`, err);
    if (req.path.startsWith('/api/')) {
      return res.status(500).json({ error: 'Internal server error' });
    }
    res.status(500).render('layouts/main', {
      pageTitle: '500 Server Error - ISSS',
      view: 'auth/error',
      error: 'An internal system error occurred. Please contact the administrator.'
    });
  });

  return app;
}

module.exports = createApp;
