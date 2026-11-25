'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const ConfigService = require('../services/config');
const StorageService = require('../services/storage');
const { config } = require('../config');

const router = express.Router();
const configService = new ConfigService();
const storage = new StorageService();

/**
 * Build 7-day calendar arrays for the surveillance viewer.
 * @param {string|null} selectedDate - ISO date string (YYYY-MM-DD) or null for today
 */
function buildCalendarData(selectedDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Parse selected date or default to today
  const parsedDate = typeof selectedDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(selectedDate)
    ? new Date(selectedDate + 'T00:00:00')
    : null;
  const validDate = parsedDate && !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === selectedDate;
  let activeDate = validDate ? parsedDate : new Date(today);
  activeDate.setHours(0, 0, 0, 0);

  // Build 7-day week strip for sidebar (Mon–today range centred on today)
  const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekDays = [];
  for (let i = -3; i <= 3; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const isoDate = d.toISOString().split('T')[0];
    weekDays.push({
      dow: DOW_SHORT[d.getDay()],
      num: d.getDate(),
      date: isoDate,
      active: isoDate === activeDate.toISOString().split('T')[0]
    });
  }

  // Build 10-day timeline day selector strip (older → today, right to left as in reference)
  const timelineDays = [];
  for (let i = -9; i <= 0; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const isoDate = d.toISOString().split('T')[0];
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    timelineDays.push({
      label: DOW_SHORT[d.getDay()],
      num: d.getDate() + ' ' + MONTHS[d.getMonth()],
      date: isoDate,
      active: isoDate === activeDate.toISOString().split('T')[0]
    });
  }

  return { weekDays, timelineDays, activeDate };
}

/**
 * Build timeline groups from events on a given day.
 * Groups events by hour, with up to 6 clips shown per hour bucket.
 */
function buildTimelineGroups(events) {
  const hourMap = {};
  for (const evt of events) {
    const d = new Date(evt.start_time);
    const hLabel = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const hourKey = d.getHours();
    if (!hourMap[hourKey]) hourMap[hourKey] = { time: hLabel, clips: [] };
    if (hourMap[hourKey].clips.length < 6) {
      hourMap[hourKey].clips.push({
        event_id: evt.event_id,
        media_path: evt.media_path || null,
        time: hLabel,
        detection_type: evt.detection_type,
        review_status: evt.review_status
      });
    }
  }
  // Return sorted newest-first for display
  return Object.keys(hourMap)
    .sort((a, b) => Number(b) - Number(a))
    .map(k => hourMap[k]);
}

// Live view page (new surveillance viewer)
router.get('/live', requireAuth, (req, res) => {
  const manager = req.app.locals.cameraManager;
  const activeCameras = manager.listDevices({ activeOnly: true });
  const requestedId = Number(req.query.device_id);
  const camera = activeCameras.find(item => item.device_id === requestedId) || activeCameras[0] || null;
  const liveEnabled = configService.get('live_view_enabled');
  const viewerAccess = configService.get('live_view_viewer_access');

  const accessDenied = !camera ||
    !liveEnabled ||
    (req.user.role === 'Viewer' && !viewerAccess);

  const reason = !camera
    ? 'No active cameras are configured.'
    : !liveEnabled
    ? 'Live video streaming is currently disabled in system settings.'
    : 'Viewer role access to the live camera stream is restricted by an Administrator.';

  // Parse optional date query param
  const selectedDate = req.query.date || null;
  const { weekDays, timelineDays, activeDate } = buildCalendarData(selectedDate);

  // Fetch recent events for the feed sidebar + timeline
  let recentEvents = [];
  let timelineGroups = [];
  try {
    // Events for the selected date (day boundary)
    const dayStart = new Date(activeDate);
    const dayEnd = new Date(activeDate);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const result = storage.getEvents({
      limit: 50,
      startDate: dayStart.toISOString(),
      endDate: dayEnd.toISOString(),
      deviceId: camera && camera.device_id
    });
    recentEvents = result.events || [];
    timelineGroups = buildTimelineGroups(recentEvents);
  } catch (err) {
    // Non-fatal: viewer still renders, just empty feed
    recentEvents = [];
    timelineGroups = [];
  }

  const deviceCfg = camera ? camera.device_name : config.DEVICE_NAME;
  const locationCfg = camera ? (camera.location_label || 'Location not set') : config.DEVICE_LOCATION;

  res.render('layouts/main', {
    pageTitle: 'Surveillance Viewer — ISSS',
    view: 'live/viewer',
    activeNav: 'live',
    // viewer-specific locals
    disabled: accessDenied,
    reason: accessDenied ? reason : null,
    isLive: !accessDenied,
    cameraLabel: deviceCfg,
    cameraDeviceId: camera ? camera.device_id : null,
    locationLabel: locationCfg,
    recentEvents,
    timelineGroups,
    weekDays,
    timelineDays
  });
});

// Authenticated MJPEG streaming endpoint
router.get('/live/stream', requireAuth, (req, res) => {
  const liveEnabled = configService.get('live_view_enabled');
  const viewerAccess = configService.get('live_view_viewer_access');

  if (!liveEnabled || (req.user.role === 'Viewer' && !viewerAccess)) {
    return res.status(403).send('Live stream access forbidden');
  }

  const manager = req.app.locals.cameraManager;
  const requestedId = Number(req.query.device_id);
  const activeCameras = manager.listDevices({ activeOnly: true });
  const camera = activeCameras.find(item => item.device_id === requestedId) || activeCameras[0] || null;
  if (!camera) return res.status(404).send('Active camera not found');
  const streamEmitter = manager.getEmitter(camera.device_id);

  // Set multipart MJPEG headers
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=isss_frame_boundary',
    'Cache-Control': 'no-cache, no-store, must-revalidate, pre-check=0, post-check=0, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Connection': 'close'
  });

  const frameListener = (jpegBuffer) => {
    if (!res.writableEnded && res.writable) {
      try {
        res.write(`--isss_frame_boundary\r\n`);
        res.write(`Content-Type: image/jpeg\r\n`);
        res.write(`Content-Length: ${jpegBuffer.length}\r\n\r\n`);
        res.write(jpegBuffer);
        res.write(`\r\n`);
      } catch (err) {
        cleanup();
      }
    }
  };

  // Register listener on app event emitter
  if (streamEmitter) streamEmitter.on('frame', frameListener);

  // Send the most recent frame immediately if available
  const latestFrame = manager.getFrame(camera.device_id);
  if (latestFrame) {
    frameListener(latestFrame);
  }

  const cleanup = () => {
    if (streamEmitter) streamEmitter.removeListener('frame', frameListener);
    if (!res.writableEnded) {
      try {
        res.end();
      } catch (e) {}
    }
  };

  req.on('close', cleanup);
  req.on('end', cleanup);
  req.on('error', cleanup);
});

module.exports = router;
