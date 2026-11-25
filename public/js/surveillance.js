/**
 * ISSS Surveillance Viewer — Client Script
 * Handles: OSD clock, tab switching, timeline interactions,
 *          stream reconnection, snapshot download, feed polling,
 *          fullscreen, day selection.
 */
(function () {
  'use strict';

  const cfg = window._svConfig || {};
  const cameraId = cfg.cameraDeviceId;
  const streamBase = cameraId ? `/live/stream?device_id=${encodeURIComponent(cameraId)}` : '/live/stream';

  /* ── OSD Real-Time Clock ─────────────────────────────────────────── */
  const clockEl = document.getElementById('sv-osd-clock');
  function tickClock() {
    if (!clockEl) return;
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString('en-US', { hour12: false });
  }
  tickClock();
  setInterval(tickClock, 1000);

  /* ── Tab Switching ───────────────────────────────────────────────── */
  const tabBtns = document.querySelectorAll('#sv-tabs .sv-tab-pill');
  const tabPanels = document.querySelectorAll('.sv-tab-panel');
  let activeTab = 'all';
  let reviewFilter = 'all';

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      tabPanels.forEach(p => p.classList.remove('active'));
      const panel = document.getElementById('sv-panel-' + activeTab);
      if (panel) panel.classList.add('active');
      // Filter the feed list when tabs switch
      filterFeed();
    });
  });

  function filterFeed() {
    const items = document.querySelectorAll('#sv-feed-list .sv-feed-item');
    items.forEach(item => {
      const type = item.querySelector('.sv-feed-type')?.textContent || '';
      const typeMatches = activeTab === 'all' ||
        (activeTab === 'motion' && (type.includes('Frame') || type.includes('Running'))) ||
        (activeTab === 'pir' && type.includes('PIR'));
      const statusMatches = reviewFilter === 'all' || item.dataset.reviewStatus === reviewFilter;
      item.style.display = typeMatches && statusMatches ? '' : 'none';
    });
  }

  /* ── Live Stream Reconnection ────────────────────────────────────── */
  const streamImg = document.getElementById('sv-stream-img');
  const offlineOverlay = document.getElementById('sv-offline-overlay');
  const offlineSub = document.getElementById('sv-offline-sub');
  const liveBadge = document.getElementById('sv-live-badge');
  let reconnectTimer = null;
  let reconnectAttempts = 0;

  window.svHandleStreamError = function () {
    if (offlineOverlay) offlineOverlay.style.display = 'flex';
    if (liveBadge) liveBadge.style.display = 'none';
    reconnectAttempts++;
    const delay = Math.min(2000 * reconnectAttempts, 15000);
    if (offlineSub) offlineSub.textContent = `Stream lost — retrying in ${delay / 1000}s…`;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (streamImg) {
        streamImg.src = `${streamBase}${cameraId ? '&' : '?'}t=${Date.now()}`;
      }
    }, delay);
  };

  if (streamImg) {
    streamImg.addEventListener('load', () => {
      if (offlineOverlay) offlineOverlay.style.display = 'none';
      if (liveBadge) liveBadge.style.display = '';
      reconnectAttempts = 0;
    });
  }

  /* ── Snapshot (save latest frame via /api/stream/frame) ─────────── */
  const snapBtn = document.getElementById('sv-snapshot-btn');
  const snapDl = document.getElementById('sv-snap-dl');

  if (snapBtn && snapDl) {
    snapBtn.addEventListener('click', async () => {
      try {
        const frameUrl = cameraId ? `/api/stream/frame?device_id=${encodeURIComponent(cameraId)}` : '/api/stream/frame';
        const res = await fetch(frameUrl, { credentials: 'same-origin' });
        if (!res.ok) { alert('Snapshot unavailable — camera may be offline.'); return; }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        snapDl.href = url;
        snapDl.download = 'isss-snapshot-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jpg';
        snapDl.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (e) {
        alert('Snapshot failed: ' + e.message);
      }
    });
  }

  /* ── Fullscreen ──────────────────────────────────────────────────── */
  const fullscreenBtn = document.getElementById('sv-fullscreen-btn');
  const playerWrap = document.getElementById('sv-player-wrap');

  if (fullscreenBtn && playerWrap) {
    fullscreenBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        playerWrap.requestFullscreen && playerWrap.requestFullscreen();
      } else {
        document.exitFullscreen && document.exitFullscreen();
      }
    });
  }

  /* ── Live Button ─────────────────────────────────────────────────── */
  const liveBtn = document.getElementById('sv-live-btn');
  if (liveBtn && streamImg) {
    liveBtn.addEventListener('click', () => {
      streamImg.src = `${streamBase}${cameraId ? '&' : '?'}t=${Date.now()}`;
      if (offlineOverlay) offlineOverlay.style.display = 'none';
      if (liveBadge) liveBadge.style.display = '';
    });
  }

  /* ── Skip buttons (navigate events in feed) ──────────────────────── */
  const feedItems = Array.from(document.querySelectorAll('#sv-feed-list .sv-feed-item'));
  let currentFeedIdx = 0;

  function markActiveFeed(idx) {
    feedItems.forEach(i => i.classList.remove('active'));
    if (feedItems[idx]) {
      feedItems[idx].classList.add('active');
      feedItems[idx].scrollIntoView({ block: 'nearest' });
    }
  }

  document.getElementById('sv-skip-back') && document.getElementById('sv-skip-back').addEventListener('click', () => {
    if (currentFeedIdx > 0) { currentFeedIdx--; markActiveFeed(currentFeedIdx); }
  });
  document.getElementById('sv-skip-next') && document.getElementById('sv-skip-next').addEventListener('click', () => {
    if (currentFeedIdx < feedItems.length - 1) { currentFeedIdx++; markActiveFeed(currentFeedIdx); }
  });
  document.getElementById('sv-rw10') && document.getElementById('sv-rw10').addEventListener('click', () => {
    if (currentFeedIdx > 0) { currentFeedIdx--; markActiveFeed(currentFeedIdx); }
  });
  document.getElementById('sv-skip-fwd') && document.getElementById('sv-skip-fwd').addEventListener('click', () => {
    if (currentFeedIdx < feedItems.length - 1) { currentFeedIdx++; markActiveFeed(currentFeedIdx); }
  });

  /* ── Feed Item Hover Highlight (sync with timeline clips) ───────── */
  const clipThumbs = document.querySelectorAll('.sv-clip-thumb');

  clipThumbs.forEach(thumb => {
    thumb.addEventListener('click', () => {
      clipThumbs.forEach(t => t.classList.remove('active'));
      thumb.classList.add('active');
      // Find matching feed item
      const eid = thumb.dataset.eventId;
      feedItems.forEach(item => item.classList.remove('active'));
      const matchFeed = feedItems.find(i => i.dataset.eventId === eid);
      if (matchFeed) {
        const idx = feedItems.indexOf(matchFeed);
        currentFeedIdx = idx;
        matchFeed.classList.add('active');
        matchFeed.scrollIntoView({ block: 'nearest' });
      }
    });
  });

  /* ── Date strip (sidebar) + Timeline day selector sync ───────────── */
  const weekCells = document.querySelectorAll('#sv-week-strip .sv-date-cell');
  const tlDayBtns = document.querySelectorAll('#sv-tl-days .sv-tl-day');

  function selectDate(date) {
    weekCells.forEach(c => { c.classList.toggle('active', c.dataset.date === date); });
    tlDayBtns.forEach(b => { b.classList.toggle('active', b.dataset.date === date); });
    // Reload page with the selected date as a query param
    const url = new URL(window.location.href);
    url.searchParams.set('date', date);
    window.location.href = url.toString();
  }

  weekCells.forEach(c => c.addEventListener('click', () => selectDate(c.dataset.date)));
  tlDayBtns.forEach(b => b.addEventListener('click', () => selectDate(b.dataset.date)));

  /* ── Timeline date label ─────────────────────────────────────────── */
  const tlDateLabel = document.getElementById('sv-tl-date-label');
  if (tlDateLabel) {
    const params = new URLSearchParams(window.location.search);
    const selectedDate = params.get('date');
    if (selectedDate) {
      const d = new Date(selectedDate);
      tlDateLabel.textContent = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }
  }

  const dateButton = document.getElementById('sv-tl-date-btn');
  if (dateButton) {
    dateButton.addEventListener('click', () => {
      const picker = document.createElement('input');
      picker.type = 'date';
      picker.value = new URLSearchParams(window.location.search).get('date') || new Date().toISOString().slice(0, 10);
      picker.addEventListener('change', () => {
        if (picker.value) selectDate(picker.value);
      });
      document.body.appendChild(picker);
      if (picker.showPicker) picker.showPicker();
      else picker.click();
      picker.addEventListener('blur', () => picker.remove(), { once: true });
    });
  }

  const timelineScroll = document.getElementById('sv-tl-scroll');
  const timelineRuler = document.getElementById('sv-tl-ruler');
  let timelineZoom = 1;
  function setTimelineZoom(nextZoom) {
    timelineZoom = Math.max(0.5, Math.min(3, nextZoom));
    if (!timelineRuler) return;
    timelineRuler.querySelectorAll('.sv-tl-tick-group').forEach(group => {
      group.style.minWidth = `${100 * timelineZoom}px`;
    });
  }
  document.getElementById('sv-tl-zoom-in')?.addEventListener('click', () => setTimelineZoom(timelineZoom + 0.25));
  document.getElementById('sv-tl-zoom-out')?.addEventListener('click', () => setTimelineZoom(timelineZoom - 0.25));

  document.getElementById('sv-tl-export-btn')?.addEventListener('click', () => {
    const rows = [['Event ID', 'Time', 'Detection type', 'Review status', 'Event URL']];
    document.querySelectorAll('#sv-feed-list .sv-feed-item').forEach(item => {
      const cells = [item.dataset.eventId || '', item.querySelector('.sv-feed-time')?.textContent.trim() || '',
        item.querySelector('.sv-feed-type')?.textContent.trim() || '', item.dataset.reviewStatus || '',
        new URL(item.href, window.location.href).href];
      rows.push(cells.map(value => `"${String(value).replace(/"/g, '""')}"`));
    });
    const csv = rows.map(row => row.join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `isss-timeline-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  });

  /* ── Feed Auto-Refresh (poll every 15s for new events) ───────────── */
  const feedRefreshBtn = document.getElementById('sv-feed-refresh-btn');
  const feedFilterBtn = document.getElementById('sv-feed-filter-btn');
  const reviewFilters = ['all', 'New', 'Reviewed', 'FalseAlarm'];
  if (feedFilterBtn) {
    feedFilterBtn.addEventListener('click', () => {
      reviewFilter = reviewFilters[(reviewFilters.indexOf(reviewFilter) + 1) % reviewFilters.length];
      feedFilterBtn.title = `Review filter: ${reviewFilter === 'all' ? 'All' : reviewFilter}`;
      filterFeed();
    });
  }

  async function refreshFeed() {
    try {
      const res = await fetch('/api/events?limit=20', { credentials: 'same-origin' });
      if (!res.ok) return;
      // Feed refresh is a progressive enhancement; full reload on new events
      const data = await res.json();
      const latestId = feedItems.length > 0 ? feedItems[0].dataset.eventId : null;
      if (data.events && data.events.length > 0 && data.events[0].event_id !== latestId) {
        // New events detected — reload to show fresh feed
        window.location.reload();
      }
    } catch (_) {}
  }

  if (feedRefreshBtn) {
    feedRefreshBtn.addEventListener('click', refreshFeed);
  }

  // Auto-poll every 15 seconds
  setInterval(refreshFeed, 15000);

  /* ── Health status polling (syncs camera badge if offline) ───────── */
  async function pollHealth() {
    try {
      const res = await fetch('/api/health', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      // If camera disconnects, show offline overlay
      if (data.camera_status && data.camera_status.toLowerCase() !== 'connected' && streamImg) {
        if (offlineOverlay && offlineOverlay.style.display === 'none') {
          document.getElementById('sv-offline-title') &&
            (document.getElementById('sv-offline-title').textContent = 'Camera ' + data.camera_status);
          offlineOverlay.style.display = 'flex';
          if (liveBadge) liveBadge.style.display = 'none';
        }
      }
    } catch (_) {}
  }
  setInterval(pollHealth, 5000);

  /* ── Cycle through active cameras ── */
  const nextDevice = document.getElementById('sv-next-device');
  if (nextDevice) {
    nextDevice.addEventListener('click', async () => {
      nextDevice.disabled = true;
      try {
        const response = await fetch('/api/cameras', { credentials: 'same-origin' });
        if (!response.ok) throw new Error('Could not load cameras');
        const data = await response.json();
        // /api/cameras only returns active devices.
        const cameras = data.cameras || [];
        if (!cameras.length) return;
        const index = cameras.findIndex(camera => Number(camera.device_id) === Number(cameraId));
        const nextCamera = cameras[(index + 1) % cameras.length];
        window.location.href = `/live?device_id=${encodeURIComponent(nextCamera.device_id)}`;
      } catch (_) {
        nextDevice.disabled = false;
      }
    });
  }

  /* ── Search button (redirect to events with search) ─────────────── */
  const searchBtn = document.getElementById('sv-search-btn');
  if (searchBtn) {
    searchBtn.addEventListener('click', () => {
      window.location.href = '/events';
    });
  }

})();
