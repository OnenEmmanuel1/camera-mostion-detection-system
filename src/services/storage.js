'use strict';

const { getDb } = require('../db/database');

class StorageService {
  constructor(db = null) {
    this.db = db || getDb();
  }

  createEvent({
    eventId,
    deviceId = 1,
    startTime,
    detectionType = 'frame_difference',
    changedArea = 0,
    mediaPath = null,
    reviewStatus = 'New'
  }) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO events (
        event_id, device_id, start_time, end_time, detection_type,
        changed_area, media_path, review_status, created_at
      )
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      eventId,
      deviceId,
      startTime || now,
      detectionType,
      changedArea,
      mediaPath,
      reviewStatus,
      now
    );

    return this.getEventById(eventId);
  }

  updateEvent(eventId, { endTime = null, peakChangedArea = null, mediaPath = null }) {
    const updates = [];
    const params = [];

    if (endTime !== null) {
      updates.push('end_time = ?');
      params.push(endTime);
    }
    if (peakChangedArea !== null) {
      updates.push('changed_area = ?');
      params.push(peakChangedArea);
    }
    if (mediaPath !== null) {
      updates.push('media_path = ?');
      params.push(mediaPath);
    }

    if (updates.length === 0) return;

    params.push(eventId);
    this.db.prepare(`
      UPDATE events
      SET ${updates.join(', ')}
      WHERE event_id = ?
    `).run(...params);
  }

  getEventById(eventId) {
    const event = this.db.prepare(`
      SELECT e.*, d.device_name, d.location_label
      FROM events e
      LEFT JOIN devices d ON e.device_id = d.device_id
      WHERE e.event_id = ?
    `).get(eventId);

    if (!event) return null;

    const notifications = this.db.prepare(`
      SELECT * FROM notifications
      WHERE event_id = ?
      ORDER BY attempted_at DESC
    `).all(eventId);

    event.notifications = notifications;
    return event;
  }

  getEvents({
    page = 1,
    limit = 20,
    startDate = null,
    endDate = null,
    reviewStatus = null,
    detectionType = null,
    deviceId = null
  } = {}) {
    page = Math.max(1, parseInt(page, 10) || 1);
    limit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];

    if (startDate) {
      const parsedStart = new Date(startDate);
      if (!isNaN(parsedStart.getTime())) {
        conditions.push('e.start_time >= ?');
        params.push(parsedStart.toISOString());
      }
    }

    if (endDate) {
      const parsedEnd = new Date(endDate);
      if (!isNaN(parsedEnd.getTime())) {
        conditions.push('e.start_time <= ?');
        params.push(parsedEnd.toISOString());
      }
    }

    if (reviewStatus && reviewStatus !== 'All') {
      conditions.push('e.review_status = ?');
      params.push(reviewStatus);
    }

    if (detectionType && detectionType !== 'All') {
      conditions.push('e.detection_type = ?');
      params.push(detectionType);
    }

    if (deviceId !== null && deviceId !== undefined && Number.isInteger(Number(deviceId))) {
      conditions.push('e.device_id = ?');
      params.push(Number(deviceId));
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM events e ${whereClause}
    `).get(...params);
    const total = countRow.count;

    const query = `
      SELECT e.*, d.device_name, d.location_label
      FROM events e
      LEFT JOIN devices d ON e.device_id = d.device_id
      ${whereClause}
      ORDER BY e.start_time DESC
      LIMIT ? OFFSET ?
    `;

    const events = this.db.prepare(query).all(...params, limit, offset);

    return {
      events,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1
    };
  }

  updateReviewStatus(eventId, newStatus, userId = null, auditService = null, ipAddress = null) {
    const validStatuses = ['New', 'Reviewed', 'FalseAlarm'];
    if (!validStatuses.includes(newStatus)) {
      throw new Error(`Invalid review status: ${newStatus}`);
    }

    const result = this.db.prepare(`
      UPDATE events
      SET review_status = ?
      WHERE event_id = ?
    `).run(newStatus, eventId);

    if (auditService) {
      auditService.log({
        userId,
        action: 'EventReviewStatusChanged',
        outcome: result.changes > 0 ? 'Success' : 'Failure',
        ipAddress,
        details: { eventId, newStatus }
      });
    }

    return result.changes > 0;
  }

  /**
   * Automated retention cleanup.
   * Deletes events and associated media files older than retentionDays.
   * Logs deletion in audit log without retaining deleted footage.
   */
  runRetention(retentionDays, mediaCaptureService = null, auditService = null) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1) {
      throw new Error('Retention days must be a positive integer');
    }

    const cutoffMs = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    const cutoffIso = new Date(cutoffMs).toISOString();

    // Find candidate events to delete media
    const oldEvents = this.db.prepare(`
      SELECT event_id, media_path FROM events
      WHERE start_time < ?
    `).all(cutoffIso);

    let deletedMediaCount = 0;
    if (mediaCaptureService && oldEvents.length > 0) {
      for (const evt of oldEvents) {
        if (evt.media_path) {
          const ok = mediaCaptureService.deleteMedia(evt.media_path);
          if (ok) deletedMediaCount++;
        }
      }
    }

    // Delete records from database
    const deleteResult = this.db.prepare(`
      DELETE FROM events
      WHERE start_time < ?
    `).run(cutoffIso);

    const deletedEventCount = deleteResult.changes;

    if (auditService) {
      auditService.log({
        userId: null, // System action
        action: 'RetentionCleanupExecuted',
        outcome: 'Success',
        details: {
          retentionDays,
          cutoff: cutoffIso,
          deletedEventCount,
          deletedMediaCount
        }
      });
    }

    return {
      deletedEventCount,
      deletedMediaCount,
      cutoff: cutoffIso
    };
  }
}

module.exports = StorageService;
