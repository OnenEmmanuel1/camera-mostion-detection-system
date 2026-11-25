'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getFfmpegPath } = require('../src/services/camera');
const { config } = require('../src/config');

function generateSyntheticVideoAndLabels() {
  const evalDir = path.resolve(config.ROOT_DIR, 'evaluation');
  if (!fs.existsSync(evalDir)) {
    fs.mkdirSync(evalDir, { recursive: true });
  }

  const videoPath = path.join(evalDir, 'synthetic_test.mp4');
  const labelsPath = path.join(evalDir, 'synthetic_labels.csv');

  console.log('[MakeTestVideo] Generating synthetic benchmark video...');
  console.log(`[MakeTestVideo] Target Video: ${videoPath}`);
  console.log(`[MakeTestVideo] Target Labels: ${labelsPath}`);

  // FFmpeg filter chain creating:
  // - 30 seconds total at 10 fps (300 frames)
  // - 0.0s to 5.0s: Static dark background
  // - 5.0s to 10.0s: Motion 1: moving 100x100 white box left to right (x = 50 + (t-5)*90, y = 160)
  // - 10.0s to 15.0s: Static scene with subtle lighting flicker distractor at t=11-13s
  // - 15.0s to 22.0s: Motion 2: moving 100x100 white box right to left (x = 560 - (t-15)*80, y = 180)
  // - 22.0s to 30.0s: Static background
  const ffmpegPath = getFfmpegPath();
  const filterExpr = "[0:v][1:v]overlay=x='if(between(t,5,10), 50+(t-5)*90, if(between(t,15,22), 560-(t-15)*80, -250))':y='if(between(t,5,10), 160, if(between(t,15,22), 180, -250))':eval=frame,eq=brightness='if(between(t,11,13), 0.04, 0)'";

  const args = [
    '-f', 'lavfi', '-i', 'color=c=0x1a1a1a:s=640x480:d=30:r=10',
    '-f', 'lavfi', '-i', 'color=c=white:s=100x100:d=30:r=10',
    '-filter_complex', filterExpr,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'ultrafast',
    '-y',
    videoPath
  ];

  const result = spawnSync(ffmpegPath, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error('[MakeTestVideo] FFmpeg failed to generate video:', result.error || `Exit code ${result.status}`);
    process.exit(1);
  }

  // Generate ground truth CSV labels
  const labelsCsv = [
    'interval_id,start_time_sec,end_time_sec,type,description',
    '1,5.0,10.0,true_motion,Moving 100x100 target box left to right',
    '2,11.0,13.0,distractor,Subtle ambient lighting flicker distractor',
    '3,15.0,22.0,true_motion,Moving 100x100 target box right to left'
  ].join('\n') + '\n';

  fs.writeFileSync(labelsPath, labelsCsv, 'utf8');

  console.log('[MakeTestVideo] Synthetic benchmark dataset created successfully!');
  return { videoPath, labelsPath };
}

if (require.main === module) {
  generateSyntheticVideoAndLabels();
}

module.exports = { generateSyntheticVideoAndLabels };
