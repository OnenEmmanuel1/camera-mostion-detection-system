'use strict';

const fs = require('fs');
const dns = require('dns').promises;
const { getDb } = require('../db/database');
const { config } = require('../config');

class HealthService {
  constructor(options = {}) {
    this.db = options.db || getDb();
    this.mediaRoot = options.mediaRoot || config.MEDIA_ROOT;
    this.deviceId = options.deviceId || 1;
    this.lastNetworkCheck = null;
    this.networkOnline = false;
  }

  /**
   * Check filesystem disk space using native fs.statfs
   * Returns free space percentage and low storage flag.
   */
  async checkStorage(thresholdPercent = 10) {
    try {
      const stats = await fs.promises.statfs(this.mediaRoot);
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bavail * stats.bsize;
      const freePercent = totalBytes > 0 ? Number(((freeBytes / totalBytes) * 100).toFixed(1)) : 100;
      const lowStorage = freePercent < thresholdPercent;

      return {
        totalBytes,
        freeBytes,
        freePercent,
        lowStorage,
        thresholdPercent
      };
    } catch (err) {
      // Fallback if statfs fails
      return {
        totalBytes: 0,
        freeBytes: 0,
        freePercent: 100,
        lowStorage: false,
        error: err.message
      };
    }
  }

  /**
   * Measures Node.js process CPU and memory usage
   */
  getProcessMetrics() {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    return {
      rssMb: Number((mem.rss / (1024 * 1024)).toFixed(1)),
      heapUsedMb: Number((mem.heapUsed / (1024 * 1024)).toFixed(1)),
      heapTotalMb: Number((mem.heapTotal / (1024 * 1024)).toFixed(1)),
      uptimeSeconds: Math.floor(process.uptime()),
      cpuUserMs: Math.floor(cpu.user / 1000),
      cpuSystemMs: Math.floor(cpu.system / 1000)
    };
  }

  /**
   * Checks network connectivity with bounded timeout
   */
  async checkNetwork() {
    const now = Date.now();
    // Cache network check for 30 seconds
    if (this.lastNetworkCheck && (now - this.lastNetworkCheck.timestamp) < 30000) {
      return this.lastNetworkCheck;
    }

    let online = false;
    try {
      // Resolve a standard DNS record or localhost check
      const lookupPromise = dns.resolve('google.com');
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 1500)
      );
      await Promise.race([lookupPromise, timeoutPromise]);
      online = true;
    } catch (e) {
      online = false;
    }

    this.lastNetworkCheck = {
      online,
      checkedAt: new Date().toISOString(),
      timestamp: now
    };
    this.networkOnline = online;
    return this.lastNetworkCheck;
  }

  /**
   * Records device heartbeat in database
   */
  recordHeartbeat(cameraStatus = 'Connected') {
    try {
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE devices
        SET last_seen = ?, camera_status = ?
        WHERE device_id = ?
      `).run(now, cameraStatus, this.deviceId);
    } catch (err) {
      console.error('[HealthService] Failed to record heartbeat:', err.message);
    }
  }

  /**
   * Build comprehensive health status object for Dashboard
   */
  async getSystemStatus(cameraSourceStatus = null, configService = null) {
    const threshold = configService ? configService.get('low_storage_threshold_percent') : 10;
    const storage = await this.checkStorage(threshold);
    const processMetrics = this.getProcessMetrics();
    const network = await this.checkNetwork();

    const device = this.db.prepare(`
      SELECT * FROM devices
      WHERE active = 1
      ORDER BY CASE WHEN last_seen IS NULL THEN 1 ELSE 0 END, last_seen DESC
      LIMIT 1
    `).get() || this.db.prepare(`
      SELECT * FROM devices WHERE device_id = ?
    `).get(this.deviceId) || {
      camera_status: 'Unknown',
      last_seen: null,
      software_version: config.SOFTWARE_VERSION
    };

    let heartbeatAgeSeconds = null;
    let heartbeatStale = true;
    if (device.last_seen) {
      const lastSeenMs = new Date(device.last_seen).getTime();
      heartbeatAgeSeconds = Math.max(0, Math.floor((Date.now() - lastSeenMs) / 1000));
      heartbeatStale = heartbeatAgeSeconds > 15; // >15s without heartbeat is considered stale
    }

    const lastEvent = this.db.prepare(`
      SELECT event_id, start_time, detection_type, changed_area, review_status, media_path
      FROM events
      ORDER BY start_time DESC
      LIMIT 1
    `).get() || null;

    const cameraStatus = cameraSourceStatus ? cameraSourceStatus.status : device.camera_status;

    // Sensor presence check (Section 3 & 4.3 honesty check)
    const detectionMode = configService ? configService.get('detection_mode') : 'camera_only';
    const sensorConfigured = detectionMode !== 'camera_only';
    let sensorPresent = false;
    let sensorStatus = 'Not Configured';

    if (sensorConfigured) {
      // Check if GPIO hardware available on platform
      try {
        const { GpioSensorSource } = require('./sensor');
        const probe = new GpioSensorSource(17);
        if (probe.hardwareAvailable) {
          sensorPresent = true;
          sensorStatus = 'Connected (GPIO)';
        } else {
          sensorPresent = false;
          sensorStatus = 'Absent / Not Detected';
        }
      } catch (e) {
        sensorPresent = false;
        sensorStatus = 'Absent / Not Detected';
      }
    }

    return {
      camera_connected: cameraStatus === 'Connected',
      camera_status: cameraStatus,
      camera_last_error: cameraSourceStatus ? cameraSourceStatus.lastError : null,
      detection_enabled: configService ? configService.get('detection_enabled') : true,
      detection_method: configService ? configService.get('detection_method') : 'frame_difference',
      detection_mode: detectionMode,
      sensor_configured: sensorConfigured,
      sensor_present: sensorPresent,
      sensor_status: sensorStatus,
      network_connected: network.online,
      network_checked_at: network.checkedAt,
      storage_free_percent: storage.freePercent,
      storage_low: storage.lowStorage,
      storage_total_bytes: storage.totalBytes,
      storage_free_bytes: storage.freeBytes,
      heartbeat_last_seen: device.last_seen,
      heartbeat_age_seconds: heartbeatAgeSeconds,
      heartbeat_stale: heartbeatStale,
      software_version: device.software_version || config.SOFTWARE_VERSION,
      process_metrics: processMetrics,
      last_event: lastEvent
    };
  }
}

module.exports = HealthService;
