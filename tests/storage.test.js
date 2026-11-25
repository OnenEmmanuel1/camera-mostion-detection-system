'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const StorageService = require('../src/services/storage');
const AuditService = require('../src/services/audit');
const { MediaCaptureService } = require('../src/services/mediaCapture');
const { runMigrations } = require('../src/db/migrate');

test('StorageService: Event creation, retrieval, and review status updates', () => {
  const testDb = new Database(':memory:');
  runMigrations(testDb);

  // Insert a test user so foreign key constraint in audit_log passes
  testDb.prepare(`
    INSERT INTO users (user_id, username, password_hash, role, active, created_at)
    VALUES (1, 'testadmin', 'dummyhash', 'Administrator', 1, '2026-01-01T00:00:00.000Z')
  `).run();

  const storage = new StorageService(testDb);
  const audit = new AuditService(testDb);

  // 1. Create event
  const event = storage.createEvent({
    eventId: 'evt_test_001',
    deviceId: 1,
    startTime: '2026-01-01T10:00:00.000Z',
    detectionType: 'frame_difference',
    changedArea: 4.5,
    mediaPath: 'stills/evt_test_001.jpg',
    reviewStatus: 'New'
  });

  assert.equal(event.event_id, 'evt_test_001');
  assert.equal(event.review_status, 'New');
  assert.equal(event.changed_area, 4.5);

  // 2. Query events list
  const list = storage.getEvents();
  assert.equal(list.total, 1);
  assert.equal(list.events[0].event_id, 'evt_test_001');

  // 3. Update review status to FalseAlarm
  const updated = storage.updateReviewStatus('evt_test_001', 'FalseAlarm', 1, audit);
  assert.equal(updated, true);

  const reloaded = storage.getEventById('evt_test_001');
  assert.equal(reloaded.review_status, 'FalseAlarm');

  // Verify audit entry was created
  const logs = audit.getLogs({ action: 'EventReviewStatusChanged' });
  assert.equal(logs.total, 1);
  assert.equal(logs.logs[0].outcome, 'Success');
});

test('StorageService: Retention purges old events and unlinks media files', () => {
  const testDb = new Database(':memory:');
  runMigrations(testDb);

  const testMediaDir = path.join(__dirname, 'test_media_sandbox');
  const mediaCapture = new MediaCaptureService({ mediaRoot: testMediaDir });
  const storage = new StorageService(testDb);
  const audit = new AuditService(testDb);

  // Create a real dummy media file on disk
  const dummyFile = path.join(testMediaDir, 'stills', 'evt_old_001.jpg');
  fs.writeFileSync(dummyFile, 'dummy image content');
  assert.equal(fs.existsSync(dummyFile), true);

  // Insert event with timestamp 20 days in the past
  const pastDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  testDb.prepare(`
    INSERT INTO events (event_id, device_id, start_time, detection_type, changed_area, media_path, review_status, created_at)
    VALUES ('evt_old_001', 1, ?, 'frame_difference', 3.0, 'stills/evt_old_001.jpg', 'Reviewed', ?)
  `).run(pastDate, pastDate);

  // Run retention cleanup with 14 days cutoff
  const result = storage.runRetention(14, mediaCapture, audit);
  assert.equal(result.deletedEventCount, 1);
  assert.equal(result.deletedMediaCount, 1);

  // Verify file was unlinked from disk
  assert.equal(fs.existsSync(dummyFile), false, 'Media file must be purged from disk');

  // Clean up test directory
  fs.rmSync(testMediaDir, { recursive: true, force: true });
});
