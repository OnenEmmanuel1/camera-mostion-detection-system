'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventManager = require('../src/services/eventManager');

test('EventManager: Persistence requires N consecutive motion frames', () => {
  const em = new EventManager({
    persistenceFrames: 3,
    quietIntervalSeconds: 2,
    detectionMode: 'camera_only'
  });

  const openedEvents = [];
  em.on('event:opened', (e) => openedEvents.push(e));

  const dummyJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
  const baseTime = 1000000;

  // Frame 1: Motion = true (consecutive = 1 < 3)
  em.processFrame({
    frameBuffer: dummyJpeg,
    timestamp: '2026-01-01T00:00:01.000Z',
    timestampMs: baseTime + 1000,
    detectionResult: { motion: true, changedAreaPercent: 2.5 }
  });
  assert.equal(openedEvents.length, 0);

  // Frame 2: Motion = false (glitch/noise, resets consecutive to 0)
  em.processFrame({
    frameBuffer: dummyJpeg,
    timestamp: '2026-01-01T00:00:02.000Z',
    timestampMs: baseTime + 2000,
    detectionResult: { motion: false, changedAreaPercent: 0 }
  });
  assert.equal(openedEvents.length, 0);

  // Frame 3: Motion = true (consecutive = 1)
  em.processFrame({
    frameBuffer: dummyJpeg,
    timestamp: '2026-01-01T00:00:03.000Z',
    timestampMs: baseTime + 3000,
    detectionResult: { motion: true, changedAreaPercent: 3.0 }
  });
  assert.equal(openedEvents.length, 0);

  // Frame 4: Motion = true (consecutive = 2)
  em.processFrame({
    frameBuffer: dummyJpeg,
    timestamp: '2026-01-01T00:00:04.000Z',
    timestampMs: baseTime + 4000,
    detectionResult: { motion: true, changedAreaPercent: 3.5 }
  });
  assert.equal(openedEvents.length, 0);

  // Frame 5: Motion = true (consecutive = 3 -> Qualifies!)
  em.processFrame({
    frameBuffer: dummyJpeg,
    timestamp: '2026-01-01T00:00:05.000Z',
    timestampMs: baseTime + 5000,
    detectionResult: { motion: true, changedAreaPercent: 4.0 }
  });
  assert.equal(openedEvents.length, 1);
  assert.equal(openedEvents[0].startTime, '2026-01-01T00:00:05.000Z');
  assert.equal(openedEvents[0].peakChangedArea, 4.0);
});

test('EventManager: Quiet interval closes active event', () => {
  const em = new EventManager({
    persistenceFrames: 1,
    quietIntervalSeconds: 3,
    detectionMode: 'camera_only'
  });

  const closedEvents = [];
  em.on('event:closed', (e) => closedEvents.push(e));

  const dummyJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
  const baseTime = 1000000;

  // Open event at t = 1s
  em.processFrame({
    frameBuffer: dummyJpeg,
    timestamp: '2026-01-01T00:00:01.000Z',
    timestampMs: baseTime + 1000,
    detectionResult: { motion: true, changedAreaPercent: 5.0 }
  });
  assert.ok(em.activeEvent);

  // Quiet at t = 2s (quiet starts: 0 elapsed quiet seconds < 3s quiet interval)
  em.processFrame({
    frameBuffer: dummyJpeg,
    timestamp: '2026-01-01T00:00:02.000Z',
    timestampMs: baseTime + 2000,
    detectionResult: { motion: false, changedAreaPercent: 0 }
  });
  assert.equal(closedEvents.length, 0);
  assert.ok(em.activeEvent);

  // Quiet at t = 5s (3s quiet elapsed >= 3s quiet interval -> Event Closes!)
  em.processFrame({
    frameBuffer: dummyJpeg,
    timestamp: '2026-01-01T00:00:05.000Z',
    timestampMs: baseTime + 5000,
    detectionResult: { motion: false, changedAreaPercent: 0 }
  });

  assert.equal(closedEvents.length, 1);
  assert.equal(closedEvents[0].endTime, '2026-01-01T00:00:05.000Z');
  assert.equal(em.activeEvent, null);
});

test('EventManager: Sensor fusion modes work as specified', () => {
  const em = new EventManager({ persistenceFrames: 1 });

  // Mode: camera_and_pir
  em.setOptions({ detectionMode: 'camera_and_pir' });
  assert.equal(em.evaluateFusion(true, false), false);
  assert.equal(em.evaluateFusion(false, true), false);
  assert.equal(em.evaluateFusion(true, true), true);

  // Mode: camera_or_pir
  em.setOptions({ detectionMode: 'camera_or_pir' });
  assert.equal(em.evaluateFusion(true, false), true);
  assert.equal(em.evaluateFusion(false, true), true);
  assert.equal(em.evaluateFusion(false, false), false);

  // Mode: pir_only
  em.setOptions({ detectionMode: 'pir_only' });
  assert.equal(em.evaluateFusion(true, false), false);
  assert.equal(em.evaluateFusion(false, true), true);
});
