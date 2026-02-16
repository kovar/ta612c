/**
 * ConnectionManager — picks transport based on browser capabilities,
 * re-emits events through a single interface.
 *
 * Events: 'connected', 'disconnected', 'reading', 'info', 'record', 'log', 'error'
 */
import { WebSerialTransport } from './serial.js';
import { WebSocketTransport } from './websocket.js';

export class ConnectionManager extends EventTarget {
  #transport = null;
  #connected = false;

  get hasWebSerial() {
    return WebSerialTransport.isSupported();
  }

  get isConnected() {
    return this.#connected;
  }

  async connectSerial() {
    if (this.#connected) await this.disconnect();
    this.#transport = new WebSerialTransport();
    this.#wire();
    await this.#transport.connect();
  }

  async connectWebSocket(url) {
    if (this.#connected) await this.disconnect();
    this.#transport = new WebSocketTransport();
    this.#wire();
    await this.#transport.connect(url);
  }

  async disconnect() {
    if (this.#transport) {
      await this.#transport.disconnect();
      this.#transport = null;
    }
  }

  async send(cmdBytes) {
    if (this.#transport) {
      await this.#transport.send(cmdBytes);
    }
  }

  #wire() {
    const events = ['connected', 'disconnected', 'reading', 'info', 'record', 'log', 'error'];
    for (const name of events) {
      this.#transport.addEventListener(name, (e) => {
        if (name === 'connected') this.#connected = true;
        if (name === 'disconnected') this.#connected = false;
        this.dispatchEvent(new CustomEvent(name, { detail: e.detail }));
      });
    }
  }
}
