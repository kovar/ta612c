/**
 * UI helpers — button states, temperature formatting, stats display.
 * Theme is handled by inline script in index.html (no module dependency).
 */

const CHANNEL_LABELS = ['T1', 'T2', 'T3', 'T4'];

export function setConnectionState(connected) {
  const dot = document.getElementById('statusDot');
  const connectSerialBtn = document.getElementById('connectSerial');
  const connectWsBtn = document.getElementById('connectWs');
  const disconnectBtn = document.getElementById('disconnect');
  const wsUrlInput = document.getElementById('wsUrl');

  if (dot) dot.classList.toggle('connected', connected);
  if (connectSerialBtn) connectSerialBtn.disabled = connected;
  if (connectWsBtn) connectWsBtn.disabled = connected;
  if (disconnectBtn) disconnectBtn.disabled = !connected;
  if (wsUrlInput) wsUrlInput.disabled = connected;

  const cmdBtns = document.querySelectorAll('[data-requires-connection]');
  cmdBtns.forEach(btn => btn.disabled = !connected);
}

export function setMeasurementState(active) {
  const startBtn = document.getElementById('startMeasure');
  const stopBtn = document.getElementById('stopMeasure');
  if (startBtn) {
    startBtn.disabled = active;
    startBtn.classList.toggle('active', false);
  }
  if (stopBtn) {
    stopBtn.disabled = !active;
    stopBtn.classList.toggle('active', active);
  }
}

export function setRecordingState(active) {
  const startBtn = document.getElementById('startRecord');
  const stopBtn = document.getElementById('stopRecord');
  if (startBtn) {
    startBtn.disabled = active;
    startBtn.classList.toggle('active', false);
  }
  if (stopBtn) {
    stopBtn.disabled = !active;
    stopBtn.classList.toggle('active', active);
  }
}

/**
 * Format a temperature value for display.
 * @param {number|null} value
 * @returns {string}
 */
export function formatTemperature(value) {
  if (value === null || value === undefined) return '---';
  const num = typeof value === 'number' ? value : parseFloat(value);
  if (isNaN(num)) return '---';
  return `${num.toFixed(1)} \u00B0C`;
}

/**
 * Update the 4-channel readout display.
 * @param {number[]} channels — array of 4 temperature values
 */
export function updateReadout(channels) {
  for (let i = 0; i < 4; i++) {
    const valEl = document.getElementById(`readoutT${i + 1}`);
    if (valEl) {
      valEl.textContent = channels[i] !== null && channels[i] !== undefined
        ? channels[i].toFixed(1)
        : '---';
    }
  }
  const timeEl = document.getElementById('readoutTime');
  if (timeEl) timeEl.textContent = new Date().toLocaleTimeString();
}

/**
 * Update stats display for all 4 channels.
 * @param {Array<{min,max,mean,stddev,count}>} channelStats — array of 4 stat objects
 */
export function updateStats(channelStats) {
  const fmt = (v) => v === null ? '---' : v.toFixed(1);
  // Use channel 0's count as the global count (all channels get same readings)
  const countEl = document.getElementById('statCount');
  if (countEl) countEl.textContent = channelStats[0]?.count ?? 0;

  for (let i = 0; i < 4; i++) {
    const s = channelStats[i];
    if (!s) continue;
    const prefix = `statT${i + 1}`;
    const set = (suffix, v) => {
      const el = document.getElementById(prefix + suffix);
      if (el) el.textContent = fmt(v);
    };
    set('Min', s.min);
    set('Max', s.max);
    set('Mean', s.mean);
  }
}

/**
 * Display device info (model + firmware version).
 */
export function updateDeviceInfo(model, version) {
  const el = document.getElementById('deviceInfo');
  if (el) el.textContent = `TA${model} ${version}`;
}

export function appendLog(message) {
  const el = document.getElementById('logOutput');
  if (!el) return;
  const now = new Date().toLocaleTimeString();
  el.textContent += `[${now}] ${message}\n`;
  el.scrollTop = el.scrollHeight;
}

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'info'|'success'|'error'} type
 * @param {number} duration ms before auto-dismiss
 */
export function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  const dismiss = () => {
    el.classList.add('toast-out');
    el.addEventListener('animationend', () => el.remove());
  };
  el.addEventListener('click', dismiss);
  if (duration > 0) setTimeout(dismiss, duration);
}
