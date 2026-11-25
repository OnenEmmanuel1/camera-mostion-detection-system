'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { config } = require('../config');
const { getFfmpegPath } = require('./camera');

class MediaCaptureService {
  constructor(options = {}) {
    this.mediaRoot = options.mediaRoot || config.MEDIA_ROOT;
    this.stillsDir = path.join(this.mediaRoot, 'stills');
    this.clipsDir = path.join(this.mediaRoot, 'clips');
    this.lowStorage = false;

    this.ensureDirs();
  }

  ensureDirs() {
    try {
      if (!fs.existsSync(this.mediaRoot)) fs.mkdirSync(this.mediaRoot, { recursive: true });
      if (!fs.existsSync(this.stillsDir)) fs.mkdirSync(this.stillsDir, { recursive: true });
      if (!fs.existsSync(this.clipsDir)) fs.mkdirSync(this.clipsDir, { recursive: true });
    } catch (err) {
      console.error('[MediaCapture] Failed to create media directories:', err.message);
    }
  }

  setLowStorage(isLow) {
    this.lowStorage = isLow;
  }

  /**
   * Resolves a media path relative to mediaRoot and validates against path traversal.
   * @param {string} relativePath
   * @returns {string|null} Absolute safe path or null if invalid
   */
  resolveSafePath(relativePath) {
    if (!relativePath || typeof relativePath !== 'string') return null;
    const root = path.resolve(this.mediaRoot);
    const absolute = path.resolve(root, relativePath);
    const relative = path.relative(root, absolute);

    // Reject absolute paths and any path that resolves outside mediaRoot.
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      return null;
    }
    return absolute;
  }

  /**
   * Media-first still image write.
   * Saves the trigger frame to disk BEFORE the event record is inserted.
   * Returns relative path (e.g. 'stills/evt_123.jpg') or null on failure.
   */
  async saveStill(eventId, jpegBuffer) {
    if (this.lowStorage) {
      console.warn(`[MediaCapture] Storage low: skipping still capture for event ${eventId}`);
      return null;
    }

    if (!jpegBuffer || !Buffer.isBuffer(jpegBuffer)) {
      console.error(`[MediaCapture] Invalid or empty JPEG buffer for event ${eventId}`);
      return null;
    }

    try {
      const fileName = `${eventId}.jpg`;
      const filePath = path.join(this.stillsDir, fileName);
      await fs.promises.writeFile(filePath, jpegBuffer);

      // Verify file exists and has size
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 0) {
        return path.join('stills', fileName).replace(/\\/g, '/');
      }
      return null;
    } catch (err) {
      console.error(`[MediaCapture] Failed to write still for ${eventId}:`, err.message);
      return null;
    }
  }

  /**
   * Encodes a sequence of JPEG buffers into an MP4 clip using ffmpeg.
   * @param {string} eventId
   * @param {Array<{buffer: Buffer}>} frames
   * @param {number} fps
   * @returns {Promise<string|null>} relative path to clip
   */
  async encodeClip(eventId, frames, fps = 5) {
    if (this.lowStorage) {
      console.warn(`[MediaCapture] Storage low: skipping clip encoding for event ${eventId}`);
      return null;
    }

    if (!frames || frames.length === 0) {
      return null;
    }

    const clipFileName = `${eventId}.mp4`;
    const clipFilePath = path.join(this.clipsDir, clipFileName);
    const ffmpegPath = getFfmpegPath();

    return new Promise((resolve) => {
      const args = [
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-framerate', String(fps),
        '-i', '-',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'veryfast',
        '-crf', '26',
        '-movflags', '+faststart',
        '-y',
        clipFilePath
      ];

      const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'ignore'] });

      proc.on('error', (err) => {
        console.error(`[MediaCapture] FFmpeg clip encoding error:`, err.message);
        resolve(null);
      });

      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(clipFilePath)) {
          resolve(path.join('clips', clipFileName).replace(/\\/g, '/'));
        } else {
          resolve(null);
        }
      });

      // Pipe frames sequentially
      for (const f of frames) {
        if (proc.stdin.writable) {
          proc.stdin.write(f.buffer);
        }
      }
      if (proc.stdin.writable) {
        proc.stdin.end();
      }
    });
  }

  /**
   * Delete media file safely
   */
  deleteMedia(relativePath) {
    const safePath = this.resolveSafePath(relativePath);
    if (safePath && fs.existsSync(safePath)) {
      try {
        fs.unlinkSync(safePath);
        return true;
      } catch (err) {
        console.error(`[MediaCapture] Error deleting media ${safePath}:`, err.message);
      }
    }
    return false;
  }
}

/**
 * RingBuffer: Keeps a rolling window of recent frames for clip pre-roll.
 */
class FrameRingBuffer {
  constructor(maxSeconds = 5, fps = 5) {
    this.maxFrames = Math.max(1, maxSeconds * fps);
    this.buffer = [];
  }

  setCapacity(seconds, fps) {
    this.maxFrames = Math.max(1, Math.round(seconds * fps));
    while (this.buffer.length > this.maxFrames) {
      this.buffer.shift();
    }
  }

  push(frameObj) {
    this.buffer.push(frameObj);
    if (this.buffer.length > this.maxFrames) {
      this.buffer.shift();
    }
  }

  getFrames() {
    return [...this.buffer];
  }

  clear() {
    this.buffer = [];
  }
}

module.exports = {
  MediaCaptureService,
  FrameRingBuffer
};
