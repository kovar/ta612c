/**
 * protocol.js — TA612C binary protocol: frame building, parsing, checksum.
 *
 * Frame structure (all directions):
 *   Header (2 bytes) | Command (1 byte) | Length (1 byte) | Payload | Checksum (1 byte)
 *
 * PC → Device header: 0xAA 0x55
 * Device → PC header: 0x55 0xAA
 *
 * Checksum = low byte of sum of ALL preceding bytes in the frame.
 * Length = total bytes after the header, including the length byte itself.
 */

/** Pre-built command frames (PC → Device) */
export const COMMANDS = {
  START_REALTIME: new Uint8Array([0xAA, 0x55, 0x01, 0x03, 0x03]),
  STOP:           new Uint8Array([0xAA, 0x55, 0x00, 0x03, 0x02]),
  START_LOGGED:   new Uint8Array([0xAA, 0x55, 0x02, 0x03, 0x04]),
};

/**
 * Calculate checksum: low byte of sum of all bytes.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function calcChecksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum += bytes[i];
  return sum & 0xFF;
}

/**
 * Build a time-sync command frame.
 * Payload: 7 BCD-encoded bytes: year(2), month, day, hour, minute, second
 * @param {Date} date
 * @returns {Uint8Array}
 */
export function buildTimeSync(date) {
  const bcd = (n) => ((Math.floor(n / 10) << 4) | (n % 10)) & 0xFF;
  const year = date.getFullYear();
  const payload = [
    bcd(Math.floor(year / 100)), // century
    bcd(year % 100),             // year
    bcd(date.getMonth() + 1),    // month
    bcd(date.getDate()),         // day
    bcd(date.getHours()),        // hour
    bcd(date.getMinutes()),      // minute
    bcd(date.getSeconds()),      // second
  ];
  // Length = total bytes after the 2-byte header (cmd + len + payload + checksum).
  // Verified against STOP (len=3) and realtime response (len=0x0B=11).
  const frame = new Uint8Array(2 + 1 + 1 + payload.length + 1);
  frame[0] = 0xAA;
  frame[1] = 0x55;
  frame[2] = 0x03; // time sync command
  frame[3] = 1 + 1 + payload.length + 1; // length: cmd + len + payload + checksum
  for (let i = 0; i < payload.length; i++) frame[4 + i] = payload[i];
  frame[frame.length - 1] = calcChecksum(frame.subarray(0, frame.length - 1));
  return frame;
}

/**
 * Try to parse a complete frame from a buffer.
 * Scans for device→PC header (0x55, 0xAA).
 * @param {Uint8Array} buffer
 * @returns {{ frame: { command: number, payload: Uint8Array } | null, remaining: Uint8Array }}
 */
export function parseFrame(buffer) {
  // Scan for header 0x55 0xAA
  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i] === 0x55 && buffer[i + 1] === 0xAA) {
      // Found header at position i
      if (i + 3 >= buffer.length) {
        // Not enough bytes for cmd + length yet — keep from header onwards
        return { frame: null, remaining: buffer.slice(i) };
      }
      const cmd = buffer[i + 2];
      const frameLen = buffer[i + 3]; // total bytes after the 2-byte header
      const totalLen = 2 + frameLen; // header + everything after
      if (i + totalLen > buffer.length) {
        // Incomplete frame — keep from header onwards
        return { frame: null, remaining: buffer.slice(i) };
      }
      // Validate checksum (sum of all bytes except last)
      const frameBytes = buffer.slice(i, i + totalLen);
      const expected = calcChecksum(frameBytes.subarray(0, frameBytes.length - 1));
      const actual = frameBytes[frameBytes.length - 1];
      if (expected !== actual) {
        // Bad checksum — skip this header byte and try again
        continue;
      }
      // Extract payload: between length byte and checksum
      const payload = frameBytes.slice(4, frameBytes.length - 1);
      return {
        frame: { command: cmd, payload },
        remaining: buffer.slice(i + totalLen),
      };
    }
  }
  // No header found — keep last byte in case it's start of header
  if (buffer.length > 0 && buffer[buffer.length - 1] === 0x55) {
    return { frame: null, remaining: buffer.slice(buffer.length - 1) };
  }
  return { frame: null, remaining: new Uint8Array(0) };
}

// Readings outside this range indicate an open/disconnected thermocouple.
// All thermocouple types max out below 1820°C (R/S/B-type); the device
// reports ~2800°C as its open-circuit sentinel.
const OL_MAX =  2000;  // °C
const OL_MIN = -300;   // °C

/**
 * Parse real-time data payload (command 0x01).
 * 4 × 16-bit LE values, each divided by 10 for temperature in °C.
 * Returns null for channels outside the valid range (open/disconnected).
 * @param {Uint8Array} payload — 8 bytes
 * @returns {{ channels: [number|null, number|null, number|null, number|null] }}
 */
export function parseRealtimeData(payload) {
  if (payload.length < 8) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const channels = [];
  for (let i = 0; i < 4; i++) {
    const raw = view.getInt16(i * 2, true); // signed 16-bit LE
    const temp = raw / 10;
    channels.push(temp >= OL_MIN && temp <= OL_MAX ? temp : null);
  }
  return { channels };
}

/**
 * Parse model/version payload (command 0x00).
 * @param {Uint8Array} payload — 4 bytes
 * @returns {{ model: number, version: string }}
 */
export function parseModelVersion(payload) {
  if (payload.length < 4) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const model = view.getUint16(0, true);
  const versionRaw = view.getUint16(2, true);
  const version = `V${(versionRaw / 100).toFixed(2)}`;
  return { model, version };
}

/**
 * Parse record data payload (command 0x02).
 * Groups of 4 × 16-bit LE channel values.
 * @param {Uint8Array} payload
 * @returns {{ records: Array<[number, number, number, number]> }}
 */
export function parseRecordData(payload) {
  const records = [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  // Each record is 8 bytes (4 channels × 2 bytes)
  const recordSize = 8;
  for (let offset = 0; offset + recordSize <= payload.length; offset += recordSize) {
    const channels = [];
    for (let ch = 0; ch < 4; ch++) {
      const raw = view.getInt16(offset + ch * 2, true);
      channels.push(raw / 10);
    }
    records.push(channels);
  }
  return { records };
}
