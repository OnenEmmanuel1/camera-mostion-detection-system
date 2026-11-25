'use strict';

const { getDb } = require('../db/database');
const { config, SETTINGS_METADATA } = require('../config');

class ConfigService {
  constructor(db = null) {
    this.db = db || getDb();
    this.cachedSettings = {};
    this.reload();
  }

  reload() {
    try {
      const rows = this.db.prepare('SELECT setting_key, setting_value FROM settings').all();
      const settingsMap = {};
      for (const row of rows) {
        settingsMap[row.setting_key] = row.setting_value;
      }

      // Populate typed cache
      for (const [key, meta] of Object.entries(SETTINGS_METADATA)) {
        const rawVal = settingsMap[key] !== undefined ? settingsMap[key] : meta.default;
        this.cachedSettings[key] = this.castValue(key, rawVal, meta);
      }
    } catch (err) {
      console.error('[ConfigService] Error loading settings from database:', err.message);
      // Fallback to defaults
      for (const [key, meta] of Object.entries(SETTINGS_METADATA)) {
        this.cachedSettings[key] = this.castValue(key, meta.default, meta);
      }
    }
  }

  castValue(key, rawVal, meta) {
    if (!meta) meta = SETTINGS_METADATA[key] || {};
    switch (meta.type) {
      case 'boolean':
        return rawVal === '1' || rawVal === 'true' || rawVal === true || rawVal === 1;
      case 'integer':
        return parseInt(rawVal, 10);
      case 'float':
        return parseFloat(rawVal);
      case 'json_regions':
        try {
          return typeof rawVal === 'string' ? JSON.parse(rawVal) : (rawVal || []);
        } catch (e) {
          return [];
        }
      case 'enum':
      default:
        return String(rawVal);
    }
  }

  get(key) {
    if (this.cachedSettings[key] !== undefined) {
      return this.cachedSettings[key];
    }
    const meta = SETTINGS_METADATA[key];
    if (meta) {
      return this.castValue(key, meta.default, meta);
    }
    return undefined;
  }

  getAll() {
    const result = {};
    for (const [key, meta] of Object.entries(SETTINGS_METADATA)) {
      result[key] = {
        value: this.get(key),
        rawValue: String(this.getRaw(key)),
        metadata: meta
      };
    }
    return result;
  }

  getRaw(key) {
    try {
      const row = this.db.prepare('SELECT setting_value FROM settings WHERE setting_key = ?').get(key);
      if (row) return row.setting_value;
    } catch (e) {}
    return SETTINGS_METADATA[key] ? SETTINGS_METADATA[key].default : null;
  }

  validate(key, value) {
    const meta = SETTINGS_METADATA[key];
    if (!meta) {
      return { valid: false, error: `Unknown configuration key: ${key}` };
    }

    // Security check: reject filesystem paths or shell metacharacters
    if (typeof value === 'string' && /[;&|`$<>]|\.\.[\/\\]/.test(value) && meta.type !== 'json_regions') {
      return { valid: false, error: `Invalid characters detected in setting ${key}` };
    }

    switch (meta.type) {
      case 'boolean': {
        const strVal = String(value).trim();
        if (strVal !== '0' && strVal !== '1' && strVal !== 'true' && strVal !== 'false') {
          return { valid: false, error: `${meta.label} must be a boolean (0 or 1)` };
        }
        return { valid: true, value: (strVal === '1' || strVal === 'true') ? '1' : '0' };
      }
      case 'integer': {
        const num = Number(value);
        if (!Number.isInteger(num)) {
          return { valid: false, error: `${meta.label} must be an integer` };
        }
        if (meta.min !== undefined && num < meta.min) {
          return { valid: false, error: `${meta.label} must be at least ${meta.min}` };
        }
        if (meta.max !== undefined && num > meta.max) {
          return { valid: false, error: `${meta.label} must be at most ${meta.max}` };
        }
        return { valid: true, value: String(num) };
      }
      case 'float': {
        const num = Number(value);
        if (isNaN(num)) {
          return { valid: false, error: `${meta.label} must be a valid number` };
        }
        if (meta.min !== undefined && num < meta.min) {
          return { valid: false, error: `${meta.label} must be at least ${meta.min}` };
        }
        if (meta.max !== undefined && num > meta.max) {
          return { valid: false, error: `${meta.label} must be at most ${meta.max}` };
        }
        return { valid: true, value: num.toFixed(2) };
      }
      case 'enum': {
        const str = String(value).trim();
        if (!meta.options.includes(str)) {
          return { valid: false, error: `${meta.label} must be one of: ${meta.options.join(', ')}` };
        }
        return { valid: true, value: str };
      }
      case 'json_regions': {
        try {
          const parsed = typeof value === 'string' ? JSON.parse(value) : value;
          if (!Array.isArray(parsed)) {
            return { valid: false, error: 'Ignore regions must be a JSON array of rectangles' };
          }
          for (let i = 0; i < parsed.length; i++) {
            const r = parsed[i];
            if (typeof r.x !== 'number' || typeof r.y !== 'number' || typeof r.w !== 'number' || typeof r.h !== 'number') {
              return { valid: false, error: `Region ${i + 1} must specify numerical x, y, w, h normalized coordinates (0 to 1)` };
            }
            if (r.x < 0 || r.x > 1 || r.y < 0 || r.y > 1 || r.w <= 0 || r.h <= 0 || (r.x + r.w) > 1.001 || (r.y + r.h) > 1.001) {
              return { valid: false, error: `Region ${i + 1} coordinates must be between 0.0 and 1.0 and fit inside the frame` };
            }
          }
          return { valid: true, value: JSON.stringify(parsed) };
        } catch (e) {
          return { valid: false, error: `Malformed JSON for ignore regions: ${e.message}` };
        }
      }
      default:
        return { valid: true, value: String(value) };
    }
  }

  set(key, rawValue, userId = null) {
    const valResult = this.validate(key, rawValue);
    if (!valResult.valid) {
      throw new Error(valResult.error);
    }

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO settings (setting_key, setting_value, updated_by, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET
        setting_value = excluded.setting_value,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `).run(key, valResult.value, userId, now);

    this.reload();
    return {
      key,
      value: this.get(key),
      appliesLive: SETTINGS_METADATA[key].appliesLive
    };
  }
}

module.exports = ConfigService;
