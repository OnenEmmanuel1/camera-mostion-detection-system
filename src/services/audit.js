'use strict';

const { getDb } = require('../db/database');

class AuditService {
  constructor(db = null) {
    this.db = db || getDb();
    this.insertStmt = this.db.prepare(`
      INSERT INTO audit_log (user_id, action, timestamp, outcome, ip_address, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  }

  log({ userId = null, action, outcome = 'Success', ipAddress = null, details = null }) {
    try {
      const now = new Date().toISOString();
      const outcomeNormalized = ['Success', 'Denied', 'Failure'].includes(outcome) ? outcome : 'Success';
      return this.insertStmt.run(
        userId,
        action,
        now,
        outcomeNormalized,
        ipAddress || null,
        typeof details === 'object' ? JSON.stringify(details) : (details || null)
      );
    } catch (err) {
      console.error('[AuditService] Failed to record audit log entry:', err.message);
    }
  }

  getLogs({ limit = 50, offset = 0, outcome = null, action = null } = {}) {
    let query = `
      SELECT a.*, u.username, u.role
      FROM audit_log a
      LEFT JOIN users u ON a.user_id = u.user_id
    `;
    const params = [];
    const conditions = [];

    if (outcome) {
      conditions.push('a.outcome = ?');
      params.push(outcome);
    }

    if (action) {
      conditions.push('a.action LIKE ?');
      params.push(`%${action}%`);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ' ORDER BY a.timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const logs = this.db.prepare(query).all(...params);

    // Total count for pagination
    let countQuery = 'SELECT COUNT(*) as count FROM audit_log a';
    const countParams = [];
    if (conditions.length > 0) {
      countQuery += ` WHERE ${conditions.join(' AND ')}`;
      if (outcome) countParams.push(outcome);
      if (action) countParams.push(`%${action}%`);
    }
    const total = this.db.prepare(countQuery).get(...countParams).count;

    return { logs, total, limit, offset };
  }
}

module.exports = AuditService;
