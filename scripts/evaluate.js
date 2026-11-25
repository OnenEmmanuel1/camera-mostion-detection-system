'use strict';

const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const { FileFrameSource } = require('../src/services/camera');
const PreprocessingService = require('../src/services/preprocessing');
const { createDetector } = require('../src/services/detector');
const EventManager = require('../src/services/eventManager');
const { generateSyntheticVideoAndLabels } = require('./makeTestVideo');

// Parse CLI flags
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    video: path.join(config.ROOT_DIR, 'evaluation', 'synthetic_test.mp4'),
    labels: path.join(config.ROOT_DIR, 'evaluation', 'synthetic_labels.csv'),
    method: 'frame_difference',
    threshold: 25,
    minArea: 0.50,
    persistence: 3,
    quietInterval: 3
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--video' && args[i + 1]) options.video = path.resolve(args[++i]);
    else if (args[i] === '--labels' && args[i + 1]) options.labels = path.resolve(args[++i]);
    else if (args[i] === '--method' && args[i + 1]) options.method = args[++i];
    else if (args[i] === '--threshold' && args[i + 1]) options.threshold = parseInt(args[++i], 10);
    else if (args[i] === '--minArea' && args[i + 1]) options.minArea = parseFloat(args[++i]);
    else if (args[i] === '--persistence' && args[i + 1]) options.persistence = parseInt(args[++i], 10);
    else if (args[i] === '--quietInterval' && args[i + 1]) options.quietInterval = parseInt(args[++i], 10);
  }

  return options;
}

function parseCsvLabels(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n');

  const intervals = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',').map(p => p.trim());
    if (parts.length >= 4) {
      intervals.push({
        intervalId: parseInt(parts[0], 10),
        startSec: parseFloat(parts[1]),
        endSec: parseFloat(parts[2]),
        type: parts[3],
        description: parts[4] || ''
      });
    }
  }
  return intervals;
}

async function runEvaluation() {
  const opts = parseArgs();

  if (!fs.existsSync(opts.video) || !fs.existsSync(opts.labels)) {
    console.log('[Evaluation] Benchmark video not found, generating synthetic test dataset...');
    generateSyntheticVideoAndLabels();
  }

  console.log('===============================================================');
  console.log(' ISSS EMPIRICAL EVALUATION TOOL (Section 5.9 / 5.11)');
  console.log(' Measures real detector output over labelled ground-truth test data');
  console.log('===============================================================');
  console.log(`Video File:       ${opts.video}`);
  console.log(`Labels File:      ${opts.labels}`);
  console.log(`Detector Method:  ${opts.method}`);
  console.log(`Pixel Threshold:  ${opts.threshold}`);
  console.log(`Min Changed Area: ${opts.minArea}%`);
  console.log(`Persistence:      ${opts.persistence} frames`);
  console.log(`Quiet Interval:   ${opts.quietInterval} s`);
  console.log('---------------------------------------------------------------');

  const groundTruth = parseCsvLabels(opts.labels);
  const trueMotionIntervals = groundTruth.filter(it => it.type === 'true_motion');

  const preprocessor = new PreprocessingService({ width: 320, height: 240, blurSigma: 0.5 });
  const detector = createDetector(opts.method, {
    width: 320,
    height: 240,
    pixelThreshold: opts.threshold,
    minChangedArea: opts.minArea
  });

  const baseTimestampMs = 1700000000000;
  const fps = 10;
  const frameSource = new FileFrameSource({
    filePath: opts.video,
    fps,
    baseTimestampMs,
    loop: false,
    realtime: false
  });

  const eventManager = new EventManager({
    persistenceFrames: opts.persistence,
    quietIntervalSeconds: opts.quietInterval,
    notificationCooldownSeconds: 0,
    detectionMode: 'camera_only'
  });

  const detectedEvents = [];

  eventManager.on('event:opened', (evt) => {
    const eventStartSec = (evt.startTimeMs - baseTimestampMs) / 1000;
    detectedEvents.push({
      eventId: evt.eventId,
      startSec: Number(eventStartSec.toFixed(2)),
      endSec: null,
      peakChangedArea: evt.peakChangedArea,
      startTimeIso: evt.startTime
    });
  });

  eventManager.on('event:closed', (evt) => {
    const last = detectedEvents.find(e => e.eventId === evt.eventId);
    if (last) {
      const eventEndSec = (new Date(evt.endTime).getTime() - baseTimestampMs) / 1000;
      last.endSec = Number(eventEndSec.toFixed(2));
      last.peakChangedArea = evt.peakChangedArea;
    }
  });

  // Strict sequential FIFO processing queue to prevent out-of-order execution
  const frameQueue = [];
  let sourceEnded = false;
  let processing = false;
  let totalFrames = 0;

  async function processQueue() {
    if (processing) return;
    processing = true;

    while (frameQueue.length > 0) {
      const frameObj = frameQueue.shift();
      totalFrames++;
      try {
        const { rawBuffer } = await preprocessor.process(frameObj.buffer);
        const detectionResult = detector.detect(rawBuffer);

        eventManager.processFrame({
          frameBuffer: frameObj.buffer,
          timestamp: frameObj.timestamp,
          timestampMs: frameObj.timestampMs,
          detectionResult,
          sensorActive: false,
          detectionMethod: opts.method
        });
      } catch (err) {
        console.error('[Evaluation] Error on frame', frameObj.frameNumber, err.message);
      }
    }

    processing = false;
  }

  frameSource.on('frame', (frameObj) => {
    frameQueue.push(frameObj);
    processQueue();
  });

  await new Promise((resolve) => {
    frameSource.on('ended', async () => {
      sourceEnded = true;
      // Wait for queue to empty completely
      while (frameQueue.length > 0 || processing) {
        await new Promise(r => setTimeout(r, 10));
      }
      eventManager.forceClose();
      resolve();
    });
    frameSource.start();
  });

  // Calculate metrics against ground truth
  let truePositives = 0;
  let falseNegatives = 0;
  const latencies = [];
  const matchedEventIds = new Set();

  for (const interval of trueMotionIntervals) {
    // Find matching detected event whose start falls around interval start
    const match = detectedEvents.find(evt => 
      evt.startSec >= (interval.startSec - 0.2) &&
      evt.startSec <= (interval.endSec + 1.0)
    );

    if (match) {
      truePositives++;
      matchedEventIds.add(match.eventId);
      const latencySec = Math.max(0, Number((match.startSec - interval.startSec).toFixed(2)));
      latencies.push(latencySec);
    } else {
      falseNegatives++;
    }
  }

  // False positives: detected events that do not correlate to any true motion
  let falsePositives = 0;
  for (const evt of detectedEvents) {
    if (!matchedEventIds.has(evt.eventId)) {
      falsePositives++;
    }
  }

  const precision = (truePositives + falsePositives) > 0 
    ? Number((truePositives / (truePositives + falsePositives)).toFixed(4))
    : 0;

  const recall = (truePositives + falseNegatives) > 0
    ? Number((truePositives / (truePositives + falseNegatives)).toFixed(4))
    : 0;

  const f1Score = (precision + recall) > 0
    ? Number((2 * (precision * recall) / (precision + recall)).toFixed(4))
    : 0;

  const meanLatencySec = latencies.length > 0
    ? Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(3))
    : 0;

  console.log('\n--- EVALUATION RESULTS ---');
  console.log(`Total Frames Processed:    ${totalFrames}`);
  console.log(`True Motion Intervals:     ${trueMotionIntervals.length}`);
  console.log(`Detected Events:           ${detectedEvents.length}`);
  console.log(`True Positives (TP):       ${truePositives}`);
  console.log(`False Positives (FP):      ${falsePositives}`);
  console.log(`False Negatives (FN):      ${falseNegatives}`);
  console.log(`Precision:                 ${(precision * 100).toFixed(1)}% (${precision})`);
  console.log(`Recall:                    ${(recall * 100).toFixed(1)}% (${recall})`);
  console.log(`F1 Score:                  ${(f1Score * 100).toFixed(1)}% (${f1Score})`);
  console.log(`Mean Detection Latency:    ${meanLatencySec} s`);
  console.log('---------------------------------------------------------------');

  // Save audit evaluation JSON artifact
  const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsFilename = `results-${timestampStr}.json`;
  const resultsPath = path.join(config.ROOT_DIR, 'evaluation', resultsFilename);

  const evaluationReport = {
    evaluatedAt: new Date().toISOString(),
    softwareVersion: config.SOFTWARE_VERSION,
    videoFile: opts.video,
    labelsFile: opts.labels,
    settings: {
      detectionMethod: opts.method,
      pixelThreshold: opts.threshold,
      minChangedAreaPercent: opts.minArea,
      persistenceFrames: opts.persistence,
      quietIntervalSeconds: opts.quietInterval,
      fps
    },
    metrics: {
      totalFrames,
      trueMotionIntervalCount: trueMotionIntervals.length,
      detectedEventCount: detectedEvents.length,
      truePositives,
      falsePositives,
      falseNegatives,
      precision,
      recall,
      f1Score,
      meanDetectionLatencySec: meanLatencySec,
      latenciesSec: latencies
    },
    groundTruthIntervals: groundTruth,
    detectedEvents
  };

  fs.writeFileSync(resultsPath, JSON.stringify(evaluationReport, null, 2), 'utf8');
  console.log(`Report written to: ${resultsPath}\n`);

  return evaluationReport;
}

if (require.main === module) {
  runEvaluation().catch((err) => {
    console.error('[Evaluation Error]:', err);
    process.exit(1);
  });
}

module.exports = { runEvaluation };
