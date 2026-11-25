/**
 * ISSS Client UI Script
 * Handles real-time telemetry updates and stream reconnection
 */
document.addEventListener('DOMContentLoaded', () => {
  // Browser camera is an opt-in test source. Frames go through the same worker,
  // motion detector, event store, and clip recorder as the configured camera.
  const cameraToggle = document.getElementById('isss-camera-toggle');
  const browserVideo = document.getElementById('isss-browser-camera');
  const browserCanvas = document.getElementById('isss-browser-camera-canvas');
  const cameraTestStatus = document.getElementById('isss-camera-test-status');
  const previewImage = document.querySelector('#isss-camera-preview > img');
  const previewEmpty = document.getElementById('isss-preview-empty');

  if (cameraToggle && browserVideo && browserCanvas) {
    let cameraStream = null;
    let captureTimer = null;
    let sending = false;
    const csrfToken = cameraToggle.dataset.csrfToken;
    const deviceId = Number(cameraToggle.dataset.deviceId) || 1;

    async function postCamera(payload, keepalive = false) {
      return fetch('/api/stream/browser-camera', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ ...payload, device_id: deviceId })
      });
    }

    async function sendFrame() {
      if (!cameraStream || sending || browserVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      sending = true;
      try {
        const width = Math.min(browserVideo.videoWidth, 640);
        const height = Math.round(browserVideo.videoHeight * (width / browserVideo.videoWidth));
        browserCanvas.width = width;
        browserCanvas.height = height;
        browserCanvas.getContext('2d', { willReadFrequently: true }).drawImage(browserVideo, 0, 0, width, height);
        const jpeg = browserCanvas.toDataURL('image/jpeg', 0.68);
        const response = await postCamera({ frame: jpeg });
        if (!response.ok) throw new Error((await response.json()).error || 'Frame upload failed');
      } catch (error) {
        if (cameraStream) cameraTestStatus.textContent = error.message;
      } finally {
        sending = false;
      }
    }

    async function stopBrowserCamera(notifyServer = true) {
      if (captureTimer) clearInterval(captureTimer);
      captureTimer = null;
      if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
      cameraStream = null;
      browserVideo.srcObject = null;
      browserVideo.hidden = true;
      if (previewImage) previewImage.hidden = false;
      if (previewEmpty) previewEmpty.hidden = true;
      cameraToggle.textContent = 'Use this device camera';
      cameraToggle.dataset.active = 'false';
      cameraTestStatus.textContent = 'Server camera feed';
      if (notifyServer) {
        try { await postCamera({ action: 'stop' }); } catch (error) { /* server may already be closing */ }
      }
    }

    cameraToggle.addEventListener('click', async () => {
      if (cameraStream) {
        await stopBrowserCamera();
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        cameraTestStatus.textContent = 'Camera needs localhost or HTTPS';
        return;
      }
      cameraToggle.disabled = true;
      cameraTestStatus.textContent = 'Requesting camera permission…';
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        browserVideo.srcObject = cameraStream;
        await browserVideo.play();
        const response = await postCamera({ action: 'start' });
        if (!response.ok) throw new Error((await response.json()).error || 'Could not start camera test');
        if (previewImage) previewImage.hidden = true;
        if (previewEmpty) previewEmpty.hidden = true;
        browserVideo.hidden = false;
        cameraToggle.textContent = 'Stop device camera';
        cameraToggle.dataset.active = 'true';
        cameraTestStatus.textContent = 'Camera test active · motion detection on';
        captureTimer = setInterval(sendFrame, 200);
        sendFrame();
      } catch (error) {
        await stopBrowserCamera();
        cameraTestStatus.textContent = error.name === 'NotAllowedError'
          ? 'Allow camera access in your browser to test it'
          : error.message;
      } finally {
        cameraToggle.disabled = false;
      }
    });

    window.addEventListener('pagehide', () => {
      if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
        postCamera({ action: 'stop' }, true).catch(() => {});
      }
    });
  }

  // 1. Dashboard Auto-Refresh Telemetry
  const dashboardContainer = document.getElementById('isss-dashboard-container');
  if (dashboardContainer) {
    setInterval(async () => {
      try {
        const res = await fetch('/api/health');
        if (!res.ok) return;
        const data = await res.json();

        if (cameraToggle && cameraTestStatus && cameraToggle.dataset.active === 'true') {
          const camera = (data.cameras || []).find(item => Number(item.device_id) === deviceId);
          const sample = camera && camera.latest_detection;
          const ageSeconds = sample ? (Date.now() - new Date(sample.timestamp).getTime()) / 1000 : Infinity;
          if (!data.detection_enabled) {
            cameraTestStatus.textContent = 'Camera connected; motion detection is disabled in Settings';
          } else if (!sample || ageSeconds > 10) {
            cameraTestStatus.textContent = camera && camera.status === 'Error'
              ? `Camera error: ${camera.last_error || 'check its source settings'}`
              : 'Camera active; waiting for frames from the detector';
          } else if (sample.motion) {
            cameraTestStatus.textContent = `Motion detected (${sample.changedAreaPercent}% of frame)`;
          } else {
            cameraTestStatus.textContent = `Monitoring; ${sample.changedAreaPercent}% frame change`;
          }
        }

        // Update camera badge
        const camBadge = document.getElementById('telemetry-camera-status');
        if (camBadge) {
          camBadge.className = `isss-badge isss-badge-${data.camera_status.toLowerCase()}`;
          camBadge.innerHTML = `<span class="isss-dot"></span> ${data.camera_status.toUpperCase()}`;
        }

        // Update heartbeat age
        const hbAge = document.getElementById('telemetry-heartbeat-age');
        if (hbAge) {
          if (data.heartbeat_stale) {
            hbAge.textContent = `Stale (${data.heartbeat_age_seconds || '?'}s ago)`;
            hbAge.className = 'text-danger font-monospace';
          } else {
            hbAge.textContent = `${data.heartbeat_age_seconds || 0}s ago`;
            hbAge.className = 'text-success font-monospace';
          }
        }

        // Update process memory & uptime
        const procMem = document.getElementById('telemetry-process-memory');
        if (procMem && data.process_metrics) {
          procMem.textContent = `${data.process_metrics.rssMb} MB RSS (${data.process_metrics.heapUsedMb} MB Heap)`;
        }

        // Update storage free %
        const storageVal = document.getElementById('telemetry-storage-free');
        if (storageVal) {
          storageVal.textContent = `${data.storage_free_percent}% Free`;
          if (data.storage_low) {
            storageVal.className = 'isss-metric-value text-danger';
          }
        }

        // Update network status
        const netStatus = document.getElementById('telemetry-network-status');
        if (netStatus) {
          netStatus.textContent = data.network_connected ? 'CONNECTED' : 'DISCONNECTED';
          netStatus.className = data.network_connected ? 'text-success' : 'text-danger';
        }
      } catch (err) {
        // Silently skip if network or server temporarily down
      }
    }, 5000);
  }

  const cameraOverview = document.getElementById('isss-camera-overview');
  if (cameraOverview) {
    const refreshCameraCards = async () => {
      try {
        const response = await fetch('/api/cameras', { credentials: 'same-origin' });
        if (!response.ok) return;
        const { cameras, streams_enabled: streamsEnabled } = await response.json();
        const connectedCount = document.getElementById('isss-connected-camera-count');
        const activeCount = document.getElementById('isss-active-camera-count');
        if (connectedCount) connectedCount.textContent = cameras.filter(camera => camera.status === 'Connected').length;
        if (activeCount) activeCount.textContent = cameras.length;
        cameras.forEach(camera => {
          const tile = cameraOverview.querySelector(`[data-camera-id="${camera.device_id}"]`);
          if (!tile) return;
          const statusChip = tile.querySelector('[data-camera-status]');
          if (statusChip) {
            statusChip.className = `isss-camera-status-chip ${String(camera.status).toLowerCase()}`;
            statusChip.innerHTML = `<i></i>${camera.status}`;
            statusChip.title = camera.last_error || '';
          }
          const motion = tile.querySelector('[data-camera-motion]');
          if (motion && camera.latest_detection) {
            const sample = camera.latest_detection;
            motion.textContent = sample.motion
              ? `Motion · ${sample.changedAreaPercent}%`
              : `Monitoring · ${sample.changedAreaPercent}% change`;
          }
          const feed = tile.querySelector('.isss-camera-feed');
          if (feed && streamsEnabled && camera.has_frame && !feed.querySelector('img')) {
            const image = document.createElement('img');
            image.src = `/live/stream?device_id=${encodeURIComponent(camera.device_id)}`;
            image.alt = `Live feed from ${camera.device_name}`;
            const empty = feed.querySelector('.isss-camera-feed-empty');
            if (empty) empty.remove();
            feed.prepend(image);
          }
        });
      } catch (error) {
        // Keep the last camera status visible while the network recovers.
      }
    };
    refreshCameraCards();
    setInterval(refreshCameraCards, 5000);
  }

  // 2. Live Stream Error Reconnection
  const liveImg = document.getElementById('isss-live-stream-img');
  if (liveImg) {
    let reconnectTimeout = null;
    const streamUrl = liveImg.getAttribute('src');

    liveImg.addEventListener('error', () => {
      console.warn('[LiveStream] Feed disconnected. Retrying in 2 seconds...');
      const statusText = document.getElementById('live-stream-status-text');
      if (statusText) statusText.textContent = 'Reconnecting...';

      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      reconnectTimeout = setTimeout(() => {
        liveImg.src = `${streamUrl}?t=${Date.now()}`;
        if (statusText) statusText.textContent = 'Connected';
      }, 2000);
    });
  }
});
