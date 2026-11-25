'use strict';

const EventEmitter = require('events');
const crypto = require('crypto');

class EventManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.deviceId = options.deviceId || 1;
    this.persistenceFrames = options.persistenceFrames || 3;
    this.quietIntervalSeconds = options.quietIntervalSeconds || 5;
    this.notificationCooldownSeconds = options.notificationCooldownSeconds || 60;
    this.detectionMode = options.detectionMode || 'camera_only'; // camera_only, camera_and_pir, camera_or_pir, pir_only

    this.consecutiveMotionFrames = 0;
    this.activeEvent = null;
    this.quietStartTimeMs = null;
    this.lastNotificationTimeMs = 0;
  }

  setOptions(options = {}) {
    if (options.persistenceFrames !== undefined) this.persistenceFrames = options.persistenceFrames;
    if (options.quietIntervalSeconds !== undefined) this.quietIntervalSeconds = options.quietIntervalSeconds;
    if (options.notificationCooldownSeconds !== undefined) this.notificationCooldownSeconds = options.notificationCooldownSeconds;
    if (options.detectionMode !== undefined) this.detectionMode = options.detectionMode;
  }

  generateEventId() {
    const timestampHex = Math.floor(Date.now() / 1000).toString(16);
    const randomHex = crypto.randomBytes(4).toString('hex');
    return `evt_${timestampHex}_${randomHex}`;
  }

  evaluateFusion(cameraMotion, sensorMotion) {
    switch (this.detectionMode) {
      case 'camera_and_pir':
        return cameraMotion && sensorMotion;
      case 'camera_or_pir':
        return cameraMotion || sensorMotion;
      case 'pir_only':
        return Boolean(sensorMotion);
      case 'camera_only':
      default:
        return Boolean(cameraMotion);
    }
  }

  determineDetectionType(cameraMotion, sensorMotion, baseMethod = 'frame_difference') {
    if (this.detectionMode === 'pir_only' || (!cameraMotion && sensorMotion)) {
      return 'pir';
    }
    if (this.detectionMode === 'camera_and_pir' || (cameraMotion && sensorMotion)) {
      return 'camera_and_pir';
    }
    return baseMethod; // 'frame_difference' or 'running_average'
  }

  /**
   * Process a single frame through the event lifecycle state machine.
   * Frame clock is deterministic from the frame source.
   */
  processFrame({
    frameBuffer,
    timestamp,
    timestampMs,
    detectionResult,
    sensorActive = false,
    detectionMethod = 'frame_difference'
  }) {
    const cameraMotion = detectionResult.motion;
    const qualifies = this.evaluateFusion(cameraMotion, sensorActive);

    if (qualifies) {
      this.consecutiveMotionFrames++;
      this.quietStartTimeMs = null; // Reset quiet timer

      if (this.consecutiveMotionFrames >= this.persistenceFrames) {
        if (!this.activeEvent) {
          // Open a new event
          const eventId = this.generateEventId();
          const detectionType = this.determineDetectionType(cameraMotion, sensorActive, detectionMethod);
          const changedArea = detectionResult.changedAreaPercent || 0;

          // Check notification cooldown
          let canNotify = false;
          const cooldownMs = this.notificationCooldownSeconds * 1000;
          if ((timestampMs - this.lastNotificationTimeMs) >= cooldownMs) {
            canNotify = true;
            this.lastNotificationTimeMs = timestampMs;
          }

          this.activeEvent = {
            eventId,
            deviceId: this.deviceId,
            startTime: timestamp,
            startTimeMs: timestampMs,
            endTime: null,
            detectionType,
            changedArea,
            peakChangedArea: changedArea,
            frameBuffer, // Frame that opened the event
            canNotify
          };

          this.emit('event:opened', { ...this.activeEvent });
        } else {
          // Active event continues: update peak changed area
          if (detectionResult.changedAreaPercent > this.activeEvent.peakChangedArea) {
            this.activeEvent.peakChangedArea = detectionResult.changedAreaPercent;
            this.emit('event:updated', { ...this.activeEvent });
          }
        }
      }
    } else {
      // Scene is quiet in this frame
      this.consecutiveMotionFrames = 0;

      if (this.activeEvent) {
        if (this.quietStartTimeMs === null) {
          this.quietStartTimeMs = timestampMs;
        }

        const elapsedQuietSeconds = (timestampMs - this.quietStartTimeMs) / 1000;

        if (elapsedQuietSeconds >= this.quietIntervalSeconds) {
          // Close event
          this.activeEvent.endTime = timestamp;
          const closedEvent = { ...this.activeEvent };
          this.activeEvent = null;
          this.quietStartTimeMs = null;

          this.emit('event:closed', closedEvent);
        }
      }
    }

    return {
      activeEvent: this.activeEvent ? { ...this.activeEvent } : null,
      consecutiveMotionFrames: this.consecutiveMotionFrames
    };
  }

  forceClose(timestamp = new Date().toISOString()) {
    if (this.activeEvent) {
      this.activeEvent.endTime = timestamp;
      const closedEvent = { ...this.activeEvent };
      this.activeEvent = null;
      this.quietStartTimeMs = null;
      this.emit('event:closed', closedEvent);
    }
  }
}

module.exports = EventManager;
