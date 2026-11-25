'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const StorageService = require('../services/storage');
const AuditService = require('../services/audit');

const router = express.Router();
const storage = new StorageService();
const audit = new AuditService();

router.get('/events', requireAuth, (req, res) => {
  try {
    const { page, start_date, end_date, review_status, detection_type } = req.query;

    const result = storage.getEvents({
      page: page || 1,
      limit: 15,
      startDate: start_date,
      endDate: end_date,
      reviewStatus: review_status,
      detectionType: detection_type
    });

    res.render('layouts/main', {
      pageTitle: 'Surveillance Events - ISSS',
      view: 'events/index',
      events: result.events,
      total: result.total,
      page: result.page,
      totalPages: result.totalPages,
      query: req.query,
      activeNav: 'events'
    });
  } catch (err) {
    console.error('[Events] Error listing events:', err.message);
    res.status(500).render('layouts/main', {
      pageTitle: 'Events Error - ISSS',
      view: 'events/index',
      events: [],
      total: 0,
      page: 1,
      totalPages: 1,
      query: req.query,
      error: 'Failed to load surveillance records from database.',
      activeNav: 'events'
    });
  }
});

router.get('/events/:eventId', requireAuth, (req, res) => {
  const { eventId } = req.params;

  try {
    const event = storage.getEventById(eventId);
    if (!event) {
      return res.status(404).render('layouts/main', {
        pageTitle: 'Event Not Found - ISSS',
        view: 'events/detail',
        event: null,
        error: `Surveillance record ${eventId} does not exist.`,
        activeNav: 'events'
      });
    }

    res.render('layouts/main', {
      pageTitle: `Event ${eventId} - ISSS`,
      view: 'events/detail',
      event,
      activeNav: 'events'
    });
  } catch (err) {
    console.error(`[Events] Error reading event ${eventId}:`, err.message);
    res.status(500).render('layouts/main', {
      pageTitle: 'Event Error - ISSS',
      view: 'events/detail',
      event: null,
      error: 'An internal error occurred while retrieving event details.',
      activeNav: 'events'
    });
  }
});

router.post('/events/:eventId/status', requireAuth, (req, res) => {
  const { eventId } = req.params;
  const { review_status } = req.body;

  try {
    const success = storage.updateReviewStatus(
      eventId,
      review_status,
      req.user.user_id,
      audit,
      req.ip
    );

    if (!success) {
      return res.status(404).redirect(`/events/${eventId}?error=not_found`);
    }

    res.redirect(`/events/${eventId}?updated=1`);
  } catch (err) {
    console.error(`[Events] Error updating status for ${eventId}:`, err.message);
    res.redirect(`/events/${eventId}?error=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;
