# TA612C Thermocouple Logger

Web application for communicating with a TA612C 4-channel thermocouple temperature logger via RS232C. Reads temperature data over serial or WebSocket, displays live readings with statistics, charts measurements in real-time, and exports to CSV.

![Screenshot — dark mode demo](https://img.shields.io/badge/no_build_step-ES_modules-teal)

## Features

- **4-channel live readout** with color-coded temperatures (T1–T4)
- **Real-time chart** with 4 datasets, configurable time window and Y-axis range
- **Running statistics** — min, max, mean per channel (Welford's algorithm)
- **CSV recording** — timestamped export with columns Timestamp, T1, T2, T3, T4
- **Two connection modes** — USB (Web Serial) or WebSocket bridge
- **Dark/light theme** — auto-detects OS preference
- **Demo mode** — try it without hardware
- **Clock sync** — synchronize device clock to PC time

## Quick Start

```bash
uv run serve.py
```

This starts a local server at **http://localhost:8000** and opens your browser.

> Don't open `index.html` directly — ES modules require a web server.

### Connect to your TA612C

- **Chrome/Edge:** Click **USB** to connect directly via Web Serial API
- **Firefox/Safari/remote:** Start the bridge, then click **Bridge**:
  ```bash
  uv run bridge.py                        # auto-detect serial port
  uv run bridge.py /dev/cu.usbserial-10   # specify port
  ```
- **No hardware:** Click **Demo** to generate fake data

## Architecture

No build step, no npm, no bundler. Plain ES modules served over HTTP. Chart.js loaded from CDN.

```
index.html          HTML shell (4-channel thermocouple UI)
css/styles.css      Styles with CSS custom properties for theming
js/
  main.js           Entry point, polling loop, event wiring
  protocol.js       TA612C binary protocol: frame parse, commands, checksum
  serial.js         Web Serial transport (Chromium only)
  websocket.js      WebSocket transport (connects to bridge.py)
  connection.js     ConnectionManager — uniform event interface
  chart-manager.js  Chart.js wrapper (4 datasets, one per channel)
  recorder.js       CSV recording and Blob-based download
  stats.js          Welford's online statistics
  ui.js             Button states, formatting, toasts
bridge.py           WebSocket-to-serial relay (pyserial + websockets)
serve.py            Local dev server
```

## TA612C Protocol

Binary protocol over RS232C. Serial config: 9600 baud, 8N1, no parity.

| Command | Hex | Description |
|---------|-----|-------------|
| Start Real-time | `AA 55 01 03 03` | Request one reading (4 channels) |
| Stop | `AA 55 00 03 02` | Stop transmitting, returns model + version |
| Start Logged | `AA 55 02 03 04` | Download recorded data from device memory |
| Time Sync | `AA 55 03 07 <BCD> sum` | Synchronize device clock |

Temperature encoding: 16-bit LE signed, divide by 10 for °C.

The full protocol reference is built into the app under **TA612C Protocol Reference**.

## Dependencies

**Browser:** None — everything loads from CDN or is vanilla JS.

**Python tools** (managed automatically by `uv` via PEP 723 inline metadata):
- `bridge.py` — `pyserial`, `websockets`, `influxdb-client`
- `serve.py` — stdlib only

## Deployment

Deployed to GitHub Pages on push to `main` via `.github/workflows/static.yml`.
