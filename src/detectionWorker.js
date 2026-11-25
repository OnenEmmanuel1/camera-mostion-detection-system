'use strict';

const { parentPort, workerData } = require('worker_threads');
const { config } = require('./config');
const { getDb } = require('./db/database');
const ConfigService = require('./services/config');
const StorageService = require('./services/storage');
const AuditService = require('./services/audit');
const { MediaCaptureService, FrameRingBuffer } = require('./services/mediaCapture');
const NotifierService = require('./services/notifier');
const HealthService = require('./services/health');
const PreprocessingService = require('./services/preprocessing');
const { createDetector } = require('./services/detector');
const EventManager = require('./services/eventManager');
const { createFrameSource } = require('./services/camera');
const { HttpSensorSource, GpioSensorSource } = require('./services/sensor');

class DetectionWorker {
  constructor(options = {}) {
    this.deviceId = Number(options.deviceId) || 1;
    this.cameraType = options.cameraType || config.CAMERA_TYPE;
    this.cameraPath = options.cameraPath || config.CAMERA_PATH;
    this.db = getDb();
    this.configService = new ConfigService(this.db);
    this.storage = new StorageService(this.db);
    this.audit = new AuditService(this.db);
    this.mediaCapture = new MediaCaptureService({ mediaRoot: config.MEDIA_ROOT });
    this.notifier = new NotifierService({ db: this.db, config, mediaCapture: this.mediaCapture });
    this.health = new HealthService({ db: this.db, mediaRoot: config.MEDIA_ROOT, deviceId: this.deviceId });
    this.preprocessor = new PreprocessingService({ width: 320, height: 240, blurSigma: 0.5 });

    // Sensors
    this.httpSensor = new HttpSensorSource({ windowMs: 3000 });
    this.gpioSensor = new GpioSensorSource(17);

    // Dynamic components
    this.detector = null;
    this.eventManager = null;
    this.frameSource = null;
    this.ringBuffer = new FrameRingBuffer(
      this.configService.get('clip_pre_roll_seconds') || 3,
      this.configService.get('detection_fps') || 5
    );

    this.activeClipRecording = null;
    this.heartbeatTimer = null;
    this.retentionTimer = null;
    this.processingFrame = false;
    this.running = false;
    this.browserCameraActive = false;
  }

  isSensorActive() {
    return this.httpSensor.isActive() || this.gpioSensor.isActive();
  }

  initDetector() {
    const method = this.configService.get('detection_method') || 'frame_difference';
    this.detector = createDetector(method, {
      width: 320,
      height: 240,
      pixelThreshold: this.configService.get('pixel_threshold'),
      minChangedArea: this.configService.get('min_changed_area'),
      ignoreRegions: this.configService.get('ignore_regions')
    });
  }

  initEventManager() {
    this.eventManager = new EventManager({
      deviceId: this.deviceId,
      persistenceFrames: this.configService.get('persistence_frames'),
      quietIntervalSeconds: this.configService.get('quiet_interval_seconds'),
      notificationCooldownSeconds: this.configService.get('notification_cooldown_seconds'),
      detectionMode: this.configService.get('detection_mode')
    });

    // Event Lifecycle Listeners
    this.eventManager.on('event:opened', async (event) => {
      try {
        const recordingEnabled = this.configService.get('recording_enabled');
        let mediaPath = null;

        if (recordingEnabled) {
          // Media-first write guarantee (Section 4.2.4, 4.3.3)
          mediaPath = await this.mediaCapture.saveStill(event.eventId, event.frameBuffer);
        }

        // Insert event into database with media reference or null if unavailable
        this.storage.createEvent({
          eventId: event.eventId,
          deviceId: event.deviceId,
          startTime: event.startTime,
          detectionType: event.detectionType,
          changedArea: event.peakChangedArea,
          mediaPath,
          reviewStatus: 'New'
        });

        // Notifications
        if (event.canNotify) {
          this.notifier.notifyEvent(event, { frameJpeg: event.frameBuffer, baseUrl: config.PUBLIC_APP_URL }).catch(err => {
            console.error('[Worker] Notification error:', err.message);
          });
        }

        // Optional clip recording
        if (recordingEnabled && this.configService.get('clips_enabled')) {
          this.activeClipRecording = {
            eventId: event.eventId,
            frames: this.ringBuffer.getFrames(), // Pre-roll frames
            postRollNeeded: (this.configService.get('clip_post_roll_seconds') || 5) * (this.configService.get('detection_fps') || 5),
            postRollCount: 0
          };
        }

        this.sendToParent({
          type: 'event_opened',
          event: {
            eventId: event.eventId,
            startTime: event.startTime,
            detectionType: event.detectionType,
            changedArea: event.peakChangedArea,
            mediaPath
          }
        });
      } catch (err) {
        console.error('[Worker] Error handling event:opened:', err.message);
      }
    });

    this.eventManager.on('event:updated', (event) => {
      try {
        this.storage.updateEvent(event.eventId, {
          peakChangedArea: event.peakChangedArea
        });
      } catch (err) {
        console.error('[Worker] Error updating event:', err.message);
      }
    });

    this.eventManager.on('event:closed', async (event) => {
      try {
        this.storage.updateEvent(event.eventId, {
          endTime: event.endTime,
          peakChangedArea: event.peakChangedArea
        });

        this.sendToParent({
          type: 'event_closed',
          event: {
            eventId: event.eventId,
            endTime: event.endTime,
            peakChangedArea: event.peakChangedArea
          }
        });
      } catch (err) {
        console.error('[Worker] Error handling event:closed:', err.message);
      }
    });
  }

  initFrameSource() {
    const fps = this.configService.get('detection_fps') || 5;

    this.frameSource = createFrameSource(this.cameraType, {
      fps,
      filePath: this.cameraPath,
      devicePath: this.cameraPath,
      url: this.cameraPath,
      loop: true,
      realtime: true
    });

    this.frameSource.on('status', (status) => {
      this.health.recordHeartbeat(status.status);
      this.sendToParent({ type: 'camera_status', status });
    });

    this.frameSource.on('frame', async (frameObj) => {
      if (this.browserCameraActive) return;
      await this.processFrame(frameObj);
    });
  }

  async processFrame(frameObj) {
    if (!this.running || this.processingFrame) return;

    this.processingFrame = true;
    try {
        // Feed into ring buffer for clip capture
        this.ringBuffer.push({ buffer: frameObj.buffer, timestamp: frameObj.timestamp });

        // If a clip recording is active, collect frames
        if (this.activeClipRecording) {
          this.activeClipRecording.frames.push({ buffer: frameObj.buffer, timestamp: frameObj.timestamp });
          if (!this.eventManager.activeEvent) {
            this.activeClipRecording.postRollCount++;
            if (this.activeClipRecording.postRollCount >= this.activeClipRecording.postRollNeeded) {
              const clipToEncode = this.activeClipRecording;
              this.activeClipRecording = null;
              this.finalizeClip(clipToEncode);
            }
          }
        }

        const detectionEnabled = this.configService.get('detection_enabled');
        let detectionResult = {
          motion: false,
          changedAreaPercent: 0,
          changedPixelCount: 0,
          effectivePixelCount: 320 * 240
        };

        if (detectionEnabled) {
          // Preprocess: downscale to 320x240, grayscale, light blur
          const { rawBuffer } = await this.preprocessor.process(frameObj.buffer);

          // Hand-written detector execution
          detectionResult = this.detector.detect(rawBuffer);

          // Event state machine with deterministic clock
          this.eventManager.processFrame({
            frameBuffer: frameObj.buffer,
            timestamp: frameObj.timestamp,
            timestampMs: frameObj.timestampMs,
            detectionResult,
            sensorActive: this.isSensorActive(),
            detectionMethod: this.configService.get('detection_method')
          });
        }

        // Post latest frame and detection metrics to web server
        this.sendToParent({
          type: 'frame',
          jpeg: frameObj.buffer,
          timestamp: frameObj.timestamp,
          detection: {
            motion: detectionResult.motion,
            changedAreaPercent: detectionResult.changedAreaPercent
          }
        });
    } catch (err) {
      console.error('[Worker] Frame processing error:', err.message);
    } finally {
      this.processingFrame = false;
    }
  }

  async finalizeClip(clipRecording) {
    try {
      const fps = this.configService.get('detection_fps') || 5;
      const clipPath = await this.mediaCapture.encodeClip(clipRecording.eventId, clipRecording.frames, fps);
      if (clipPath) {
        this.storage.updateEvent(clipRecording.eventId, { mediaPath: clipPath });
        this.sendToParent({
          type: 'clip_encoded',
          eventId: clipRecording.eventId,
          clipPath
        });
      }
    } catch (err) {
      console.error('[Worker] Clip finalization failed:', err.message);
    }
  }

  async start() {
    this.running = true;
    this.initDetector();
    this.initEventManager();
    this.initFrameSource();

    // Start acquisition loop
    await this.frameSource.start();

    // Periodic heartbeat and storage check (every 5 seconds)
    this.heartbeatTimer = setInterval(async () => {
      try {
        const threshold = this.configService.get('low_storage_threshold_percent') || 10;
        const storage = await this.health.checkStorage(threshold);
        this.mediaCapture.setLowStorage(storage.lowStorage);

        const camStatus = this.browserCameraActive
          ? { status: 'Connected', lastError: null, source: 'Browser camera' }
          : this.frameSource.getStatus();
        this.health.recordHeartbeat(camStatus.status);

        this.sendToParent({
          type: 'heartbeat',
          storage,
          cameraStatus: camStatus
        });
      } catch (e) {
        console.error('[Worker] Heartbeat error:', e.message);
      }
    }, 5000);

    // Listen for parent messages
    if (parentPort) {
      parentPort.on('message', (msg) => this.handleParentMessage(msg));
    }
  }

  handleParentMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'browser_camera_start': {
        this.browserCameraActive = true;
        this.detector && this.detector.reset();
        this.sendToParent({ type: 'camera_status', status: { status: 'Connected', lastError: null, source: 'Browser camera' } });
        break;
      }
      case 'browser_camera_stop': {
        this.browserCameraActive = false;
        this.detector && this.detector.reset();
        this.sendToParent({ type: 'camera_status', status: this.frameSource.getStatus() });
        break;
      }
      case 'browser_camera_frame': {
        if (this.browserCameraActive && (Buffer.isBuffer(msg.jpeg) || ArrayBuffer.isView(msg.jpeg))) {
          const now = Date.now();
          const jpeg = Buffer.isBuffer(msg.jpeg)
            ? msg.jpeg
            : Buffer.from(msg.jpeg.buffer, msg.jpeg.byteOffset, msg.jpeg.byteLength);
          this.processFrame({ buffer: jpeg, timestamp: new Date(now).toISOString(), timestampMs: now, frameNumber: 0 });
        }
        break;
      }
      case 'update_settings': {
        this.configService.reload();
        // Update detector parameters
        if (this.detector) {
          this.initDetector(); // Re-init detector with fresh method, thresholds, ignore regions
        }
        if (this.eventManager) {
          this.eventManager.setOptions({
            persistenceFrames: this.configService.get('persistence_frames'),
            quietIntervalSeconds: this.configService.get('quiet_interval_seconds'),
            notificationCooldownSeconds: this.configService.get('notification_cooldown_seconds'),
            detectionMode: this.configService.get('detection_mode')
          });
        }
        if (this.ringBuffer) {
          this.ringBuffer.setCapacity(
            this.configService.get('clip_pre_roll_seconds') || 3,
            this.configService.get('detection_fps') || 5
          );
        }
        break;
      }
      case 'sensor_trigger': {
        this.httpSensor.trigger(msg.metadata);
        break;
      }
      case 'run_retention': {
        const retentionDays = msg.retentionDays || this.configService.get('retention_days') || 14;
        const result = this.storage.runRetention(retentionDays, this.mediaCapture, this.audit);
        this.sendToParent({ type: 'retention_completed', result });
        break;
      }
      case 'stop': {
        this.stop();
        break;
      }
      default:
        break;
    }
  }

  sendToParent(message) {
    if (parentPort) {
      try {
        parentPort.postMessage({ ...message, deviceId: this.deviceId });
      } catch (e) {}
    }
  }

  async stop() {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);

    if (this.eventManager) {
      this.eventManager.forceClose();
    }
    if (this.frameSource) {
      await this.frameSource.stop();
    }
    this.gpioSensor.cleanup();
    if (parentPort) parentPort.close();
  }
}

// Start worker if executed directly or in thread
const worker = new DetectionWorker(workerData || {});
worker.start().catch((err) => {
  console.error('[Worker] Fatal startup error:', err);
});

module.exports = DetectionWorker;
