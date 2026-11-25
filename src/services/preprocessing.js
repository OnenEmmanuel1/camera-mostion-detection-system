'use strict';

const sharp = require('sharp');

class PreprocessingService {
  constructor(options = {}) {
    this.targetWidth = options.width || 320;
    this.targetHeight = options.height || 240;
    this.blurSigma = options.blurSigma || 0.5;
  }

  /**
   * Decodes a JPEG buffer, resizes to target internal detection resolution,
   * converts to single-channel 8-bit grayscale, and applies light blur.
   * @param {Buffer} jpegBuffer
   * @returns {Promise<{rawBuffer: Buffer, width: number, height: number}>}
   */
  async process(jpegBuffer) {
    if (!jpegBuffer || !Buffer.isBuffer(jpegBuffer)) {
      throw new Error('Invalid frame buffer passed to preprocessor');
    }

    const pipeline = sharp(jpegBuffer)
      .resize(this.targetWidth, this.targetHeight, { fit: 'fill' })
      .grayscale();

    if (this.blurSigma > 0) {
      pipeline.blur(this.blurSigma);
    }

    const rawBuffer = await pipeline
      .raw({ depth: 'uchar' })
      .toBuffer();

    return {
      rawBuffer,
      width: this.targetWidth,
      height: this.targetHeight
    };
  }
}

module.exports = PreprocessingService;
