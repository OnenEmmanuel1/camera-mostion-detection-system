'use strict';

const EventEmitter = require('events');

class SensorSource extends EventEmitter {
  constructor() {
    super();
    this.active = false;
    this.lastTriggeredAt = null;
  }

  isActive() {
    return this.active;
  }

  trigger() {
    throw new Error('trigger() must be implemented by subclass');
  }
}

/**
 * HttpSensorSource: Triggered via authenticated HTTP endpoint POST /api/device/sensor
 * Keeps sensor in active state for windowMs (default 3000ms) after signal received.
 */
class HttpSensorSource extends SensorSource {
  constructor(options = {}) {
    super();
    this.windowMs = options.windowMs || 3000;
    this.timeoutId = null;
  }

  trigger(metadata = {}) {
    this.active = true;
    this.lastTriggeredAt = new Date().toISOString();
    this.emit('trigger', {
      timestamp: this.lastTriggeredAt,
      source: 'http',
      metadata
    });

    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }

    this.timeoutId = setTimeout(() => {
      this.active = false;
      this.emit('clear', { timestamp: new Date().toISOString() });
    }, this.windowMs);
  }
}

/**
 * GpioSensorSource: Optional PIR sensor connected to Raspberry Pi GPIO pin.
 * Safely handles missing hardware GPIO libraries when running on standard hosts.
 */
class GpioSensorSource extends SensorSource {
  constructor(pin = 17) {
    super();
    this.pin = pin;
    this.hardwareAvailable = false;
    this.gpioInstance = null;
    this.initHardware();
  }

  initHardware() {
    try {
      // Check if onoff is available on host
      const Gpio = require('onoff').Gpio;
      this.gpioInstance = new Gpio(this.pin, 'in', 'both');
      this.hardwareAvailable = true;

      this.gpioInstance.watch((err, value) => {
        if (err) {
          console.error(`[GpioSensor] GPIO watch error on pin ${this.pin}:`, err.message);
          return;
        }
        this.active = value === 1;
        if (this.active) {
          this.lastTriggeredAt = new Date().toISOString();
          this.emit('trigger', { timestamp: this.lastTriggeredAt, source: 'gpio', pin: this.pin });
        } else {
          this.emit('clear', { timestamp: new Date().toISOString() });
        }
      });
    } catch (e) {
      // GPIO hardware or onoff module not available on this platform
      this.hardwareAvailable = false;
    }
  }

  getStatus() {
    return {
      hardwareAvailable: this.hardwareAvailable,
      pin: this.pin,
      active: this.active,
      lastTriggeredAt: this.lastTriggeredAt
    };
  }

  cleanup() {
    if (this.gpioInstance && typeof this.gpioInstance.unexport === 'function') {
      try {
        this.gpioInstance.unexport();
      } catch (e) {}
    }
  }
}

module.exports = {
  SensorSource,
  HttpSensorSource,
  GpioSensorSource
};
