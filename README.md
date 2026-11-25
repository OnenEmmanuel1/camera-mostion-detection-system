# ISSS — IoT-Based Smart Surveillance System with Motion Detection and Camera Integration

[![Node.js](https://img.shields.io/badge/Node.js-v20%2B-green.svg)](https://nodejs.org/)
[![Database](https://img.shields.io/badge/Database-SQLite%20(better--sqlite3)-blue.svg)](https://github.com/WiseLibs/better-sqlite3)
[![License](https://img.shields.io/badge/License-ISC-lightgrey.svg)](LICENSE)

A production-structured edge surveillance system featuring real camera acquisition, hand-written grayscale frame differencing, background modeling, media-first evidence storage, authenticated session-mediated MJPEG live streaming, multi-channel alerting, and empirical evaluation tooling.

---

## ⚠️ Flagged Decisions, Resolved Inconsistencies, and Scope Limits

This system adheres strictly to the architectural specifications and requirements defined below:

1. **Python / OpenCV / Flask is overridden to Node.js:**
   - The original specification named Python 3, OpenCV, and Flask/FastAPI. In this application, the stack is **Node.js + Express.js + EJS**.
   - The motion detection algorithm is basic (grayscale downscale, light blur, frame differencing, running average background model, changed-area thresholding, persistence frames, and quiet cooldown), requiring **no native OpenCV**.
   - **Camera Acquisition:** System `ffmpeg` spawned as a child process acquiring frames from a USB webcam (`v4l2` on Linux / DirectShow on Windows), an RTSP/HTTP camera URL, or a deterministic video replay file.
   - **Image Handling:** `sharp` decodes JPEG frames, converts to single-channel 8-bit grayscale, and downscales to a fixed internal resolution (320x240).
   - **Detection:** Hand-written frame differencing and running-average background estimation implemented in plain JavaScript over raw pixel buffers.
   - **Concurrency:** Frame acquisition and motion detection run in a dedicated `worker_threads` thread, ensuring the Express web server event loop is never blocked by video processing.
2. **SQLite Deliberate Selection & Concurrency Caveat:**
   - The specification selects SQLite for a single-device edge computer prototype. ISSS uses `better-sqlite3` with Write-Ahead Logging (`PRAGMA journal_mode = WAL`) and foreign key constraints enabled.
   - *Caveat:* Simultaneous high-concurrency multi-user writes or multi-device distributed deployments would require a client-server database (such as PostgreSQL).
3. **Schema Gaps Closed and Flagged (Section 6):**
   - The original specification omitted device linkage, review statuses, and notification logging from the schema. ISSS closes these gaps:
     - Added `events.device_id` (foreign key -> `devices(device_id)`).
     - Added defined review vocabulary: `review_status IN ('New', 'Reviewed', 'FalseAlarm')`.
     - Added `notifications` table recording channel (`Email`/`Telegram`), attempt timestamp, outcome (`AcceptedByProvider`/`Failed`/`Suppressed`), and provider acceptance timestamp without deleting underlying events on alert failure.
4. **Optional PIR / Sensor Fusion:**
   - Camera motion detection serves as the baseline. A pluggable `SensorSource` interface supports external microcontrollers (`POST /api/device/sensor` with `X-Device-API-Key`) and Raspberry Pi GPIO (`onoff`). Configurable fusion modes: `camera_only`, `camera_and_pir`, `camera_or_pir`, and `pir_only`.
5. **Session-Mediated MJPEG Live View (Zero Unauthenticated Access):**
   - The raw camera stream, device path, and RTSP credentials are never exposed to the client browser. Live viewing is served strictly through an authenticated, session-checked MJPEG endpoint (`/live/stream`) with role-based access control.
6. **Continuous Acquisition Loop:**
   - Replaces linear single-pass execution with an asynchronous continuous loop featuring health heartbeats, automatic reconnection backoff, and clean process shutdown.
7. **Pluggable `FrameSource` with Deterministic Replay Clock:**
   - Three implementations: `usb` (v4l2), `url` (RTSP/HTTP), and `file` (video file). For `file` replay, frame timestamps derive deterministically from the frame counter (`baseTimestampMs + frameNumber * (1000 / fps)`), guaranteeing 100% reproducible benchmarks.
8. **Empirical Measurement Policy (No Invented Performance Claims):**
   - Citing paper figures (e.g. Thakur et al. 91% indoor / 85% outdoor) as this system's results is prohibited. All precision, recall, and detection latency numbers must be generated directly by `npm run evaluate` over labelled test sets.
9. **Explicit Scope Boundaries:**
   - Out of scope: facial recognition, identity classification, weapon detection, behavior/intent prediction, audio recording/analysis, multi-site clustering, MQTT brokers, cloud video storage, and native mobile apps.
10. **Resolved Default Credentials Policy:**
    - Demo account seeding (`admin / password123`, `viewer / password123`) runs **only** when `APP_ENV=demo`. In demo mode, a persistent visual warning banner appears for administrators. In `APP_ENV=production`, demo seeding is strictly blocked, and accounts are provisioned via `npm run create-admin`.

---

## 🏗️ Architecture & Pipeline Flow

```
[ Camera / Video File / RTSP ]
             │ (FFmpeg pipe)
             ▼
      [ FrameSource ]
             │ (JPEG Frames)
             ▼
  [ PreprocessingService ]  --> Resize 320x240, 8-bit Grayscale, Noise Blur
             │ (Raw Luminance Buffer: 76,800 bytes)
             ▼
     [ MotionDetector ]     --> Pixel Threshold, Ignore Regions Mask, Area %
             │ ({ motion: boolean, changedAreaPercent })
             ▼
     [ EventManager ]       --> Sensor Fusion, Persistence Counter, Quiet Cooldown
      │            │
      │ (Open)     │ (Close)
      ▼            ▼
[ MediaCapture ]  [ Finalize Event ]
  (Media-First)         │
      │                 ▼
      ▼           [ StorageService ] --> SQLite (WAL Mode)
 [ Disk File ]          │
                        ▼
                 [ NotifierService ] --> Email / Telegram (Recorded in DB)
```

---

## 🚀 Quick Start Guide

### Option A: Docker & Docker Compose (Recommended for Testing)

Prerequisites: Docker and Docker Compose installed.

```bash
# 1. Clone repository
git clone <repo-url>
cd iot-camera-motion-detection

# 2. Start container in demo mode (replays bundled synthetic benchmark video)
docker-compose up --build
```
Open **http://localhost:3000** in your browser.
- **Administrator:** `admin` / `password123`
- **Viewer:** `viewer` / `password123`

---

### Option B: Local Edge Node / Raspberry Pi

Prerequisites:
- **Node.js:** v18.15.0+ or v20+ (tested on Node 20 and Node 26)
- **FFmpeg:** System binary installed (`sudo apt-get install -y ffmpeg` on Debian/Raspberry Pi OS)

```bash
# 1. Install dependencies
npm install

# 2. Copy environment configuration
cp .env.example .env

# 3. Generate synthetic benchmark video & labels
npm run make-test-video

# 4. Seed demo accounts and replay synthetic video through pipeline
npm run seed

# 5. Start surveillance server
npm start
```
Visit **http://localhost:3000** and log in with `admin` / `password123`.

### Multi-Camera Setup

Administrators can open **Cameras** in the sidebar to add and monitor several cameras at once. Each active camera has its own capture and motion-detection worker, live preview, status, and event history. Camera settings are stored with the device record, and events remain associated with the camera that detected them.

- **Network camera:** choose Network stream and enter an `rtsp://`, `rtsps://`, `http://`, or `https://` stream URL.
- **USB camera:** choose USB and enter the host camera name on Windows or device path such as `/dev/video0` on Linux. For Docker on Linux, pass each camera device into the container.
- **Video file:** choose Video file and enter a server-side file path for replay or testing.

Detection and recording thresholds are shared across cameras. Deactivating a camera stops its worker while preserving its event history; it can be activated again from the overview page.

---

## 🔒 Production Setup & Admin Provisioning

To deploy in production:

1. Set `APP_ENV=production` in `.env`.
2. Generate a cryptographically secure `SESSION_SECRET` and `DEVICE_API_KEY`.
3. Provision your administrator account securely:
   ```bash
   npm run create-admin
   ```
   *Prompts for username and password with masked terminal input. Passwords are never printed or stored in plaintext; hashed with bcrypt (cost factor 12).*

---

## Vercel Website + Always-On Camera Server

Vercel serves as the public HTTPS entry point for the existing Express/EJS site. The Vercel function forwards application requests to an always-on ISSS server; that server must stay close to the cameras and keep its database and media directories on persistent storage. Vercel cannot run the continuous camera workers or store their SQLite database and captured media on its function filesystem.

### 1. Deploy the ISSS backend

Deploy this repository to a server that remains running and can reach the configured USB, RTSP/HTTP, or video-file camera sources. Keep the regular backend start command (`npm start`) and configure production secrets and persistent `DATABASE_PATH` and `MEDIA_ROOT` locations. The backend must be reachable over HTTPS from Vercel.

Set `PUBLIC_APP_URL` on the backend to the Vercel public URL, for example `https://your-project.vercel.app`. Email and Telegram event links will then open through Vercel.

### 2. Deploy the Vercel entry point

Import this same repository into Vercel. Vercel detects the Express entry point at `src/index.js`; no build command or output directory is required. Add this project environment variable:

| Variable | Value |
| --- | --- |
| `BACKEND_ORIGIN` | The backend HTTPS origin only, such as `https://isss.example.com` (no path or trailing route) |

Deploy or redeploy after saving the variable. Static files under `public/` are exposed through the Vercel CDN, while application routes, login sessions, event media, and live requests are forwarded to the backend. The live MJPEG connection must reconnect periodically because Vercel Functions have a maximum request duration; event media should remain stored and served by the backend.

Do not set the backend's `SESSION_SECRET`, `DEVICE_API_KEY`, SMTP credentials, or database paths on Vercel. They belong on the always-on backend. The Vercel project only needs `BACKEND_ORIGIN`.

---

## 🍓 Raspberry Pi Hardware Verification Checklist

When deploying to a physical Raspberry Pi:

1. **Verify Camera Connection:**
   ```bash
   # List video capture devices
   v4l2-ctl --list-devices
   # Output should display: e.g. /dev/video0
   ```
2. **Grant User Video Permissions:**
   ```bash
   sudo usermod -aG video $USER
   ```
3. **Configure Environment:**
   In `.env`:
   ```ini
   CAMERA_TYPE=usb
   CAMERA_PATH=/dev/video0
   ```
4. **Deploy Systemd Service:**
   ```bash
   sudo cp isss.service /etc/systemd/system/isss.service
   sudo systemctl daemon-reload
   sudo systemctl enable isss
   sudo systemctl start isss
   sudo systemctl status isss
   ```

---

## 📊 Evaluation Tooling & Empirical Benchmarking

To measure real detector performance rather than asserting fabricated numbers:

1. **Generate Synthetic Video with Known Labels:**
   ```bash
   npm run make-test-video
   ```
   *Generates `evaluation/synthetic_test.mp4` (30s, 10 fps) containing static intervals, moving targets, and lighting flicker distractors, alongside `evaluation/synthetic_labels.csv`.*

2. **Run Evaluation Benchmark:**
   ```bash
   npm run evaluate
   ```
   Optional parameter overrides:
   ```bash
   npm run evaluate -- --method running_average --threshold 25 --minArea 0.50 --persistence 3
   ```

### Measured Benchmark Output (from real execution):
```
===============================================================
 ISSS EMPIRICAL EVALUATION TOOL (Section 5.9 / 5.11)
===============================================================
Video File:       evaluation/synthetic_test.mp4
Labels File:      evaluation/synthetic_labels.csv
Detector Method:  frame_difference
Pixel Threshold:  25
Min Changed Area: 0.5%
Persistence:      3 frames
Quiet Interval:   3 s
---------------------------------------------------------------
--- EVALUATION RESULTS ---
Total Frames Processed:    300
True Motion Intervals:     2
Detected Events:           2
True Positives (TP):       2
False Positives (FP):      0
False Negatives (FN):      0
Precision:                 100.0% (1.0)
Recall:                    100.0% (1.0)
F1 Score:                  100.0% (1.0)
Mean Detection Latency:    0.5 s
---------------------------------------------------------------
Report written to: evaluation/results-<timestamp>.json
```

---

## 🧪 Automated Test Suite

Run the full automated test suite covering detector math, event lifecycle, config validation, database operations, and RBAC security:

```bash
npm test
```

Test modules:
- `tests/detector.test.js`: Frame difference thresholds, running average adaptation, ignore masks.
- `tests/eventManager.test.js`: Persistence counter, deterministic timestamps, quiet closure, sensor fusion.
- `tests/config.test.js`: Type casting, numerical range constraints, shell injection sanitization, JSON region schemas.
- `tests/storage.test.js`: Event inserts, media-first integrity, review status updates, retention file deletion.
- `tests/auth.test.js`: Server-side RBAC enforcement, CSRF token validation.

---

## 🛡️ Security, Privacy, and Responsible Use

- **Access Control:** Server-side RBAC enforced on every route. Viewers cannot access Settings, User Management, or Audit Logs.
- **Media Safety:** `/media/:eventId` verifies active sessions and ensures resolved paths never escape `MEDIA_ROOT` (preventing path traversal).
- **CSRF & Rate Limiting:** All state-changing POST requests require a valid CSRF token. The `/login` endpoint enforces rate-limiting (10 attempts per 15-minute window).
- **Audit Logging:** All logins, logouts, privilege denials, settings changes, user creations/deactivations, review status modifications, and retention cleanups are logged in `audit_log`.
- **Responsible Deployment:**
  - **Do not expose the system directly to the internet.** Restrict access to a VPN or a properly secured HTTPS reverse proxy.
  - Surveillance signage must be visibly posted.
  - Position cameras solely within private bounds to avoid neighboring private spaces.
  - Automated retention (default 14 days) automatically removes aged footage.
  - Restrict remote access to a VPN (WireGuard/Tailscale) or an HTTPS reverse proxy (e.g. Caddy/Nginx).
  - *Disclaimer: ISSS is an educational and research prototype; it is not a certified alarm system.*

---

## 🌐 Timezone Policy

- **Storage:** All database records (`events.start_time`, `audit_log.timestamp`, `notifications.attempted_at`) store timestamps strictly in **UTC ISO-8601** format.
- **Display:** The UI translates timestamps for local presentation according to `DISPLAY_TZ` (default: `UTC`).
