'use strict';

const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const ConfigService = require('../../services/config');

const router = express.Router();
const configService = new ConfigService();
const MAX_BROWSER_FRAME_BYTES = 1024 * 1024;

/**
 * Endpoint returning single latest JPEG snapshot (for preview cards or polling).
 */
router.get('/stream/frame', requireAuth, (req, res) => {
  const liveEnabled = configService.get('live_view_enabled');
  const viewerAccess = configService.get('live_view_viewer_access');

  if (!liveEnabled || (req.user.role === 'Viewer' && !viewerAccess)) {
    return res.status(403).json({ error: 'Live frame access restricted' });
  }

  const manager = req.app.locals.cameraManager;
  const requestedId = req.query.device_id;
  const deviceId = requestedId ? Number(requestedId) : manager.listDevices({ activeOnly: true })[0]?.device_id;
  const frame = deviceId ? manager.getFrame(deviceId) : null;
  if (!frame) {
    return res.status(503).json({ error: 'No camera frame available yet' });
  }

  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(frame);
});

/** Receives opt-in frames from the authenticated user's local browser camera. */
router.post('/stream/browser-camera', requireAuth, (req, res) => {
  const liveEnabled = configService.get('live_view_enabled');
  const viewerAccess = configService.get('live_view_viewer_access');
  if (!liveEnabled || (req.user.role === 'Viewer' && !viewerAccess)) {
    return res.status(403).json({ error: 'Live camera access restricted' });
  }

  const manager = req.app.locals.cameraManager;

  const { action, frame } = req.body || {};
  const deviceId = Number(req.body.device_id) || 1;
  const device = manager.getDevice(deviceId);
  if (!device || !device.active) return res.status(404).json({ error: 'Active camera not found' });
  if (action === 'start') {
    if (!manager.postToDevice(deviceId, { type: 'browser_camera_start' })) {
      return res.status(503).json({ error: 'Camera worker unavailable' });
    }
    return res.json({ ok: true });
  }
  if (action === 'stop') {
    manager.postToDevice(deviceId, { type: 'browser_camera_stop' });
    return res.json({ ok: true });
  }
  if (typeof frame !== 'string') {
    return res.status(400).json({ error: 'A JPEG camera frame is required' });
  }

  const base64 = frame.replace(/^data:image\/jpeg;base64,/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return res.status(400).json({ error: 'Invalid JPEG frame encoding' });
  }
  const jpeg = Buffer.from(base64, 'base64');
  if (jpeg.length < 4 || jpeg.length > MAX_BROWSER_FRAME_BYTES || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    return res.status(413).json({ error: 'Camera frame is invalid or too large' });
  }

  if (!manager.postToDevice(deviceId, { type: 'browser_camera_frame', jpeg })) {
    return res.status(503).json({ error: 'Camera worker unavailable' });
  }
  res.json({ ok: true });
});

module.exports = router;
