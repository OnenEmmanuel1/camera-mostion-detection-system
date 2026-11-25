'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameDifferenceDetector, RunningAverageDetector } = require('../src/services/detector');

test('FrameDifferenceDetector: Identical frames return zero motion', () => {
  const detector = new FrameDifferenceDetector({
    width: 10,
    height: 10,
    pixelThreshold: 25,
    minChangedArea: 1.0
  });

  const frame1 = Buffer.alloc(100, 50); // 100 pixels all luminance 50
  const frame2 = Buffer.alloc(100, 50);

  const res1 = detector.detect(frame1);
  assert.equal(res1.motion, false);
  assert.equal(res1.changedAreaPercent, 0);

  const res2 = detector.detect(frame2);
  assert.equal(res2.motion, false);
  assert.equal(res2.changedAreaPercent, 0);
});

test('FrameDifferenceDetector: Respects pixelThreshold and minChangedArea', () => {
  const detector = new FrameDifferenceDetector({
    width: 10,
    height: 10,
    pixelThreshold: 30,
    minChangedArea: 5.0 // 5% of 100 pixels = 5 pixels
  });

  const frame1 = Buffer.alloc(100, 50);
  detector.detect(frame1);

  // Case A: 4 pixels changed by 40 (diff > 30, but count 4 < 5% minChangedArea)
  const frameA = Buffer.alloc(100, 50);
  for (let i = 0; i < 4; i++) frameA[i] = 100;
  const resA = detector.detect(frameA);
  assert.equal(resA.motion, false);
  assert.equal(resA.changedPixelCount, 4);
  assert.equal(resA.changedAreaPercent, 4.0);

  // Reset
  detector.reset();
  detector.detect(frame1);

  // Case B: 10 pixels changed by 40 (diff > 30, count 10 >= 5%)
  const frameB = Buffer.alloc(100, 50);
  for (let i = 0; i < 10; i++) frameB[i] = 100;
  const resB = detector.detect(frameB);
  assert.equal(resB.motion, true);
  assert.equal(resB.changedPixelCount, 10);
  assert.equal(resB.changedAreaPercent, 10.0);
});

test('FrameDifferenceDetector: Ignore regions correctly mask pixels', () => {
  // 10x10 frame. Mask top-left quadrant (x: 0..0.5, y: 0..0.5)
  const detector = new FrameDifferenceDetector({
    width: 10,
    height: 10,
    pixelThreshold: 20,
    minChangedArea: 1.0,
    ignoreRegions: [{ name: 'MaskedCorner', x: 0.0, y: 0.0, w: 0.49, h: 0.49 }]
  });

  const frame1 = Buffer.alloc(100, 50);
  detector.detect(frame1);

  // Change only top-left pixel (0, 0)
  const frame2 = Buffer.alloc(100, 50);
  frame2[0] = 200; // inside ignore region
  const res2 = detector.detect(frame2);
  assert.equal(res2.changedPixelCount, 0, 'Pixel inside ignore region must not be counted');

  // Change bottom-right pixel (9, 9)
  const frame3 = Buffer.alloc(100, 50);
  frame3[99] = 200; // outside ignore region
  const res3 = detector.detect(frame3);
  assert.equal(res3.changedPixelCount, 1, 'Pixel outside ignore region must be counted');
});

test('RunningAverageDetector: Adapts to gradual background lighting changes', () => {
  const detector = new RunningAverageDetector({
    width: 10,
    height: 10,
    pixelThreshold: 25,
    minChangedArea: 2.0,
    alpha: 0.2 // fast learning rate for test
  });

  const frame1 = Buffer.alloc(100, 50);
  detector.detect(frame1); // initializes background model

  // Frame with small gradual step (+10 difference, below threshold 25)
  const frameGradual = Buffer.alloc(100, 60);
  const resGradual = detector.detect(frameGradual);
  assert.equal(resGradual.motion, false);

  // Sudden large step (+80 difference across all pixels)
  const frameSudden = Buffer.alloc(100, 180);
  const resSudden = detector.detect(frameSudden);
  assert.equal(resSudden.motion, true);
  assert.equal(resSudden.changedPixelCount, 100);
});
