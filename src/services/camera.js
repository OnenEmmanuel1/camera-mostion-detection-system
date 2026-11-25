'use strict';

const EventEmitter = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { config } = require('../config');

function getFfmpegPath() {
  if (config.FFMPEG_PATH && fs.existsSync(config.FFMPEG_PATH)) {
    return config.FFMPEG_PATH;
  }
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      return ffmpegStatic;
    }
  } catch (e) {}
  return 'ffmpeg';
}

class FrameSource extends EventEmitter {
  constructor(options = {}) {
    super();
    this.status = 'Unknown'; // 'Connected', 'Disconnected', 'Error', 'Unknown'
    this.lastError = null;
    this.frameNumber = 0;
    this.running = false;
    this.fps = options.fps || 5;
  }

  getStatus() {
    return {
      status: this.status,
      lastError: this.lastError,
      frameNumber: this.frameNumber,
      running: this.running
    };
  }

  setStatus(newStatus, error = null) {
    if (this.status !== newStatus || error) {
      this.status = newStatus;
      this.lastError = error ? (error.message || String(error)) : null;
      this.emit('status', this.getStatus());
    }
  }

  async start() {
    throw new Error('start() must be implemented by subclass');
  }

  async stop() {
    this.running = false;
    this.setStatus('Disconnected');
  }
}

/**
 * Parses a stream of chunks into distinct JPEG frame buffers
 * by looking for SOI (0xFF, 0xD8) and EOI (0xFF, 0xD9) markers.
 */
class JpegStreamParser extends EventEmitter {
  constructor() {
    super();
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    let startIndex = -1;
    let i = 0;

    while (i < this.buffer.length - 1) {
      if (startIndex === -1) {
        if (this.buffer[i] === 0xFF && this.buffer[i + 1] === 0xD8) {
          startIndex = i;
          i += 2;
          continue;
        }
      } else {
        if (this.buffer[i] === 0xFF && this.buffer[i + 1] === 0xD9) {
          const frame = this.buffer.slice(startIndex, i + 2);
          this.emit('frame', frame);
          this.buffer = this.buffer.slice(i + 2);
          startIndex = -1;
          i = 0;
          continue;
        }
      }
      i++;
    }

    // Safety: prevent unbounded memory if stream gets corrupted and lacks markers
    if (this.buffer.length > 10 * 1024 * 1024) {
      this.buffer = Buffer.alloc(0);
    }
  }

  reset() {
    this.buffer = Buffer.alloc(0);
  }
}

/**
 * FileFrameSource: Replays a pre-recorded video file.
 * Guaranteed deterministic timestamp clock for repeatable evaluation.
 */
class FileFrameSource extends FrameSource {
  constructor(options = {}) {
    super(options);
    this.filePath = options.filePath || config.CAMERA_PATH;
    this.loop = options.loop !== undefined ? options.loop : true;
    this.ffmpegProc = null;
    this.parser = new JpegStreamParser();
    this.baseTimestampMs = options.baseTimestampMs || new Date('2026-01-01T00:00:00.000Z').getTime();
    this.realtime = options.realtime !== undefined ? options.realtime : true;
    this.retryTimeout = null;

    this.parser.on('frame', (frameBuffer) => {
      if (!this.running) return;
      this.frameNumber++;
      // Source-derived deterministic timestamp
      const frameTimestampMs = this.baseTimestampMs + (this.frameNumber * (1000 / this.fps));
      const timestampIso = new Date(frameTimestampMs).toISOString();

      this.setStatus('Connected');
      this.emit('frame', {
        buffer: frameBuffer,
        timestamp: timestampIso,
        timestampMs: frameTimestampMs,
        frameNumber: this.frameNumber
      });
    });
  }

  async start() {
    if (this.running) return;
    this.running = true;

    if (!fs.existsSync(this.filePath)) {
      this.setStatus('Error', new Error(`Video file not found: ${this.filePath}`));
      // Retry in 3 seconds in case file is being generated
      this.retryTimeout = setTimeout(() => {
        if (this.running) {
          this.running = false;
          this.start();
        }
      }, 3000);
      return;
    }

    const ffmpegPath = getFfmpegPath();
    const args = [];

    // If realtime replay is desired, throttle with -re
    if (this.realtime) {
      args.push('-re');
    }

    args.push('-i', this.filePath);
    args.push('-vf', `fps=${this.fps}`);
    args.push('-f', 'image2pipe');
    args.push('-vcodec', 'mjpeg');
    args.push('-q:v', '3'); // Good JPEG quality
    args.push('-');

    try {
      this.ffmpegProc = spawn(ffmpegPath, args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.ffmpegProc.stdout.on('data', (chunk) => {
        this.parser.push(chunk);
      });

      this.ffmpegProc.stderr.on('data', (data) => {
        // debug or filter ffmpeg output
      });

      this.ffmpegProc.on('error', (err) => {
        this.setStatus('Error', err);
      });

      this.ffmpegProc.on('close', (code) => {
        if (this.running) {
          if (this.loop) {
            // Restart loop
            this.parser.reset();
            this.startLoop();
          } else {
            this.running = false;
            this.setStatus('Disconnected');
            this.emit('ended');
          }
        }
      });

      this.setStatus('Connected');
    } catch (err) {
      this.setStatus('Error', err);
    }
  }

  startLoop() {
    if (!this.running) return;
    setTimeout(() => {
      if (this.running) {
        this.running = false;
        this.start();
      }
    }, 100);
  }

  async stop() {
    this.running = false;
    if (this.retryTimeout) clearTimeout(this.retryTimeout);
    if (this.ffmpegProc) {
      try {
        this.ffmpegProc.kill('SIGTERM');
      } catch (e) {}
      this.ffmpegProc = null;
    }
    this.parser.reset();
    super.stop();
  }
}

/**
 * UsbFrameSource: Reads USB webcam using ffmpeg v4l2 (Linux) or dshow (Windows).
 */
class UsbFrameSource extends FrameSource {
  constructor(options = {}) {
    super(options);
    this.devicePath = options.devicePath || config.CAMERA_PATH || '/dev/video0';
    this.ffmpegProc = null;
    this.parser = new JpegStreamParser();
    this.backoffMs = 1000;
    this.retryTimeout = null;

    this.parser.on('frame', (frameBuffer) => {
      if (!this.running) return;
      this.frameNumber++;
      this.backoffMs = 1000; // reset backoff on good frame
      this.setStatus('Connected');
      this.emit('frame', {
        buffer: frameBuffer,
        timestamp: new Date().toISOString(),
        timestampMs: Date.now(),
        frameNumber: this.frameNumber
      });
    });
  }

  async start() {
    if (this.running) return;
    this.running = true;

    const ffmpegPath = getFfmpegPath();
    const isWin = process.platform === 'win32';
    const args = [];

    if (isWin) {
      args.push('-f', 'dshow');
      args.push('-i', `video=${this.devicePath}`);
    } else {
      args.push('-f', 'v4l2');
      args.push('-input_format', 'mjpeg');
      args.push('-i', this.devicePath);
    }

    args.push('-vf', `fps=${this.fps}`);
    args.push('-f', 'image2pipe');
    args.push('-vcodec', 'mjpeg');
    args.push('-');

    try {
      this.ffmpegProc = spawn(ffmpegPath, args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.ffmpegProc.stdout.on('data', (chunk) => {
        this.parser.push(chunk);
      });

      this.ffmpegProc.stderr.on('data', (data) => {
        // Log warnings/errors if any
      });

      this.ffmpegProc.on('error', (err) => {
        this.setStatus('Error', err);
        this.scheduleRetry();
      });

      this.ffmpegProc.on('close', (code) => {
        if (this.running) {
          this.setStatus('Disconnected', new Error(`USB camera stream exited with code ${code}`));
          this.scheduleRetry();
        }
      });
    } catch (err) {
      this.setStatus('Error', err);
      this.scheduleRetry();
    }
  }

  scheduleRetry() {
    if (!this.running) return;
    if (this.retryTimeout) clearTimeout(this.retryTimeout);
    this.retryTimeout = setTimeout(() => {
      if (this.running) {
        this.backoffMs = Math.min(this.backoffMs * 2, 30000); // max 30s backoff
        this.running = false;
        this.start();
      }
    }, this.backoffMs);
  }

  async stop() {
    this.running = false;
    if (this.retryTimeout) clearTimeout(this.retryTimeout);
    if (this.ffmpegProc) {
      try {
        this.ffmpegProc.kill('SIGTERM');
      } catch (e) {}
      this.ffmpegProc = null;
    }
    this.parser.reset();
    super.stop();
  }
}

/**
 * UrlFrameSource: Connects to RTSP or HTTP camera stream via ffmpeg.
 */
class UrlFrameSource extends FrameSource {
  constructor(options = {}) {
    super(options);
    this.url = options.url || config.CAMERA_PATH;
    this.ffmpegProc = null;
    this.parser = new JpegStreamParser();
    this.backoffMs = 1000;
    this.retryTimeout = null;

    this.parser.on('frame', (frameBuffer) => {
      if (!this.running) return;
      this.frameNumber++;
      this.backoffMs = 1000;
      this.setStatus('Connected');
      this.emit('frame', {
        buffer: frameBuffer,
        timestamp: new Date().toISOString(),
        timestampMs: Date.now(),
        frameNumber: this.frameNumber
      });
    });
  }

  async start() {
    if (this.running) return;
    this.running = true;

    const ffmpegPath = getFfmpegPath();
    const args = [
      '-rtsp_transport', 'tcp',
      '-i', this.url,
      '-vf', `fps=${this.fps}`,
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-'
    ];

    try {
      this.ffmpegProc = spawn(ffmpegPath, args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.ffmpegProc.stdout.on('data', (chunk) => {
        this.parser.push(chunk);
      });

      this.ffmpegProc.on('error', (err) => {
        this.setStatus('Error', err);
        this.scheduleRetry();
      });

      this.ffmpegProc.on('close', (code) => {
        if (this.running) {
          this.setStatus('Disconnected', new Error(`Network stream closed with code ${code}`));
          this.scheduleRetry();
        }
      });
    } catch (err) {
      this.setStatus('Error', err);
      this.scheduleRetry();
    }
  }

  scheduleRetry() {
    if (!this.running) return;
    if (this.retryTimeout) clearTimeout(this.retryTimeout);
    this.retryTimeout = setTimeout(() => {
      if (this.running) {
        this.backoffMs = Math.min(this.backoffMs * 2, 30000);
        this.running = false;
        this.start();
      }
    }, this.backoffMs);
  }

  async stop() {
    this.running = false;
    if (this.retryTimeout) clearTimeout(this.retryTimeout);
    if (this.ffmpegProc) {
      try {
        this.ffmpegProc.kill('SIGTERM');
      } catch (e) {}
      this.ffmpegProc = null;
    }
    this.parser.reset();
    super.stop();
  }
}

function createFrameSource(type = config.CAMERA_TYPE, options = {}) {
  switch (type.toLowerCase()) {
    case 'usb':
      return new UsbFrameSource(options);
    case 'url':
      return new UrlFrameSource(options);
    case 'file':
    default:
      return new FileFrameSource(options);
  }
}

module.exports = {
  FrameSource,
  FileFrameSource,
  UsbFrameSource,
  UrlFrameSource,
  createFrameSource,
  getFfmpegPath
};
