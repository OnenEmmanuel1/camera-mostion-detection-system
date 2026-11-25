'use strict';

const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config();

const ROOT_DIR = path.resolve(__dirname, '..', '..');

const appEnv = process.env.APP_ENV || 'demo';

// Enforce environment-only secrets in production
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (appEnv === 'production') {
    throw new Error('FATAL: SESSION_SECRET environment variable must be set in production.');
  }
  sessionSecret = crypto.randomBytes(32).toString('hex');
}

let deviceApiKey = process.env.DEVICE_API_KEY;
if (!deviceApiKey) {
  if (appEnv === 'production') {
    throw new Error('FATAL: DEVICE_API_KEY environment variable must be set in production.');
  }
  deviceApiKey = crypto.randomBytes(32).toString('hex');
}

const config = {
  APP_ENV: appEnv,
  PORT: parseInt(process.env.PORT, 10) || 3000,
  HOST: process.env.HOST || '0.0.0.0',
  SESSION_SECRET: sessionSecret,
  DATABASE_PATH: process.env.DATABASE_PATH 
    ? path.resolve(process.env.DATABASE_PATH)
    : path.join(ROOT_DIR, 'data', 'isss.sqlite'),
  MEDIA_ROOT: process.env.MEDIA_ROOT
    ? path.resolve(process.env.MEDIA_ROOT)
    : path.join(ROOT_DIR, 'media'),
  CAMERA_TYPE: process.env.CAMERA_TYPE || 'file', // 'file', 'usb', 'url'
  CAMERA_PATH: process.env.CAMERA_PATH || path.join(ROOT_DIR, 'evaluation', 'synthetic_test.mp4'),
  FFMPEG_PATH: process.env.FFMPEG_PATH || null,
  DEVICE_NAME: process.env.DEVICE_NAME || 'ISSS-Edge-Node-01',
  DEVICE_LOCATION: process.env.DEVICE_LOCATION || 'Main Entrance',
  DEVICE_API_KEY: deviceApiKey,
  PUBLIC_APP_URL: (process.env.PUBLIC_APP_URL || `http://${process.env.HOST && process.env.HOST !== '0.0.0.0' ? process.env.HOST : 'localhost'}:${parseInt(process.env.PORT, 10) || 3000}`).replace(/\/$/, ''),
  DISPLAY_TZ: process.env.DISPLAY_TZ || 'UTC',
  SOFTWARE_VERSION: '1.0.0',

  // Email notifications
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInt(process.env.SMTP_PORT, 10) || 587,
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  NOTIFY_EMAIL_FROM: process.env.NOTIFY_EMAIL_FROM || '',
  NOTIFY_EMAIL_TO: process.env.NOTIFY_EMAIL_TO || '',

  // Telegram notifications
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',

  // Opt-in image attachment in alerts (default false per Section 5.8)
  NOTIFY_ATTACH_IMAGE: process.env.NOTIFY_ATTACH_IMAGE === 'true',

  // Directory constants
  ROOT_DIR,
  STILLS_DIR: path.join(process.env.MEDIA_ROOT ? path.resolve(process.env.MEDIA_ROOT) : path.join(ROOT_DIR, 'media'), 'stills'),
  CLIPS_DIR: path.join(process.env.MEDIA_ROOT ? path.resolve(process.env.MEDIA_ROOT) : path.join(ROOT_DIR, 'media'), 'clips'),
  EVALUATION_DIR: path.join(ROOT_DIR, 'evaluation')
};

// Settings schema defining validation rules, labels, descriptions, and whether changes take effect live
const SETTINGS_METADATA = {
  detection_enabled: {
    type: 'boolean',
    default: '1',
    label: 'Detection Loop Active',
    description: 'Master switch to enable or disable motion analysis processing.',
    appliesLive: true
  },
  detection_method: {
    type: 'enum',
    options: ['frame_difference', 'running_average'],
    default: 'frame_difference',
    label: 'Detection Method',
    description: 'frame_difference compares consecutive frames; running_average uses an exponentially smoothed background model to adapt to gradual light changes.',
    appliesLive: true
  },
  detection_mode: {
    type: 'enum',
    options: ['camera_only', 'camera_and_pir', 'camera_or_pir', 'pir_only'],
    default: 'camera_only',
    label: 'Sensor Fusion Mode',
    description: 'camera_only ignores PIR input; camera_and_pir requires both camera and PIR sensor to agree; camera_or_pir triggers if either fires; pir_only uses PIR sensor exclusively.',
    appliesLive: true
  },
  pixel_threshold: {
    type: 'integer',
    min: 1,
    max: 255,
    default: '25',
    label: 'Per-Pixel Difference Threshold (1-255)',
    description: 'Minimum grayscale difference (0-255) for a pixel to count as changed. Lower values make the detector more sensitive to slight luminance shifts; higher values filter subtle shadows.',
    appliesLive: true
  },
  min_changed_area: {
    type: 'float',
    min: 0.01,
    max: 50.0,
    default: '0.50',
    label: 'Minimum Changed Area (%) (0.01 - 50.0%)',
    description: 'Percentage of the active (non-ignored) frame area that must change to qualify as motion. Increase to ignore small pets or distant leaves.',
    appliesLive: true
  },
  persistence_frames: {
    type: 'integer',
    min: 1,
    max: 30,
    default: '3',
    label: 'Persistence Frames (1-30)',
    description: 'Number of consecutive motion frames required before an event opens. Filters brief sensor noise, bugs flying past, or single-frame flickers.',
    appliesLive: true
  },
  quiet_interval_seconds: {
    type: 'integer',
    min: 1,
    max: 300,
    default: '5',
    label: 'Event Quiet Interval (seconds) (1-300)',
    description: 'Number of seconds the scene must remain continuously quiet before the active event is considered finished and closed.',
    appliesLive: true
  },
  notification_cooldown_seconds: {
    type: 'integer',
    min: 0,
    max: 3600,
    default: '60',
    label: 'Notification Cooldown (seconds) (0-3600)',
    description: 'Minimum delay between notifications sent to external channels. Events are still fully recorded in the database even when notifications are in cooldown.',
    appliesLive: true
  },
  detection_fps: {
    type: 'integer',
    min: 1,
    max: 15,
    default: '5',
    label: 'Detection Frame Rate (FPS) (1-15)',
    description: 'Internal processing frame rate. Recommended 3-5 fps on edge devices (like Raspberry Pi) to keep CPU load minimal while preserving motion tracking fidelity.',
    appliesLive: false // worker adjusts loop interval on restart or next frame schedule
  },
  recording_enabled: {
    type: 'boolean',
    default: '1',
    label: 'Media Recording Enabled',
    description: 'When disabled, events are logged in the database without capturing any still images or video clips to disk.',
    appliesLive: true
  },
  clips_enabled: {
    type: 'boolean',
    default: '0',
    label: 'Video Clip Recording',
    description: 'When enabled, records short MP4 video clips covering pre-roll buffer and post-roll period. Stills are always captured regardless of this setting.',
    appliesLive: true
  },
  clip_pre_roll_seconds: {
    type: 'integer',
    min: 1,
    max: 10,
    default: '3',
    label: 'Clip Pre-Roll Buffer (seconds) (1-10)',
    description: 'Seconds of footage retained before the event trigger to capture what led up to the motion.',
    appliesLive: true
  },
  clip_post_roll_seconds: {
    type: 'integer',
    min: 1,
    max: 20,
    default: '5',
    label: 'Clip Post-Roll Duration (seconds) (1-20)',
    description: 'Seconds of footage recorded after motion stops before finalizing the clip (total pre+post roll max 30s).',
    appliesLive: true
  },
  retention_days: {
    type: 'integer',
    min: 1,
    max: 365,
    default: '14',
    label: 'Storage Retention Period (days) (1-365)',
    description: 'Number of days to keep event records and associated media before automated cleanup purges them. Must be a positive integer.',
    appliesLive: true
  },
  low_storage_threshold_percent: {
    type: 'integer',
    min: 1,
    max: 50,
    default: '10',
    label: 'Low Storage Threshold (%) (1-50%)',
    description: 'Free disk space percentage below which the system suspends saving media files to prevent disk exhaustion. Events are still logged.',
    appliesLive: true
  },
  live_view_enabled: {
    type: 'boolean',
    default: '1',
    label: 'Live View Stream Enabled',
    description: 'Enables MJPEG live streaming via authenticated route.',
    appliesLive: true
  },
  live_view_viewer_access: {
    type: 'boolean',
    default: '1',
    label: 'Allow Viewers Live Access',
    description: 'If disabled, only Administrators can access the live video stream; Viewers are restricted to past reviewed events.',
    appliesLive: true
  },
  ignore_regions: {
    type: 'json_regions',
    default: '[]',
    label: 'Ignore Regions (JSON)',
    description: 'Array of rectangular bounding boxes { x: 0..1, y: 0..1, w: 0..1, h: 0..1, name: string } excluded from motion calculation (e.g. oscillating fan or trees).',
    appliesLive: true
  }
};

module.exports = {
  config,
  SETTINGS_METADATA
};
