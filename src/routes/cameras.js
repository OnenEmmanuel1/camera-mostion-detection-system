'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const StorageService = require('../services/storage');
const AuditService = require('../services/audit');
const ConfigService = require('../services/config');

const router = express.Router();
const storage = new StorageService();
const audit = new AuditService();
const configService = new ConfigService();
const CAMERA_TYPES = new Set(['usb', 'url', 'file']);

function validCameraForm(body) {
  const deviceName = String(body.device_name || '').trim();
  const locationLabel = String(body.location_label || '').trim();
  const cameraType = String(body.camera_type || '').trim().toLowerCase();
  const cameraPath = String(body.camera_path || '').trim();
  if (!deviceName || deviceName.length > 80) return { error: 'Camera name is required and must be 80 characters or fewer.' };
  if (locationLabel.length > 120) return { error: 'Location must be 120 characters or fewer.' };
  if (!CAMERA_TYPES.has(cameraType)) return { error: 'Choose USB, network stream, or video file as the camera type.' };
  if (!cameraPath || cameraPath.length > 2048 || /[\r\n\0]/.test(cameraPath)) return { error: 'Camera device, stream URL, or file path is required.' };
  if (cameraType === 'url' && !/^https?:\/\/|^rtsps?:\/\//i.test(cameraPath)) {
    return { error: 'Network camera URLs must start with rtsp://, rtsps://, http://, or https://.' };
  }
  return { deviceName, locationLabel, cameraType, cameraPath };
}

router.get('/cameras', requireAuth, (req, res) => {
  try {
    const manager = req.app.locals.cameraManager;
    const devices = manager.listDevices({ includePath: req.user.role === 'Administrator' });
    const cameras = devices.map(device => ({
      ...device,
      status: req.user.role === 'Administrator'
        ? device.status
        : { ...device.status, lastError: null },
      latestEvent: storage.getEvents({ deviceId: device.device_id, limit: 1 }).events[0] || null
    }));
    res.render('layouts/main', {
      pageTitle: 'Camera Overview - ISSS',
      view: 'cameras/index',
      activeNav: 'cameras',
      cameras,
      activeCount: cameras.filter(camera => camera.active).length,
      connectedCount: cameras.filter(camera => camera.active && camera.status.status === 'Connected').length,
      cameraStreamsEnabled: configService.get('live_view_enabled') &&
        (req.user.role === 'Administrator' || configService.get('live_view_viewer_access')),
      notice: req.query.added ? 'Camera added. It is starting now.' : req.query.saved ? 'Camera settings updated.' : null,
      errorMessage: req.query.error || null
    });
  } catch (error) {
    console.error('[Cameras] Overview failed:', error.message);
    res.status(500).render('layouts/main', {
      pageTitle: 'Camera Overview - ISSS',
      view: 'cameras/index',
      activeNav: 'cameras',
      cameras: [],
      activeCount: 0,
      connectedCount: 0,
      cameraStreamsEnabled: false,
      notice: null,
      errorMessage: null,
      error: 'Could not load camera status.'
    });
  }
});

router.get('/api/cameras', requireAuth, (req, res) => {
  const cameras = req.app.locals.cameraManager.listDevices({ activeOnly: true }).map(camera => ({
    device_id: camera.device_id,
    device_name: camera.device_name,
    status: camera.status.status,
    last_error: req.user.role === 'Administrator' ? camera.status.lastError : null,
    has_frame: camera.has_frame,
    latest_detection: camera.latest_detection
  }));
  res.json({
    cameras,
    streams_enabled: configService.get('live_view_enabled') &&
      (req.user.role === 'Administrator' || configService.get('live_view_viewer_access'))
  });
});

router.post('/cameras', requireAuth, requireRole('Administrator'), async (req, res) => {
  const input = validCameraForm(req.body);
  if (input.error) return res.status(400).redirect(`/cameras?error=${encodeURIComponent(input.error)}`);
  try {
    const device = await req.app.locals.cameraManager.addDevice(input);
    audit.log({ userId: req.user.user_id, action: 'CameraAdded', outcome: 'Success', ipAddress: req.ip, details: { deviceId: device.device_id, cameraType: device.camera_type } });
    res.redirect('/cameras?added=1');
  } catch (error) {
    console.error('[Cameras] Add failed:', error.message);
    res.redirect(`/cameras?error=${encodeURIComponent('Camera could not be added. Check its source and server logs.')}`);
  }
});

router.post('/cameras/:deviceId/update', requireAuth, requireRole('Administrator'), async (req, res) => {
  const input = validCameraForm(req.body);
  if (input.error) return res.status(400).redirect(`/cameras?error=${encodeURIComponent(input.error)}`);
  try {
    const device = await req.app.locals.cameraManager.updateDevice(req.params.deviceId, input);
    if (!device) return res.status(404).redirect('/cameras?error=Camera%20not%20found.');
    audit.log({ userId: req.user.user_id, action: 'CameraUpdated', outcome: 'Success', ipAddress: req.ip, details: { deviceId: device.device_id, cameraType: device.camera_type } });
    res.redirect('/cameras?saved=1');
  } catch (error) {
    console.error('[Cameras] Update failed:', error.message);
    res.redirect(`/cameras?error=${encodeURIComponent('Camera settings could not be saved.')}`);
  }
});

router.post('/cameras/:deviceId/active', requireAuth, requireRole('Administrator'), async (req, res) => {
  try {
    const active = req.body.active === '1';
    const changed = await req.app.locals.cameraManager.setActive(req.params.deviceId, active);
    if (!changed) return res.status(404).redirect('/cameras?error=Camera%20not%20found.');
    audit.log({ userId: req.user.user_id, action: active ? 'CameraActivated' : 'CameraDeactivated', outcome: 'Success', ipAddress: req.ip, details: { deviceId: Number(req.params.deviceId) } });
    res.redirect('/cameras?saved=1');
  } catch (error) {
    console.error('[Cameras] Status change failed:', error.message);
    res.redirect(`/cameras?error=${encodeURIComponent('Camera status could not be changed.')}`);
  }
});

module.exports = router;
