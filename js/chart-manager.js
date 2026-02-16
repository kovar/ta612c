/**
 * ChartManager — 4-channel temperature chart using Chart.js with time axis.
 */

const CHANNEL_COLORS = [
  { border: '#e74c3c', fill: 'rgba(231,76,60,0.08)' },   // Ch1 — red
  { border: '#3498db', fill: 'rgba(52,152,219,0.08)' },   // Ch2 — blue
  { border: '#2ecc71', fill: 'rgba(46,204,113,0.08)' },   // Ch3 — green
  { border: '#e67e22', fill: 'rgba(230,126,34,0.08)' },   // Ch4 — orange
];

export class ChartManager {
  #chart = null;
  #datasets = [[], [], [], []]; // shared data arrays per channel
  #timeWindow = 300; // seconds

  constructor(canvas) {
    const ctx = canvas.getContext('2d');
    this.#chart = new Chart(ctx, {
      type: 'line',
      data: {
        datasets: CHANNEL_COLORS.map((color, i) => ({
          label: `T${i + 1}`,
          data: this.#datasets[i],
          borderColor: color.border,
          backgroundColor: color.fill,
          borderWidth: 2,
          pointRadius: 1,
          pointHoverRadius: 5,
          tension: 0.1,
          fill: false,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            type: 'time',
            time: {
              unit: 'second',
              displayFormats: { second: 'HH:mm:ss' },
            },
            title: { display: true, text: 'Time' },
          },
          y: {
            title: { display: true, text: 'Temperature (\u00B0C)' },
            beginAtZero: false,
          },
        },
        plugins: {
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} \u00B0C`,
            },
          },
          legend: {
            display: true,
            position: 'top',
          },
        },
        animation: false,
      },
    });
  }

  /**
   * Add a reading for all 4 channels.
   * @param {number[]} channels — array of 4 temperature values
   */
  addReading(channels) {
    const now = new Date();
    for (let i = 0; i < 4; i++) {
      const v = channels[i];
      if (typeof v === 'number' && !isNaN(v)) {
        this.#datasets[i].push({ x: now, y: v });
      }
    }
    this.#prune(now);
    this.#chart.update('none');
  }

  clear() {
    for (const ds of this.#datasets) ds.length = 0;
    this.#chart.update();
  }

  setTimeWindow(seconds) {
    this.#timeWindow = seconds;
    this.#prune(new Date());
    this.#chart.update();
  }

  setYRange(min, max) {
    const yScale = this.#chart.options.scales.y;
    if (min !== null && min !== undefined && min !== '') {
      yScale.min = parseFloat(min);
    } else {
      delete yScale.min;
    }
    if (max !== null && max !== undefined && max !== '') {
      yScale.max = parseFloat(max);
    } else {
      delete yScale.max;
    }
    this.#chart.update();
  }

  resetZoom() {
    delete this.#chart.options.scales.y.min;
    delete this.#chart.options.scales.y.max;
    this.#chart.update();
  }

  destroy() {
    if (this.#chart) {
      this.#chart.destroy();
      this.#chart = null;
    }
  }

  #prune(now) {
    const cutoff = now.getTime() - this.#timeWindow * 1000;
    for (const ds of this.#datasets) {
      while (ds.length > 0 && ds[0].x.getTime() < cutoff) {
        ds.shift();
      }
    }
  }
}
