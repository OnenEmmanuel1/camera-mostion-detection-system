'use strict';

const { config } = require('./config');
const createApp = require('./app');
const { runMigrations } = require('./db/migrate');
const { closeDb } = require('./db/database');
const { MediaCaptureService } = require('./services/mediaCapture');
const CameraManager = require('./services/cameraManager');

async function main() {
  console.log(`[ISSS] Starting IoT-Based Smart Surveillance System (v${config.SOFTWARE_VERSION})...`);
  console.log(`[ISSS] Environment: ${config.APP_ENV}`);

  // 1. Run database setup & migrations
  try {
    runMigrations();
    console.log('[ISSS] Database tables and indexes verified.');
  } catch (err) {
    console.error('[ISSS] Database migration failed:', err.message);
    process.exit(1);
  }

  // 2. Create Express application
  const app = createApp();

  // App-level shared states
  app.locals.mediaCapture = new MediaCaptureService({ mediaRoot: config.MEDIA_ROOT });
  const cameraManager = new CameraManager({ mediaCapture: app.locals.mediaCapture });
  app.locals.cameraManager = cameraManager;

  // 3. Run one isolated acquisition and detection worker per active camera.
  try {
    await cameraManager.startAll();
    console.log(`[ISSS] Started ${cameraManager.workers.size} camera worker(s).`);
  } catch (err) {
    console.error('[ISSS] Failed to start camera workers:', err.message);
  }

  // 4. Start HTTP Server
  const server = app.listen(config.PORT, config.HOST, () => {
    console.log(`[ISSS] Web server listening on http://${config.HOST}:${config.PORT}`);
    if (config.APP_ENV === 'demo') {
      console.log('[ISSS] Demo credentials active: admin / password123 | viewer / password123');
    }
  });

  // Graceful shutdown handling (Section 4.4, clean shutdown)
  const shutdown = async (signal) => {
    console.log(`\n[ISSS] Received ${signal}. Initiating clean shutdown...`);
    server.close(() => {
      console.log('[ISSS] HTTP server closed.');
    });

    await cameraManager.stopAll();
    console.log('[ISSS] Camera workers stopped.');

    closeDb();
    console.log('[ISSS] Database connections closed. Safe exit.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[ISSS] Fatal startup error:', err);
    process.exit(1);
  });
}

module.exports = { main };
