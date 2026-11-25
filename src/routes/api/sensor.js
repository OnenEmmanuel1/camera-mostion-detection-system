'use strict';

const express = require('express');
const { config } = require('../../config');
const AuditService = require('../../services/audit');

const router = express.Router();
const audit = new AuditService();

function validDeviceKey(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const candidateBuffer = Buffer.from(candidate.trim());
  const expectedBuffer = Buffer.from(expected.trim());
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return require('crypto').timingSafeEqual(candidateBuffer, expectedBuffer);
}

/**
 * Machine-to-machine sensor ingestion endpoint.
 * Accepts external triggers (e.g. from an ESP32 or secondary PIR microcontroller).
 * Authenticated via X-Device-API-Key header.
 */
router.post('/api/device/sensor', (req, res) => {
  const apiKey = req.headers['x-device-api-key'] || req.headers['device-api-key'];

  if (!validDeviceKey(apiKey, config.DEVICE_API_KEY)) {
    audit.log({
      userId: null,
      action: 'SensorAuthFailed',
      outcome: 'Denied',
      ipAddress: req.ip,
      details: { path: req.originalUrl }
    });
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing DEVICE_API_KEY' });
  }

  const { source = 'external_sensor', confidence = 1.0, value = 1 } = req.body || {};

  // Notify worker thread
  if (req.app.locals.cameraManager) {
    req.app.locals.cameraManager.postAll({
      type: 'sensor_trigger',
      metadata: { source, confidence, value, receivedAt: new Date().toISOString() }
    });
  }

  res.json({
    success: true,
    message: 'Sensor signal registered',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
