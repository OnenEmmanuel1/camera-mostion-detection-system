'use strict';

const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const { config } = require('../src/config');
const { getDb } = require('../src/db/database');
const { runMigrations } = require('../src/db/migrate');
const StorageService = require('../src/services/storage');
const AuditService = require('../src/services/audit');
const { MediaCaptureService } = require('../src/services/mediaCapture');
const PreprocessingService = require('../src/services/preprocessing');
const { createDetector } = require('../src/services/detector');
const EventManager = require('../src/services/eventManager');
const { FileFrameSource } = require('../src/services/camera');
const { generateSyntheticVideoAndLabels } = require('./makeTestVideo');

async function seedDatabase() {
  console.log('===============================================================');
  console.log(' ISSS DEMO DATABASE SEEDING');
  console.log('===============================================================');

  // Strict check on production environment (Flagged Decision 10)
  if (config.APP_ENV !== 'demo') {
    console.error('❌ Demo seeding requires APP_ENV=demo.');
    console.error('Use "npm run create-admin" to provision production accounts securely.');
    process.exit(1);
  }

  // Ensure migrations have executed
  runMigrations();
  const db = getDb();
  const storage = new StorageService(db);
  const audit = new AuditService(db);
  const mediaCapture = new MediaCaptureService({ mediaRoot: config.MEDIA_ROOT });

  // Provision demo user accounts with cost 12 bcrypt
  const saltRounds = 12;
  const demoUsers = [
    { username: 'admin', password: 'password123', role: 'Administrator' },
    { username: 'viewer', password: 'password123', role: 'Viewer' }
  ];

  console.log('[Seed] Provisioning demo accounts...');
  for (const u of demoUsers) {
    const existing = db.prepare('SELECT user_id FROM users WHERE username = ?').get(u.username);
    {
      const hash = await bcrypt.hash(u.password, saltRounds);
      const now = new Date().toISOString();
      if (existing) {
        db.prepare('UPDATE users SET password_hash = ?, role = ?, active = 1 WHERE user_id = ?')
          .run(hash, u.role, existing.user_id);
      } else {
        db.prepare(`
          INSERT INTO users (username, password_hash, role, active, created_at)
          VALUES (?, ?, ?, 1, ?)
        `).run(u.username, hash, u.role, now);
      }

      audit.log({
        userId: null,
        action: 'DemoUserSeeded',
        outcome: 'Success',
        details: { username: u.username, role: u.role }
      });
      console.log(`  + Ensured demo user: ${u.username} (${u.role})`);
    }
  }

  // Ensure synthetic benchmark video is present
  const videoPath = path.join(config.ROOT_DIR, 'evaluation', 'synthetic_test.mp4');
  if (!fs.existsSync(videoPath)) {
    console.log('[Seed] Generating synthetic benchmark video...');
    generateSyntheticVideoAndLabels();
  }

  console.log('[Seed] Replaying synthetic video through real detector pipeline in fast-forward...');
  const preprocessor = new PreprocessingService({ width: 320, height: 240, blurSigma: 0.5 });
  const detector = createDetector('frame_difference', {
    width: 320,
    height: 240,
    pixelThreshold: 25,
    minChangedArea: 0.50
  });

  const baseTimestampMs = Date.now() - (15 * 60 * 1000); // 15 mins ago
  const frameSource = new FileFrameSource({
    filePath: videoPath,
    fps: 10,
    baseTimestampMs,
    loop: false,
    realtime: false
  });

  const eventManager = new EventManager({
    persistenceFrames: 3,
    quietIntervalSeconds: 3,
    notificationCooldownSeconds: 0,
    detectionMode: 'camera_only'
  });

  let seededEventsCount = 0;

  eventManager.on('event:opened', async (event) => {
    try {
      // Real media capture (media-first write guarantee)
      const mediaPath = await mediaCapture.saveStill(event.eventId, event.frameBuffer);
      storage.createEvent({
        eventId: event.eventId,
        deviceId: 1,
        startTime: event.startTime,
        detectionType: 'frame_difference',
        changedArea: event.peakChangedArea,
        mediaPath,
        reviewStatus: 'New'
      });
      seededEventsCount++;
      console.log(`  + Recorded surveillance event: ${event.eventId} (Media: ${mediaPath})`);
    } catch (e) {
      console.error('[Seed] Event capture error:', e.message);
    }
  });

  eventManager.on('event:closed', (event) => {
    try {
      storage.updateEvent(event.eventId, {
        endTime: event.endTime,
        peakChangedArea: event.peakChangedArea
      });
    } catch (e) {}
  });

  // Sequential FIFO queue
  const frameQueue = [];
  let processing = false;

  async function processQueue() {
    if (processing) return;
    processing = true;

    while (frameQueue.length > 0) {
      const frameObj = frameQueue.shift();
      try {
        const { rawBuffer } = await preprocessor.process(frameObj.buffer);
        const detectionResult = detector.detect(rawBuffer);

        eventManager.processFrame({
          frameBuffer: frameObj.buffer,
          timestamp: frameObj.timestamp,
          timestampMs: frameObj.timestampMs,
          detectionResult,
          sensorActive: false,
          detectionMethod: 'frame_difference'
        });
      } catch (err) {}
    }

    processing = false;
  }

  frameSource.on('frame', (frameObj) => {
    frameQueue.push(frameObj);
    processQueue();
  });

  await new Promise((resolve) => {
    frameSource.on('ended', async () => {
      while (frameQueue.length > 0 || processing) {
        await new Promise(r => setTimeout(r, 10));
      }
      eventManager.forceClose();
      resolve();
    });
    frameSource.start();
  });

  console.log(`[Seed] Successfully seeded ${seededEventsCount} genuine surveillance events!`);
  console.log('===============================================================');
  console.log('DEMO CREDENTIALS:');
  console.log('  Administrator: admin / password123');
  console.log('  Viewer:        viewer / password123');
  console.log('===============================================================');
}

if (require.main === module) {
  seedDatabase().catch((err) => {
    console.error('[Seed Error]:', err);
    process.exit(1);
  });
}

module.exports = { seedDatabase };
