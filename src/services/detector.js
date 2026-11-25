'use strict';

class MotionDetector {
  constructor(options = {}) {
    this.width = options.width || 320;
    this.height = options.height || 240;
    this.pixelThreshold = options.pixelThreshold !== undefined ? options.pixelThreshold : 25;
    this.minChangedArea = options.minChangedArea !== undefined ? options.minChangedArea : 0.50;
    this.ignoreRegions = options.ignoreRegions || [];
    this.mask = null;
    this.effectivePixelCount = this.width * this.height;
    this.buildMask();
  }

  setOptions(options = {}) {
    if (options.pixelThreshold !== undefined) this.pixelThreshold = options.pixelThreshold;
    if (options.minChangedArea !== undefined) this.minChangedArea = options.minChangedArea;
    if (options.ignoreRegions !== undefined) {
      this.ignoreRegions = options.ignoreRegions;
      this.buildMask();
    }
  }

  buildMask() {
    const totalPixels = this.width * this.height;
    this.mask = new Uint8Array(totalPixels); // 1 = active, 0 = ignored
    let activeCount = 0;

    for (let y = 0; y < this.height; y++) {
      const ny = y / this.height;
      for (let x = 0; x < this.width; x++) {
        const nx = x / this.width;
        let isIgnored = false;

        for (let r = 0; r < this.ignoreRegions.length; r++) {
          const reg = this.ignoreRegions[r];
          if (nx >= reg.x && nx <= (reg.x + reg.w) && ny >= reg.y && ny <= (reg.y + reg.h)) {
            isIgnored = true;
            break;
          }
        }

        const idx = y * this.width + x;
        if (!isIgnored) {
          this.mask[idx] = 1;
          activeCount++;
        } else {
          this.mask[idx] = 0;
        }
      }
    }

    this.effectivePixelCount = activeCount > 0 ? activeCount : totalPixels;
  }

  reset() {
    // Override in subclass
  }

  detect(rawBuffer) {
    throw new Error('detect() must be implemented by subclass');
  }
}

/**
 * FrameDifferenceDetector: Compares current grayscale frame with previous frame.
 */
class FrameDifferenceDetector extends MotionDetector {
  constructor(options = {}) {
    super(options);
    this.previousFrame = null;
  }

  reset() {
    this.previousFrame = null;
  }

  detect(rawBuffer) {
    if (!this.previousFrame) {
      this.previousFrame = Buffer.from(rawBuffer);
      return {
        motion: false,
        changedAreaPercent: 0,
        changedPixelCount: 0,
        effectivePixelCount: this.effectivePixelCount
      };
    }

    let changedCount = 0;
    const len = rawBuffer.length;
    const prev = this.previousFrame;
    const thresh = this.pixelThreshold;
    const mask = this.mask;

    for (let i = 0; i < len; i++) {
      if (mask[i] === 0) continue; // Ignored region

      const diff = Math.abs(rawBuffer[i] - prev[i]);
      if (diff >= thresh) {
        changedCount++;
      }
    }

    // Save current frame as previous for next comparison
    rawBuffer.copy(this.previousFrame);

    const changedAreaPercent = Number(((changedCount / this.effectivePixelCount) * 100).toFixed(2));
    const motion = changedAreaPercent >= this.minChangedArea;

    return {
      motion,
      changedAreaPercent,
      changedPixelCount: changedCount,
      effectivePixelCount: this.effectivePixelCount
    };
  }
}

/**
 * RunningAverageDetector: Compares current frame against an exponentially updated background estimate.
 */
class RunningAverageDetector extends MotionDetector {
  constructor(options = {}) {
    super(options);
    this.alpha = options.alpha !== undefined ? options.alpha : 0.05; // Learning rate for background model
    this.bgModel = null;
  }

  reset() {
    this.bgModel = null;
  }

  detect(rawBuffer) {
    const len = rawBuffer.length;

    if (!this.bgModel) {
      this.bgModel = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        this.bgModel[i] = rawBuffer[i];
      }
      return {
        motion: false,
        changedAreaPercent: 0,
        changedPixelCount: 0,
        effectivePixelCount: this.effectivePixelCount
      };
    }

    let changedCount = 0;
    const thresh = this.pixelThreshold;
    const mask = this.mask;
    const bg = this.bgModel;
    const alpha = this.alpha;

    for (let i = 0; i < len; i++) {
      if (mask[i] === 0) continue;

      const currentVal = rawBuffer[i];
      const diff = Math.abs(currentVal - bg[i]);
      if (diff >= thresh) {
        changedCount++;
      }

      // Background model update: exponentially decaying running average
      // Allows gradual ambient lighting shifts (e.g. clouds, sun) to be absorbed into background
      bg[i] = alpha * currentVal + (1.0 - alpha) * bg[i];
    }

    const changedAreaPercent = Number(((changedCount / this.effectivePixelCount) * 100).toFixed(2));
    const motion = changedAreaPercent >= this.minChangedArea;

    return {
      motion,
      changedAreaPercent,
      changedPixelCount: changedCount,
      effectivePixelCount: this.effectivePixelCount
    };
  }
}

function createDetector(method = 'frame_difference', options = {}) {
  if (method === 'running_average') {
    return new RunningAverageDetector(options);
  }
  return new FrameDifferenceDetector(options);
}

module.exports = {
  MotionDetector,
  FrameDifferenceDetector,
  RunningAverageDetector,
  createDetector
};
