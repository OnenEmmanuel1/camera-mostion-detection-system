'use strict';

const { getDb } = require('./database');
const { config, SETTINGS_METADATA } = require('../config');

function runMigrations(customDb = null) {
  const db = customDb || getDb();

  // Create tables within transaction
  const migration = db.transaction(() => {
    // 1. users
    db.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('Administrator', 'Viewer')),
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      )
    `).run();

    // 2. devices
    db.prepare(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_name TEXT NOT NULL,
        location_label TEXT,
        last_seen TEXT,
        camera_status TEXT CHECK(camera_status IN ('Connected', 'Disconnected', 'Error', 'Unknown')),
        software_version TEXT NOT NULL,
        camera_type TEXT NOT NULL DEFAULT 'file',
        camera_path TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
      )
    `).run();

    const deviceColumns = new Set(db.prepare('PRAGMA table_info(devices)').all().map(column => column.name));
    if (!deviceColumns.has('camera_type')) {
      db.prepare("ALTER TABLE devices ADD COLUMN camera_type TEXT NOT NULL DEFAULT 'file'").run();
    }
    if (!deviceColumns.has('camera_path')) {
      db.prepare("ALTER TABLE devices ADD COLUMN camera_path TEXT NOT NULL DEFAULT ''").run();
    }
    if (!deviceColumns.has('active')) {
      db.prepare('ALTER TABLE devices ADD COLUMN active INTEGER NOT NULL DEFAULT 1').run();
    }

    // 3. events (with flagged additions: device_id FK, review_status)
    db.prepare(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        device_id INTEGER NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT,
        detection_type TEXT CHECK(detection_type IN ('frame_difference', 'running_average', 'pir', 'camera_and_pir')),
        changed_area REAL,
        media_path TEXT,
        review_status TEXT NOT NULL DEFAULT 'New' CHECK(review_status IN ('New', 'Reviewed', 'FalseAlarm')),
        created_at TEXT NOT NULL,
        FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
      )
    `).run();

    // 4. settings (non-secret tunables only)
    db.prepare(`
      CREATE TABLE IF NOT EXISTS settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_by INTEGER,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL
      )
    `).run();

    // 5. audit_log
    db.prepare(`
      CREATE TABLE IF NOT EXISTS audit_log (
        audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        action TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('Success', 'Denied', 'Failure')),
        ip_address TEXT,
        details TEXT,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL
      )
    `).run();

    // 6. notifications (flagged addition: records attempts, outcome, provider acceptance)
    db.prepare(`
      CREATE TABLE IF NOT EXISTS notifications (
        notification_id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK(channel IN ('Email', 'Telegram')),
        outcome TEXT NOT NULL CHECK(outcome IN ('AcceptedByProvider', 'Failed', 'Suppressed')),
        detail TEXT,
        attempted_at TEXT NOT NULL,
        provider_accepted_at TEXT,
        FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE
      )
    `).run();

    // 7. sessions (SQLite-backed session store)
    db.prepare(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expired INTEGER NOT NULL
      )
    `).run();

    // Indexes
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_events_start_time ON events(start_time)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_events_review_status ON events(review_status)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_events_device_id ON events(device_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_notifications_event_id ON notifications(event_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired)`).run();

    // Ensure default device exists
    const deviceCount = db.prepare(`SELECT COUNT(*) AS count FROM devices`).get().count;
    if (deviceCount === 0) {
      db.prepare(`
        INSERT INTO devices (device_id, device_name, location_label, last_seen, camera_status, software_version, camera_type, camera_path, active)
        VALUES (1, ?, ?, ?, 'Unknown', ?, ?, ?, 1)
      `).run(
        config.DEVICE_NAME,
        config.DEVICE_LOCATION,
        new Date().toISOString(),
        config.SOFTWARE_VERSION,
        config.CAMERA_TYPE,
        config.CAMERA_PATH
      );
    }

    // Preserve legacy environment camera settings as device 1's initial source.
    db.prepare(`
      UPDATE devices SET camera_type = ?, camera_path = ?
      WHERE device_id = 1 AND camera_path = ''
    `).run(config.CAMERA_TYPE, config.CAMERA_PATH);

    // Ensure default settings exist
    const insertSettingStmt = db.prepare(`
      INSERT OR IGNORE INTO settings (setting_key, setting_value, updated_by, updated_at)
      VALUES (?, ?, NULL, ?)
    `);

    const now = new Date().toISOString();
    for (const [key, meta] of Object.entries(SETTINGS_METADATA)) {
      insertSettingStmt.run(key, meta.default, now);
    }
  });

  migration();
  return true;
}

module.exports = {
  runMigrations
};
