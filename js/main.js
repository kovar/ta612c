/**
 * main.js — Entry point. Wires all modules together for TA612C thermocouple logger.
 */
import { ConnectionManager } from './connection.js';
import { ChartManager } from './chart-manager.js';
import { Recorder } from './recorder.js';
import { StatsTracker } from './stats.js';
import { COMMANDS, buildTimeSync } from './protocol.js';
import {
  setConnectionState, setMeasurementState, setRecordingState,
  updateReadout, updateStats, updateDeviceInfo,
  appendLog, showToast,
} from './ui.js';

// ── Instances ──────────────────────────────────────────────
const conn = new ConnectionManager();
let chart;
const recorder = new Recorder();
const channelStats = [new StatsTracker(), new StatsTracker(), new StatsTracker(), new StatsTracker()];
let measurementInterval = null;
let measurementTimeout = null;
let lastReadingTime = 0;
let demoInterval = null;
let demoState = null;

// ── DOM Ready ──────────────────────────────────────────────
window._ta612cModulesLoaded = true;

document.addEventListener('DOMContentLoaded', () => {
  wireConnection();
  wireToolbar();

  setConnectionState(false);
  setMeasurementState(false);
  setRecordingState(false);

  const serialBtn = document.getElementById('connectSerial');
  if (!conn.hasWebSerial && serialBtn) {
    serialBtn.style.display = 'none';
  }

  try {
    chart = new ChartManager(document.getElementById('chartCanvas'));
    wireChart();
  } catch (err) {
    appendLog('Chart init failed: ' + err.message);
  }
});

// ── Connection Events ──────────────────────────────────────
function wireConnection() {
  conn.addEventListener('connected', () => {
    setConnectionState(true);
    appendLog('Connected');
    showToast('Connected to TA612C', 'success');
  });

  conn.addEventListener('disconnected', () => {
    stopMeasurement();
    setConnectionState(false);
    appendLog('Disconnected');
    showToast('Disconnected', 'info');
  });

  conn.addEventListener('reading', (e) => {
    const { channels } = e.detail;
    lastReadingTime = Date.now();
    updateReadout(channels);
    if (chart) chart.addReading(channels);
    for (let i = 0; i < 4; i++) {
      channelStats[i].addValue(channels[i]);
    }
    updateStats(channelStats.map(s => s.getStats()));
    recorder.addReading(channels);
  });

  conn.addEventListener('info', (e) => {
    const { model, version } = e.detail;
    updateDeviceInfo(model, version);
    appendLog(`Device: TA${model} ${version}`);
    showToast(`Device: TA${model} ${version}`, 'info');
  });

  conn.addEventListener('record', (e) => {
    const { records } = e.detail;
    appendLog(`Received ${records.length} logged record(s)`);
  });

  conn.addEventListener('log', (e) => appendLog(e.detail.message));
  conn.addEventListener('error', (e) => {
    appendLog('ERROR: ' + e.detail.message);
    showToast(e.detail.message, 'error', 6000);
  });
}

// ── Toolbar Buttons ────────────────────────────────────────
function wireToolbar() {
  document.getElementById('connectSerial')?.addEventListener('click', async () => {
    try { await conn.connectSerial(); } catch (_) {}
  });

  document.getElementById('connectWs')?.addEventListener('click', async () => {
    const url = document.getElementById('wsUrl')?.value || undefined;
    try { await conn.connectWebSocket(url); } catch (_) {}
  });

  document.getElementById('disconnect')?.addEventListener('click', async () => {
    try { await conn.send(COMMANDS.STOP); } catch (_) {}
    conn.disconnect();
  });

  // Measurement
  document.getElementById('startMeasure')?.addEventListener('click', startMeasurement);
  document.getElementById('stopMeasure')?.addEventListener('click', stopMeasurement);

  // Recording
  document.getElementById('startRecord')?.addEventListener('click', () => {
    recorder.start();
    setRecordingState(true);
    appendLog('Recording started');
    showToast('Recording started', 'info');
  });

  document.getElementById('stopRecord')?.addEventListener('click', () => {
    recorder.stop();
    setRecordingState(false);
    if (recorder.download()) {
      const msg = 'Recording saved (' + recorder.count + ' readings)';
      appendLog(msg);
      showToast(msg, 'success');
    } else {
      appendLog('No data recorded');
      showToast('No data recorded', 'error');
    }
  });

  // Time sync
  document.getElementById('timeSync')?.addEventListener('click', () => {
    const frame = buildTimeSync(new Date());
    conn.send(frame);
    appendLog('Time sync sent');
    showToast('Device clock synchronized', 'info');
  });

  // Demo
  document.getElementById('demo')?.addEventListener('click', toggleDemo);
}

// ── Measurement ────────────────────────────────────────────
function startMeasurement() {
  if (measurementInterval) return;
  const rate = parseInt(document.getElementById('samplingRate')?.value) || 1000;
  const before = lastReadingTime;
  // Send initial command immediately, then at interval
  conn.send(COMMANDS.START_REALTIME);
  measurementInterval = setInterval(() => conn.send(COMMANDS.START_REALTIME), rate);
  setMeasurementState(true);
  appendLog(`Measurement started (every ${rate} ms)`);
  showToast(`Polling every ${rate} ms`, 'info');

  measurementTimeout = setTimeout(() => {
    if (measurementInterval && lastReadingTime === before) {
      showToast('No response from device \u2014 is it connected and powered on?', 'error', 6000);
      appendLog('WARNING: No readings received from device');
    }
  }, 3000);
}

function stopMeasurement() {
  if (!measurementInterval) return;
  clearInterval(measurementInterval);
  clearTimeout(measurementTimeout);
  measurementInterval = null;
  measurementTimeout = null;
  // Send STOP command to device
  conn.send(COMMANDS.STOP);
  setMeasurementState(false);
  appendLog('Measurement stopped');
}

// ── Chart Controls ─────────────────────────────────────────
function wireChart() {
  document.getElementById('timeRange')?.addEventListener('change', (e) => {
    chart.setTimeWindow(parseInt(e.target.value));
  });

  document.getElementById('yMin')?.addEventListener('change', () => {
    chart.setYRange(
      document.getElementById('yMin').value,
      document.getElementById('yMax').value,
    );
  });

  document.getElementById('yMax')?.addEventListener('change', () => {
    chart.setYRange(
      document.getElementById('yMin').value,
      document.getElementById('yMax').value,
    );
  });

  document.getElementById('resetZoom')?.addEventListener('click', () => {
    chart.resetZoom();
    document.getElementById('yMin').value = '';
    document.getElementById('yMax').value = '';
  });

  document.getElementById('clearChart')?.addEventListener('click', () => {
    chart.clear();
    for (const s of channelStats) s.reset();
    updateStats(channelStats.map(s => s.getStats()));
  });
}

// ── Demo Mode ──────────────────────────────────────────────
function toggleDemo() {
  const btn = document.getElementById('demo');
  if (demoInterval) {
    stopDemo();
  } else {
    startDemo();
    if (btn) { btn.textContent = 'Stop Demo'; btn.classList.add('active'); }
  }
}

function startDemo() {
  demoState = {
    bases: [25.0, 30.0, 22.0, 28.0],
    drifts: [0, 0, 0, 0],
    step: 0,
  };
  const rate = parseInt(document.getElementById('samplingRate')?.value) || 1000;

  setConnectionState(true);
  showToast('Demo mode \u2014 generating fake thermocouple data', 'info');
  appendLog('Demo started');

  demoInterval = setInterval(() => {
    demoState.step++;
    const channels = demoState.bases.map((base, i) => {
      // Independent drift per channel with different frequencies
      const drift = 2.0 * Math.sin(demoState.step / (40 + i * 15) * Math.PI * 2);
      const noise = ((Math.random() + Math.random() + Math.random()) / 3 - 0.5) * 0.6;
      return Math.round((base + drift + noise) * 10) / 10;
    });

    updateReadout(channels);
    if (chart) chart.addReading(channels);
    for (let i = 0; i < 4; i++) {
      channelStats[i].addValue(channels[i]);
    }
    updateStats(channelStats.map(s => s.getStats()));
    recorder.addReading(channels);
    appendLog(`T1=${channels[0].toFixed(1)} T2=${channels[1].toFixed(1)} T3=${channels[2].toFixed(1)} T4=${channels[3].toFixed(1)} \u00B0C`);
  }, rate);
}

function stopDemo() {
  if (demoInterval) {
    clearInterval(demoInterval);
    demoInterval = null;
    demoState = null;
  }
  stopMeasurement();
  setConnectionState(false);
  const btn = document.getElementById('demo');
  if (btn) { btn.textContent = 'Demo'; btn.classList.remove('active'); }
  appendLog('Demo stopped');
  showToast('Demo stopped', 'info');
}
