/**
 * Recorder — records timestamped 4-channel thermocouple readings and exports as CSV.
 */
export class Recorder {
  #data = [];
  #recording = false;

  get isRecording() {
    return this.#recording;
  }

  get count() {
    return this.#data.length;
  }

  start() {
    this.#data = [];
    this.#recording = true;
  }

  stop() {
    this.#recording = false;
  }

  /**
   * @param {number[]} channels — array of 4 temperature values
   */
  addReading(channels) {
    if (!this.#recording) return;
    this.#data.push({
      timestamp: new Date().toISOString(),
      channels: [...channels],
    });
  }

  download() {
    if (this.#data.length === 0) return false;
    const header = 'Timestamp,T1,T2,T3,T4\n';
    const rows = this.#data.map(r =>
      `${r.timestamp},${r.channels.map(v => v ?? '').join(',')}`
    ).join('\n');
    const csv = header + rows + '\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ts = new Date().toISOString().replace(/[:\-]/g, '').replace(/\..+/, '');
    a.download = `thermocouple_reading_${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  }
}
