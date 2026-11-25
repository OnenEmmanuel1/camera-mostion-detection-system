'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const HealthService = require('../services/health');
const ConfigService = require('../services/config');
const StorageService = require('../services/storage');

const router = express.Router();
const healthService = new HealthService();
const configService = new ConfigService();
const storageService = new StorageService();

router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    // Get live status from health service
    const cameraManager = req.app.locals.cameraManager;
    const cameras = cameraManager ? cameraManager.listDevices({ activeOnly: true }) : [];
    const cameraStatus = cameraManager
      ? cameraManager.getAggregateStatus()
      : req.app.locals.lastCameraStatus;
    const status = await healthService.getSystemStatus(cameraStatus, configService);
    
    // Recent 5 events
    const recentEvents = storageService.getEvents({ limit: 5 });

    res.render('layouts/main', {
      pageTitle: 'System Dashboard - ISSS',
      view: 'dashboard/index',
      status,
      cameras,
      recentEvents: recentEvents.events,
      activeNav: 'dashboard'
    });
  } catch (err) {
    console.error('[Dashboard] Error rendering dashboard:', err);
    res.status(500).render('layouts/main', {
      pageTitle: 'Dashboard Error - ISSS',
      view: 'dashboard/index',
      status: {
        camera_connected: false,
        camera_status: 'Error',
        detection_enabled: false,
        network_connected: false,
        storage_free_percent: 0,
        heartbeat_stale: true,
        heartbeat_age_seconds: null,
        process_metrics: { rssMb: 0, heapUsedMb: 0, uptimeSeconds: 0 }
      },
      cameras: [],
      recentEvents: [],
      error: 'Failed to retrieve system telemetry.',
      activeNav: 'dashboard'
    });
  }
});

module.exports = router;
