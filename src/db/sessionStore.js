'use strict';

const session = require('express-session');
const { getDb } = require('./database');

class SqliteSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.db = options.db || getDb();
    this.cleanupIntervalMs = options.cleanupIntervalMs || 15 * 60 * 1000; // 15 mins

    // Start background cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, this.cleanupIntervalMs);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  get(sid, callback) {
    try {
      const now = Date.now();
      const row = this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?').get(sid, now);
      if (!row) {
        return callback(null, null);
      }
      const data = JSON.parse(row.sess);
      return callback(null, data);
    } catch (err) {
      return callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      let expired;
      if (sess && sess.cookie && sess.cookie.expires) {
        expired = new Date(sess.cookie.expires).getTime();
      } else {
        const oneDay = 24 * 60 * 60 * 1000;
        expired = Date.now() + oneDay;
      }

      const sessString = JSON.stringify(sess);
      this.db.prepare(`
        INSERT INTO sessions (sid, sess, expired)
        VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired = excluded.expired
      `).run(sid, sessString, expired);

      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }

  touch(sid, sess, callback) {
    try {
      let expired;
      if (sess && sess.cookie && sess.cookie.expires) {
        expired = new Date(sess.cookie.expires).getTime();
      } else {
        const oneDay = 24 * 60 * 60 * 1000;
        expired = Date.now() + oneDay;
      }
      this.db.prepare('UPDATE sessions SET expired = ? WHERE sid = ?').run(expired, sid);
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }

  cleanupExpired() {
    try {
      const now = Date.now();
      this.db.prepare('DELETE FROM sessions WHERE expired <= ?').run(now);
    } catch (err) {
      console.error('[SessionStore] Error cleaning expired sessions:', err.message);
    }
  }
}

module.exports = SqliteSessionStore;
