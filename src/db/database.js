'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { config } = require('../config');

let dbInstance = null;

function getDb(customPath = null) {
  if (dbInstance && !customPath) {
    return dbInstance;
  }

  const dbPath = customPath || config.DATABASE_PATH;
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath, {
    // verbose: config.APP_ENV === 'development' ? console.log : null
  });

  // Performance and integrity pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  if (!customPath) {
    dbInstance = db;
  }

  return db;
}

function closeDb() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (err) {
      // Ignore if already closed
    }
    dbInstance = null;
  }
}

module.exports = {
  getDb,
  closeDb
};
