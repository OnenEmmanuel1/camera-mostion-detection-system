'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const ConfigService = require('../src/services/config');
const { runMigrations } = require('../src/db/migrate');

test('ConfigService: Validates numbers and rejects out-of-range values', () => {
  const testDb = new Database(':memory:');
  runMigrations(testDb);
  const configService = new ConfigService(testDb);

  // pixel_threshold range 1-255
  const validThresh = configService.validate('pixel_threshold', 50);
  assert.equal(validThresh.valid, true);
  assert.equal(validThresh.value, '50');

  const invalidThreshLow = configService.validate('pixel_threshold', 0);
  assert.equal(invalidThreshLow.valid, false);

  const invalidThreshHigh = configService.validate('pixel_threshold', 300);
  assert.equal(invalidThreshHigh.valid, false);

  // retention_days range 1-365
  const validRetention = configService.validate('retention_days', 30);
  assert.equal(validRetention.valid, true);

  const invalidRetention = configService.validate('retention_days', -5);
  assert.equal(invalidRetention.valid, false);

  // min_changed_area float range 0.01 - 50.0
  const validArea = configService.validate('min_changed_area', 1.25);
  assert.equal(validArea.valid, true);

  const invalidArea = configService.validate('min_changed_area', 75.0);
  assert.equal(invalidArea.valid, false);
});

test('ConfigService: Rejects malicious shell characters and path traversal', () => {
  const testDb = new Database(':memory:');
  runMigrations(testDb);
  const configService = new ConfigService(testDb);

  const injectionAttempt = configService.validate('detection_method', 'frame_difference; rm -rf /');
  assert.equal(injectionAttempt.valid, false);

  const pathAttempt = configService.validate('detection_method', '../sensitive.txt');
  assert.equal(pathAttempt.valid, false);
});

test('ConfigService: Validates ignore regions JSON schema', () => {
  const testDb = new Database(':memory:');
  runMigrations(testDb);
  const configService = new ConfigService(testDb);

  // Valid rectangles
  const validRegions = JSON.stringify([{ name: 'Fan', x: 0.1, y: 0.1, w: 0.3, h: 0.3 }]);
  assert.equal(configService.validate('ignore_regions', validRegions).valid, true);

  // Invalid: missing coordinates
  const invalidRegions = JSON.stringify([{ name: 'Bad' }]);
  assert.equal(configService.validate('ignore_regions', invalidRegions).valid, false);

  // Invalid: coordinate exceeding bounds (> 1.0)
  const outOfBounds = JSON.stringify([{ x: 0.8, y: 0.8, w: 0.5, h: 0.5 }]); // x+w = 1.3 > 1.0
  assert.equal(configService.validate('ignore_regions', outOfBounds).valid, false);
});
