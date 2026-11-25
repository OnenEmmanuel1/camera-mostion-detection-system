'use strict';

const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const StorageService = require('../../services/storage');
const AuditService = require('../../services/audit');

const router = express.Router();
const storage = new StorageService();
const audit = new AuditService();

// This router is mounted at /api/events, so paths below are relative to that prefix.
// requireAuth is applied per-route.

router.get('/', requireAuth, (req, res) => {
  try {
    const { page, limit, start_date, end_date, review_status, detection_type, device_id } = req.query;
    const result = storage.getEvents({
      page,
      limit,
      startDate: start_date,
      endDate: end_date,
      reviewStatus: review_status,
      detectionType: detection_type,
      deviceId: device_id
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:eventId', requireAuth, (req, res) => {
  try {
    const event = storage.getEventById(req.params.eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:eventId/status', requireAuth, (req, res) => {
  try {
    const { review_status } = req.body;
    const success = storage.updateReviewStatus(
      req.params.eventId,
      review_status,
      req.user.user_id,
      audit,
      req.ip
    );
    if (!success) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json({ success: true, eventId: req.params.eventId, review_status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
