/**
 * WebSocketTransport — connects to bridge.py for non-Chromium browsers.
 *
 * Events emitted (same interface as WebSerialTransport):
 *   'connected', 'disconnected', 'reading', 'info', 'record', 'log', 'error'
 */
import { parseFrame, parseRealtimeData, parseModelVersion, parseRecordData } from './protocol.js';

export class WebSocketTransport extends EventTarget {
  #ws = null;
  #url = '';
  #shouldReconnect = false;
  #reconnectTimer = null;
  static DEFAULT_URL = 'ws://localhost:8767';

  async connect(url) {
    this.#url = url || WebSocketTransport.DEFAULT_URL;
    this.#shouldReconnect = true;
    return this.#open();
  }

  #open() {
    return new Promise((resolve, reject) => {
      this.#emit('log', { message: 'Connecting to ' + this.#url + '...' });
      this.#ws = new WebSocket(this.#url);
      this.#ws.binaryType = 'arraybuffer';
      let buffer = new Uint8Array(0);

      this.#ws.onopen = () => {
        this.#emit('connected');
        this.#emit('log', { message: 'WebSocket connected to ' + this.#url });
        resolve();
      };

      this.#ws.onerror = () => {
        const msg = 'Connection failed \u2014 run `uv run bridge.py` in a terminal first';
        this.#emit('error', { message: msg });
        this.#shouldReconnect = false;
        reject(new Error(msg));
      };

      this.#ws.onclose = () => {
        this.#emit('disconnected');
        this.#emit('log', { message: 'WebSocket closed' });
        if (this.#shouldReconnect) {
          this.#emit('log', { message: 'Reconnecting in 3s...' });
          this.#reconnectTimer = setTimeout(() => this.#open().catch(() => {}), 3000);
        }
      };

      this.#ws.onmessage = (event) => {
        const data = new Uint8Array(event.data);
        // Append to buffer
        const merged = new Uint8Array(buffer.length + data.length);
        merged.set(buffer);
        merged.set(data, buffer.length);
        buffer = merged;
        // Parse frames
        let result;
        do {
          result = parseFrame(buffer);
          if (result.frame) {
            this.#handleFrame(result.frame);
          }
          buffer = result.remaining;
        } while (result.frame);
      };
    });
  }

  async disconnect() {
    this.#shouldReconnect = false;
    clearTimeout(this.#reconnectTimer);
    if (this.#ws) {
      this.#ws.close();
      this.#ws = null;
    }
  }

  async send(cmdBytes) {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      this.#emit('error', { message: 'WebSocket not connected' });
      return;
    }
    this.#ws.send(cmdBytes.buffer);
    this.#emit('log', { message: 'Sent: [' + Array.from(cmdBytes).map(b => b.toString(16).padStart(2, '0')).join(' ') + ']' });
  }

  #handleFrame(frame) {
    const hex = Array.from(frame.payload).map(b => b.toString(16).padStart(2, '0')).join(' ');
    this.#emit('log', { message: `Received frame: cmd=0x${frame.command.toString(16).padStart(2, '0')} payload=[${hex}]` });

    switch (frame.command) {
      case 0x01: {
        const data = parseRealtimeData(frame.payload);
        if (data) this.#emit('reading', { channels: data.channels, raw: frame.payload });
        break;
      }
      case 0x00: {
        const info = parseModelVersion(frame.payload);
        if (info) this.#emit('info', { model: info.model, version: info.version });
        break;
      }
      case 0x02: {
        const records = parseRecordData(frame.payload);
        if (records) this.#emit('record', records);
        break;
      }
    }
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
