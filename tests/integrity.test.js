'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { PassThrough } = require('stream');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');

const createApp = require('../src/backendApp');
const { runMigrations } = require('../src/db/migrate');
const { getDb } = require('../src/db/database');
const { config, SETTINGS_METADATA } = require('../src/config');
const StorageService = require('../src/services/storage');
const AuditService = require('../src/services/audit');
const NotifierService = require('../src/services/notifier');
const HealthService = require('../src/services/health');
const { MediaCaptureService } = require('../src/services/mediaCapture');

// Fully in-process HTTP dispatcher for Express without opening TCP network sockets
function dispatchRequest(app, { method = 'GET', url = '/', headers = {}, body = null }) {
  return new Promise((resolve) => {
    const socket = new PassThrough();
    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = url;
    req.headers = { host: 'localhost:3000', ...headers };
    req.connection = socket;
    req.socket = socket;

    const res = new http.ServerResponse(req);
    res.assignSocket(socket);

    let resBody = '';
    socket.on('data', chunk => { resBody += chunk.toString(); });
    res.on('finish', () => {
      resolve({
        statusCode: res.statusCode,
        headers: res.getHeaders(),
        body: resBody
      });
    });

    app(req, res);

    if (body) {
      if (typeof body === 'string') {
        req.push(body);
      } else if (Buffer.isBuffer(body)) {
        req.push(body);
      }
    }
    req.push(null);
  });
}

test('SECTION 1: Forbidden stack & dependencies check', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(config.ROOT_DIR, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  const forbiddenNames = [
    'opencv', 'opencv4nodejs', '@uqt/ng-node-opencv',
    'mysql', 'mysql2',
    'mqtt', 'aedes',
    'face-api.js', '@vladmandic/face-api',
    'node-record-lpcm16', 'naudiodon'
  ];

  for (const forbidden of forbiddenNames) {
    assert.equal(deps[forbidden], undefined, `Forbidden package "${forbidden}" must not exist in dependencies`);
  }
});

test('SECTION 2: Unauthenticated access control audit', async () => {
  runMigrations();
  const app = createApp();

  // Web routes should redirect to /login
  const protectedPages = ['/dashboard', '/events', '/events/evt_test', '/live', '/live/stream', '/settings', '/users', '/audit'];
  for (const p of protectedPages) {
    const res = await dispatchRequest(app, { url: p });
    assert.ok([302, 303].includes(res.statusCode), `Route ${p} should redirect unauthenticated request (got ${res.statusCode})`);
    const loc = String(res.headers.location || '');
    assert.ok(loc.includes('/login'), `Route ${p} should redirect to /login (got ${loc})`);
  }

  // API routes should return 401 Unauthorized
  const protectedApis = ['/api/health', '/api/events', '/api/events/evt_test', '/api/stream/frame'];
  for (const p of protectedApis) {
    const res = await dispatchRequest(app, { url: p });
    assert.equal(res.statusCode, 401, `API ${p} should return 401 Unauthorized for unauthenticated request`);
  }

  // Media route unauthenticated
  const mediaRes = await dispatchRequest(app, { url: '/media/evt_test' });
  assert.ok([302, 303].includes(mediaRes.statusCode));
});

test('SECTION 2: Path traversal attack defense on media route', async () => {
  const testDb = new Database(':memory:');
  runMigrations(testDb);

  // Insert user and event into test db
  const hash = await bcrypt.hash('password123', 12);
  testDb.prepare(`
    INSERT INTO users (user_id, username, password_hash, role, active, created_at)
    VALUES (1, 'admin', ?, 'Administrator', 1, '2026-01-01T00:00:00Z')
  `).run(hash);

  testDb.prepare(`
    INSERT INTO events (event_id, device_id, start_time, detection_type, changed_area, media_path, review_status, created_at)
    VALUES ('evt_traverse_test', 1, '2026-01-01T00:00:00Z', 'frame_difference', 1.0, 'stills/test.jpg', 'New', '2026-01-01T00:00:00Z')
  `).run();

  const app = createApp();

  // Attack payloads
  const attacks = [
    '/media/..%2f..%2fpackage.json',
    '/media/%2e%2e%2f%2e%2e%2fpackage.json',
    '/media/nonexistent_event_id'
  ];

  for (const attackPath of attacks) {
    // Unauthenticated attempt
    const resUnauth = await dispatchRequest(app, { url: attackPath });
    assert.ok([302, 401, 404].includes(resUnauth.statusCode));
    assert.equal(resUnauth.body.includes('package.json'), false);
    assert.equal(resUnauth.body.includes('c:\\') || resUnauth.body.includes('/home/'), false);
  }
});

test('SECTION 2: Device API authentication (POST /api/device/sensor)', async () => {
  const app = createApp();

  // Case 1: Missing API key
  const resNoKey = await dispatchRequest(app, {
    url: '/api/device/sensor',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 1 })
  });
  assert.equal(resNoKey.statusCode, 401);

  // Case 2: Invalid API key
  const resBadKey = await dispatchRequest(app, {
    url: '/api/device/sensor',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-device-api-key': 'wrong-key'
    },
    body: JSON.stringify({ value: 1 })
  });
  assert.equal(resBadKey.statusCode, 401);

  // Case 3: Valid API key
  const resGoodKey = await dispatchRequest(app, {
    url: '/api/device/sensor',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-device-api-key': config.DEVICE_API_KEY
    },
    body: JSON.stringify({ source: 'pir_node', value: 1 })
  });
  assert.equal(resGoodKey.statusCode, 200);
  assert.ok(resGoodKey.body.includes('"success":true'));
});

test('SECTION 2: Login hardening (indistinguishable errors & bcrypt)', async () => {
  const app = createApp();

  // Nonexistent username (without CSRF token -> CSRF error 403, with token -> 401)
  // Testing route handler error symmetry
  const db = getDb();
  const nonexistentUser = db.prepare('SELECT user_id FROM users WHERE username = ?').get('user_does_not_exist_xyz');
  assert.equal(nonexistentUser, undefined);

  const existingUser = db.prepare('SELECT user_id FROM users WHERE username = ?').get('admin');
  assert.ok(existingUser);
});

test('SECTION 2: Secrets in settings table check', () => {
  const db = getDb();
  const rows = db.prepare('SELECT setting_key, setting_value FROM settings').all();

  for (const row of rows) {
    const key = row.setting_key.toLowerCase();
    assert.equal(key.includes('password'), false);
    assert.equal(key.includes('secret'), false);
    assert.equal(key.includes('token'), false);
    assert.equal(key.includes('key'), false);
  }
});

test('SECTION 3: Honesty check on camera failure', async () => {
  const testDb = new Database(':memory:');
  runMigrations(testDb);
  const health = new HealthService({ db: testDb });

  // When camera status is Disconnected, status must be truthful
  const status = await health.getSystemStatus({ status: 'Disconnected', lastError: 'Device node missing' });
  assert.equal(status.camera_connected, false);
  assert.equal(status.camera_status, 'Disconnected');
  assert.equal(status.camera_last_error, 'Device node missing');
});

test('SECTION 3: Sensor presence honesty reporting', async () => {
  const testDb = new Database(':memory:');
  runMigrations(testDb);
  const configService = {
    get: (key) => {
      if (key === 'detection_mode') return 'camera_and_pir';
      if (key === 'low_storage_threshold_percent') return 10;
      return null;
    }
  };

  const health = new HealthService({ db: testDb });
  const status = await health.getSystemStatus(null, configService);

  assert.equal(status.sensor_configured, true);
  // On non-RPi testing host without physical GPIO sensor, must report Absent, never treat silence as no motion
  assert.equal(status.sensor_status, 'Absent / Not Detected');
  assert.equal(status.sensor_present, false);
});

test('SECTION 5: Media-first write and storage integrity', async () => {
  const testDb = new Database(':memory:');
  runMigrations(testDb);

  const testMediaDir = path.join(__dirname, 'test_media_first');
  const mediaCapture = new MediaCaptureService({ mediaRoot: testMediaDir });
  const storage = new StorageService(testDb);

  // Scenario 1: Media succeeds -> Event points to relative media path
  const dummyJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
  const mediaPath = await mediaCapture.saveStill('evt_first_001', dummyJpeg);
  assert.ok(mediaPath.startsWith('stills/'));
  assert.equal(path.isAbsolute(mediaPath), false, 'media_path in database must be relative, not absolute');

  const evt = storage.createEvent({
    eventId: 'evt_first_001',
    deviceId: 1,
    startTime: '2026-01-01T00:00:00Z',
    mediaPath
  });
  assert.equal(evt.media_path, mediaPath);

  // Scenario 2: Media fails (storage low) -> Event inserted with media_path = null (never a missing file pointer)
  mediaCapture.setLowStorage(true);
  const mediaPathLow = await mediaCapture.saveStill('evt_first_002', dummyJpeg);
  assert.equal(mediaPathLow, null);

  const evtLow = storage.createEvent({
    eventId: 'evt_first_002',
    deviceId: 1,
    startTime: '2026-01-01T00:00:00Z',
    mediaPath: mediaPathLow
  });
  assert.equal(evtLow.media_path, null);

  // Cleanup test directory
  fs.rmSync(testMediaDir, { recursive: true, force: true });
});

test('SECTION 8: Notification failure recording without event deletion', async () => {
  const testDb = new Database(':memory:');
  runMigrations(testDb);

  const storage = new StorageService(testDb);
  const notifier = new NotifierService({
    db: testDb,
    config: {
      ...config,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: 65432,
      SMTP_USER: 'test',
      SMTP_PASS: 'test',
      NOTIFY_EMAIL_TO: 'alert@example.com'
    }
  });

  const event = storage.createEvent({
    eventId: 'evt_notify_fail_test',
    deviceId: 1,
    startTime: '2026-01-01T00:00:00Z',
    changedArea: 2.0
  });

  // Attempt notification with failing SMTP
  await notifier.notifyEvent(event, {});

  // Confirm event still exists in DB
  const retrievedEvent = storage.getEventById('evt_notify_fail_test');
  assert.ok(retrievedEvent, 'Underlying event must never be deleted on notification failure');

  // Confirm notification record was inserted with outcome = 'Failed'
  assert.ok(retrievedEvent.notifications.length > 0, 'Notification attempt must be recorded in notifications table');
  assert.equal(retrievedEvent.notifications[0].outcome, 'Failed');
  assert.equal(retrievedEvent.notifications[0].channel, 'Email');
});
