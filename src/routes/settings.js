'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const ConfigService = require('../services/config');
const AuditService = require('../services/audit');
const StorageService = require('../services/storage');
const { SETTINGS_METADATA } = require('../config');

const router = express.Router();
const configService = new ConfigService();
const audit = new AuditService();
const storage = new StorageService();

router.use('/settings', requireAuth, requireRole('Administrator'));

router.get('/settings', (req, res) => {
  const allSettings = configService.getAll();
  const successMessage = req.query.saved ? 'Settings have been updated successfully.' : null;
  const retentionMessage = req.query.retention_done ? `Retention cleanup executed. Purged ${req.query.count || 0} event(s).` : null;

  res.render('layouts/main', {
    pageTitle: 'System Settings - ISSS',
    view: 'settings/index',
    settings: allSettings,
    metadata: SETTINGS_METADATA,
    successMessage,
    retentionMessage,
    activeNav: 'settings'
  });
});

router.post('/settings', (req, res) => {
  const updates = req.body;
  const errors = [];
  const changedKeys = [];

  for (const [key, meta] of Object.entries(SETTINGS_METADATA)) {
    if (updates[key] !== undefined) {
      const val = updates[key];
      const validation = configService.validate(key, val);
      if (!validation.valid) {
        errors.push(validation.error);
      }
    }
  }

  if (errors.length > 0) {
    const allSettings = configService.getAll();
    return res.status(400).render('layouts/main', {
      pageTitle: 'System Settings - ISSS',
      view: 'settings/index',
      settings: allSettings,
      metadata: SETTINGS_METADATA,
      error: `Validation failed: ${errors.join('; ')}`,
      activeNav: 'settings'
    });
  }

  // Apply all valid settings
  try {
    for (const [key] of Object.entries(SETTINGS_METADATA)) {
      if (updates[key] !== undefined) {
        configService.set(key, updates[key], req.user.user_id);
        changedKeys.push(key);
      }
    }

    // Notify worker thread of updated settings
    if (req.app.locals.cameraManager) {
      req.app.locals.cameraManager.postAll({ type: 'update_settings' });
    }

    audit.log({
      userId: req.user.user_id,
      action: 'SettingsUpdated',
      outcome: 'Success',
      ipAddress: req.ip,
      details: { updatedKeys: changedKeys }
    });

    res.redirect('/settings?saved=1');
  } catch (err) {
    console.error('[Settings] Error saving settings:', err.message);
    const allSettings = configService.getAll();
    res.status(500).render('layouts/main', {
      pageTitle: 'System Settings - ISSS',
      view: 'settings/index',
      settings: allSettings,
      metadata: SETTINGS_METADATA,
      error: `Failed to write settings to database: ${err.message}`,
      activeNav: 'settings'
    });
  }
});

router.post('/settings/retention', (req, res) => {
  try {
    const retentionDays = parseInt(req.body.retention_days || configService.get('retention_days'), 10);
    const result = storage.runRetention(
      retentionDays,
      req.app.locals.mediaCapture,
      audit
    );

    res.redirect(`/settings?retention_done=1&count=${result.deletedEventCount}`);
  } catch (err) {
    console.error('[Settings] Error running retention cleanup:', err.message);
    res.redirect(`/settings?error=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;
