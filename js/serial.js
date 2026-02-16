/**
 * WebSerialTransport — Web Serial API transport for TA612C (Chromium only).
 *
 * Events emitted:
 *   'connected'    — serial port opened
 *   'disconnected' — serial port closed
 *   'reading'      — { channels: [t1,t2,t3,t4], raw } real-time temperature data
 *   'info'         — { model, version } device identification
 *   'record'       — { records: [[t1,t2,t3,t4], ...] } logged data
 *   'log'          — { message } informational log line
 *   'error'        — { message } error description
 */
import { parseFrame, parseRealtimeData, parseModelVersion, parseRecordData } from './protocol.js';

export class WebSerialTransport extends EventTarget {
  #port = null;
  #writer = null;
  #reader = null;
  #readLoopRunning = false;

  static isSupported() {
    return 'serial' in navigator;
  }

  async connect() {
    try {
      this.#port = await navigator.serial.requestPort();
      await this.#port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' });
      this.#writer = this.#port.writable.getWriter();
      this.#emit('connected');
      this.#emit('log', { message: 'Serial port opened (9600 8N1)' });
      this.#readLoop();
    } catch (err) {
      this.#emit('error', { message: 'Connect failed: ' + err.message });
      throw err;
    }
  }

  async disconnect() {
    this.#readLoopRunning = false;
    try {
      if (this.#reader) {
        await this.#reader.cancel();
        this.#reader.releaseLock();
        this.#reader = null;
      }
    } catch (_) {}
    try {
      if (this.#writer) {
        this.#writer.releaseLock();
        this.#writer = null;
      }
    } catch (_) {}
    try {
      if (this.#port) {
        await this.#port.close();
        this.#port = null;
      }
    } catch (err) {
      this.#emit('error', { message: 'Close error: ' + err.message });
    }
    this.#emit('disconnected');
    this.#emit('log', { message: 'Serial port closed' });
  }

  async send(cmdBytes) {
    if (!this.#writer) {
      this.#emit('error', { message: 'Not connected' });
      return;
    }
    await this.#writer.write(cmdBytes);
    this.#emit('log', { message: 'Sent: [' + Array.from(cmdBytes).map(b => b.toString(16).padStart(2, '0')).join(' ') + ']' });
  }

  async #readLoop() {
    this.#reader = this.#port.readable.getReader();
    this.#readLoopRunning = true;
    let buffer = new Uint8Array(0);
    try {
      while (this.#readLoopRunning) {
        const { value, done } = await this.#reader.read();
        if (done) break;
        if (value) {
          // Append to buffer
          const merged = new Uint8Array(buffer.length + value.length);
          merged.set(buffer);
          merged.set(value, buffer.length);
          buffer = merged;
          // Try to parse frames
          let result;
          do {
            result = parseFrame(buffer);
            if (result.frame) {
              this.#handleFrame(result.frame);
            }
            buffer = result.remaining;
          } while (result.frame);
        }
      }
    } catch (err) {
      if (this.#readLoopRunning) {
        this.#emit('error', { message: 'Read error: ' + err.message });
      }
    } finally {
      try { this.#reader.releaseLock(); } catch (_) {}
      this.#reader = null;
    }
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
