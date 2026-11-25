'use strict';

const path = require('path');
const EventEmitter = require('events');
const { Worker } = require('worker_threads');
const { getDb } = require('../db/database');
const { config } = require('../config');
const ConfigService = require('./config');
const StorageService = require('./storage');
const AuditService = require('./audit');
const { MediaCaptureService } = require('./mediaCapture');

class CameraManager {
  constructor(options = {}) {
    this.db = options.db || getDb();
    this.configService = new ConfigService(this.db);
    this.storage = new StorageService(this.db);
    this.audit = new AuditService(this.db);
    this.mediaCapture = options.mediaCapture || new MediaCaptureService({ mediaRoot: config.MEDIA_ROOT });
    this.workerScript = path.join(__dirname, '..', 'detectionWorker.js');
    this.workers = new Map();
    this.statuses = new Map();
    this.frames = new Map();
    this.detections = new Map();
    this.emitters = new Map();
  }

  async startAll() {
    const devices = this.db.prepare('SELECT * FROM devices WHERE active = 1 ORDER BY device_id').all();
    await Promise.all(devices.map(device => this.startDevice(device)));
    this.retentionTimer = setInterval(() => {
      try {
        this.configService.reload();
        this.storage.runRetention(this.configService.get('retention_days') || 14, this.mediaCapture, this.audit);
      } catch (error) {
        console.error('[CameraManager] Retention cleanup failed:', error.message);
      }
    }, 60 * 60 * 1000);
    this.retentionTimer.unref();
  }

  startDevice(deviceOrId) {
    const device = typeof deviceOrId === 'object'
      ? deviceOrId
      : this.db.prepare('SELECT * FROM devices WHERE device_id = ? AND active = 1').get(deviceOrId);
    if (!device || !device.active) return Promise.resolve(null);
    if (this.workers.has(device.device_id)) return Promise.resolve(this.workers.get(device.device_id));

    const worker = new Worker(this.workerScript, {
      workerData: {
        deviceId: device.device_id,
        cameraType: device.camera_type,
        cameraPath: device.camera_path
      }
    });
    this.workers.set(device.device_id, worker);
    this.statuses.set(device.device_id, { status: 'Unknown', lastError: null });
    this.emitters.set(device.device_id, new EventEmitter());

    worker.on('message', message => this.handleWorkerMessage(device.device_id, message));
    worker.on('error', error => {
      this.updateStatus(device.device_id, { status: 'Error', lastError: error.message });
    });
    worker.on('exit', code => {
      if (this.workers.get(device.device_id) !== worker) return;
      this.workers.delete(device.device_id);
      const current = this.statuses.get(device.device_id) || {};
      this.updateStatus(device.device_id, {
        ...current,
        status: current.status === 'Error' ? 'Error' : 'Disconnected',
        lastError: code === 0 ? current.lastError : `Camera worker exited with code ${code}`
      });
    });
    return Promise.resolve(worker);
  }

  handleWorkerMessage(deviceId, message) {
    if (!message) return;
    if (message.type === 'camera_status' || message.type === 'heartbeat') {
      const status = message.status || message.cameraStatus;
      if (status) this.updateStatus(deviceId, status);
    }
    if (message.type === 'frame') {
      const jpeg = Buffer.isBuffer(message.jpeg)
        ? message.jpeg
        : Buffer.from(message.jpeg.buffer, message.jpeg.byteOffset, message.jpeg.byteLength);
      this.frames.set(deviceId, jpeg);
      if (message.detection) {
        this.detections.set(deviceId, { ...message.detection, timestamp: message.timestamp });
      }
      const emitter = this.emitters.get(deviceId);
      if (emitter) emitter.emit('frame', jpeg);
    }
  }

  updateStatus(deviceId, status) {
    this.statuses.set(deviceId, status);
    try {
      this.db.prepare(`
        UPDATE devices SET camera_status = ?, last_seen = ? WHERE device_id = ?
      `).run(status.status || 'Unknown', new Date().toISOString(), deviceId);
    } catch (error) {
      console.error(`[CameraManager] Could not update camera ${deviceId} status:`, error.message);
    }
  }

  async stopDevice(deviceId) {
    const worker = this.workers.get(Number(deviceId));
    if (!worker) return;
    const exited = new Promise(resolve => worker.once('exit', resolve));
    worker.postMessage({ type: 'stop' });
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (this.workers.get(Number(deviceId)) === worker) await worker.terminate();
    this.workers.delete(Number(deviceId));
    this.updateStatus(Number(deviceId), { status: 'Disconnected', lastError: null });
  }

  postToDevice(deviceId, message) {
    const worker = this.workers.get(Number(deviceId));
    if (!worker) return false;
    worker.postMessage(message);
    return true;
  }

  postAll(message) {
    for (const worker of this.workers.values()) worker.postMessage(message);
  }

  listDevices({ includePath = false, activeOnly = false } = {}) {
    const devices = this.db.prepare(`
      SELECT device_id, device_name, location_label, camera_type, camera_path,
             active, last_seen, camera_status, software_version
      FROM devices ${activeOnly ? 'WHERE active = 1' : ''}
      ORDER BY active DESC, device_id
    `).all();
    return devices.map(device => ({
      ...device,
      ...(includePath ? {} : { camera_path: undefined }),
      status: this.statuses.get(device.device_id) || { status: device.camera_status || 'Unknown', lastError: null },
      has_frame: this.frames.has(device.device_id),
      latest_detection: this.detections.get(device.device_id) || null
    }));
  }

  getDevice(deviceId) {
    return this.db.prepare('SELECT * FROM devices WHERE device_id = ?').get(Number(deviceId));
  }

  async addDevice({ deviceName, locationLabel, cameraType, cameraPath }) {
    const result = this.db.prepare(`
      INSERT INTO devices (device_name, location_label, camera_status, software_version, camera_type, camera_path, active)
      VALUES (?, ?, 'Unknown', ?, ?, ?, 1)
    `).run(deviceName, locationLabel || '', config.SOFTWARE_VERSION, cameraType, cameraPath);
    const device = this.getDevice(result.lastInsertRowid);
    await this.startDevice(device);
    return device;
  }

  async updateDevice(deviceId, { deviceName, locationLabel, cameraType, cameraPath }) {
    const device = this.getDevice(deviceId);
    if (!device) return null;
    this.db.prepare(`
      UPDATE devices SET device_name = ?, location_label = ?, camera_type = ?, camera_path = ?
      WHERE device_id = ?
    `).run(deviceName, locationLabel || '', cameraType, cameraPath, Number(deviceId));
    if (device.active) {
      await this.stopDevice(deviceId);
      await this.startDevice(this.getDevice(deviceId));
    }
    return this.getDevice(deviceId);
  }

  async setActive(deviceId, active) {
    const device = this.getDevice(deviceId);
    if (!device) return false;
    this.db.prepare('UPDATE devices SET active = ? WHERE device_id = ?').run(active ? 1 : 0, Number(deviceId));
    if (active) await this.startDevice(this.getDevice(deviceId));
    else await this.stopDevice(deviceId);
    return true;
  }

  getEmitter(deviceId) {
    return this.emitters.get(Number(deviceId)) || null;
  }

  getFrame(deviceId) {
    return this.frames.get(Number(deviceId)) || null;
  }

  getStatus(deviceId) {
    return this.statuses.get(Number(deviceId)) || { status: 'Unknown', lastError: null };
  }

  getAggregateStatus() {
    const active = this.listDevices({ activeOnly: true });
    const connected = active.some(device => device.status.status === 'Connected');
    const allError = active.length > 0 && active.every(device => ['Error', 'Disconnected'].includes(device.status.status));
    return {
      status: connected ? 'Connected' : allError ? 'Error' : 'Disconnected',
      lastError: active.some(device => device.status.lastError)
        ? 'One or more camera sources need attention. Check camera settings.'
        : null,
      activeCameraCount: active.length,
      connectedCameraCount: active.filter(device => device.status.status === 'Connected').length
    };
  }

  async stopAll() {
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    await Promise.all([...this.workers.keys()].map(deviceId => this.stopDevice(deviceId)));
  }
}

module.exports = CameraManager;
