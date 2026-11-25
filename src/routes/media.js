'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAuth } = require('../middleware/auth');
const StorageService = require('../services/storage');
const { MediaCaptureService } = require('../services/mediaCapture');
const AuditService = require('../services/audit');
const { config } = require('../config');

const router = express.Router();
const storage = new StorageService();
const mediaCapture = new MediaCaptureService({ mediaRoot: config.MEDIA_ROOT });
const audit = new AuditService();

/**
 * Authenticated media retrieval endpoint.
 * Protects against path traversal and unauthorized unauthenticated access.
 */
router.get('/media/:eventId', requireAuth, (req, res) => {
  const { eventId } = req.params;

  try {
    const event = storage.getEventById(eventId);
    if (!event) {
      return res.status(404).send('Event not found');
    }

    if (!event.media_path) {
      return res.status(404).send('Media unavailable');
    }

    const safePath = mediaCapture.resolveSafePath(event.media_path);
    if (!safePath || !fs.existsSync(safePath)) {
      console.warn(`[Media] Media file unavailable for event ${eventId}`);
      return res.status(404).send('Media unavailable');
    }

    // Determine MIME type
    const ext = path.extname(safePath).toLowerCase();
    let contentType = 'application/octet-stream';
    if (ext === '.jpg' || ext === '.jpeg') {
      contentType = 'image/jpeg';
    } else if (ext === '.mp4') {
      contentType = 'video/mp4';
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${eventId}${ext}"`);
    res.setHeader('Cache-Control', 'private, max-age=86400'); // 1 day client cache for reviewed media

    // Audit media access
    audit.log({
      userId: req.user.user_id,
      action: 'MediaAccessed',
      outcome: 'Success',
      ipAddress: req.ip,
      details: { eventId }
    });

    const stream = fs.createReadStream(safePath);
    stream.on('error', (err) => {
      console.error(`[Media] Read stream error:`, err.message);
      if (!res.headersSent) res.status(500).send('Error streaming media file');
    });
    stream.pipe(res);
  } catch (err) {
    console.error(`[Media] Retrieval error:`, err.message);
    res.status(500).send('Internal media retrieval error');
  }
});

module.exports = router;
