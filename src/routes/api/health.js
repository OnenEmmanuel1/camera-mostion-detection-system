'use strict';

const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const HealthService = require('../../services/health');
const ConfigService = require('../../services/config');

const router = express.Router();
const healthService = new HealthService();
const configService = new ConfigService();

router.get('/health', requireAuth, async (req, res) => {
  try {
    const manager = req.app.locals.cameraManager;
    const status = await healthService.getSystemStatus(
      manager ? manager.getAggregateStatus() : req.app.locals.lastCameraStatus,
      configService
    );
    res.json({
      ...status,
      cameras: manager ? manager.listDevices({ activeOnly: true }).map(camera => ({
        device_id: camera.device_id,
        device_name: camera.device_name,
        status: camera.status.status,
        last_error: camera.status.lastError,
        latest_detection: camera.latest_detection
      })) : []
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve telemetry', details: err.message });
  }
});

module.exports = router;
