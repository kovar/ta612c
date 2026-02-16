# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Web application for communicating with a TA612C 4-channel thermocouple logger via RS232C. Reads temperature data over serial (or WebSocket bridge), displays live readings from 4 thermocouple channels with statistics, plots measurements in real-time, and exports to CSV.

## Architecture

```
index.html              → HTML shell (4-channel thermocouple UI)
css/styles.css          → All styles, CSS custom properties for dark/light theming
js/
  main.js               → Entry point: imports modules, polling loop, event wiring
  protocol.js           → TA612C binary protocol: frame parse, commands, checksum
  serial.js             → WebSerialTransport (Web Serial API, Chromium only)
  websocket.js          → WebSocketTransport (connects to bridge.py)
  connection.js         → ConnectionManager: picks transport, uniform event interface
  chart-manager.js      → ChartManager wrapping Chart.js (4 datasets, one per channel)
  recorder.js           → Recorder with Blob-based CSV export (Timestamp,T1,T2,T3,T4)
  stats.js              → StatsTracker (Welford's algorithm for live statistics)
  ui.js                 → Theme toggle, connection badge, button states, formatting

bridge.py               → WebSocket ↔ serial bridge (pyserial + websockets, binary relay)
serve.py                → Local dev server (http://localhost:8000)
```

No build step. No npm. ES modules loaded via `<script type="module">`. Chart.js + date adapter loaded from CDN with pinned versions.

## Protocol (TA612C Binary)

**Serial config:** 9600 baud, 8N1, no parity, no handshake (RS232C)

**Frame structure:**
- Header: 2 bytes (PC→Device: `0xAA 0x55`, Device→PC: `0x55 0xAA`)
- Command: 1 byte
- Length: 1 byte (total bytes after header, including this byte)
- Payload: variable
- Checksum: 1 byte (low byte of sum of all preceding bytes)

**Commands:**
- `AA 55 01 03 03` — Request real-time reading (4 channels)
- `AA 55 00 03 02` — Stop, returns model + version
- `AA 55 02 03 04` — Download logged data
- `AA 55 03 ...`   — Time sync (7 BCD-encoded bytes)

**Temperature encoding:** 16-bit LE signed, divide by 10 for °C (e.g. 275 → 27.5 °C)

## Transport Layer

Two transport backends implement the same EventTarget interface:
- **Web Serial** (`serial.js`) — direct USB access in Chromium browsers
- **WebSocket** (`websocket.js`) — connects to `bridge.py` for Firefox/Safari/any browser

Both use `protocol.js` for binary frame parsing. `ConnectionManager` (`connection.js`) auto-detects browser capabilities.

## Running

**Web UI (local development):**
```bash
uv run serve.py     # starts http://localhost:8000 and opens browser
```
Do NOT open `index.html` directly — ES modules require HTTP, not `file://`.

- Chrome/Edge: can connect directly via USB (Web Serial API)
- Firefox/Safari: use the WebSocket bridge
- Any browser: click Demo to test with fake data

**WebSocket Bridge (for non-Chromium browsers):**
```bash
uv run bridge.py                        # auto-detect serial port
uv run bridge.py /dev/cu.usbserial-10   # specify port
```
Dependencies (`pyserial`, `websockets`) are declared inline via PEP 723 — `uv` installs them automatically.
