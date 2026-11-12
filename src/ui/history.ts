import { Chart } from 'chart.js/auto';
import type { RadarFrame } from '../protocol/types.ts';
import { TARGET_COLORS } from './map.ts';

interface Sample {
  x: number;
  y: number;
}

const WINDOW_S = 60;
const MAX_POINTS = 700;

export class DistanceHistory {
  private readonly chart: Chart;
  private readonly data: Sample[][] = [[], [], []];
  private lastUpdate = 0;
  private lastT = 0;
  private windowStart = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.chart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: TARGET_COLORS.map((color, index) => ({
          label: `T${index + 1}`,
          data: this.data[index],
          borderColor: color,
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 0,
          pointHitRadius: 6,
          tension: 0.25,
          spanGaps: false,
          parsing: false,
          normalized: true,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        normalized: true,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: {
            labels: {
              color: '#8a94a6',
              boxWidth: 9,
              boxHeight: 9,
              font: { size: 10 },
            },
          },
          tooltip: {
            backgroundColor: '#11151d',
            borderColor: '#2a3344',
            borderWidth: 1,
            titleColor: '#e6eaf2',
            bodyColor: '#8a94a6',
            callbacks: {
              title: (items) => (items.length > 0 ? `${Math.round(Number(items[0].parsed.x))}s` : ''),
              label: (context) => `${context.dataset.label}: ${Number(context.parsed.y).toFixed(2)} m`,
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: 0,
            max: WINDOW_S,
            grid: { color: '#1a2130' },
            border: { color: '#2a3344' },
            ticks: {
              color: '#5b6478',
              font: { size: 9 },
              maxTicksLimit: 7,
              precision: 0,
              stepSize: 10,
              callback: (value) => `${Math.round(Number(value))}s`,
            },
          },
          y: {
            beginAtZero: true,
            suggestedMax: 8,
            grid: { color: '#1a2130' },
            border: { color: '#2a3344' },
            ticks: { color: '#5b6478', font: { size: 9 }, maxTicksLimit: 5, callback: (value) => `${value}m` },
          },
        },
      },
    });
  }

  push(frame: RadarFrame, sessionT: number): void {
    this.lastT = sessionT;
    // Keep the x axis anchored to "now" at 60 s so labels stay clean
    // (0s … 60s) even though samples are captured in session time.
    const windowStart = Math.max(0, sessionT - WINDOW_S);
    const delta = windowStart - this.windowStart;
    if (delta !== 0) {
      this.windowStart = windowStart;
      for (const samples of this.data) {
        for (const sample of samples) sample.x -= delta;
      }
    }

    for (let i = 0; i < frame.targets.length; i++) {
      const target = frame.targets[i];
      if (!target.active) continue;
      this.data[i].push({
        x: sessionT - this.windowStart,
        y: Math.hypot(target.xMm, target.yMm) / 1000,
      });
    }

    for (const samples of this.data) {
      while (samples.length > MAX_POINTS || (samples.length > 0 && samples[0].x < 0)) {
        samples.shift();
      }
    }
  }

  update(force = false): void {
    if (!force && this.lastT - this.lastUpdate < 0.25) return;
    this.lastUpdate = this.lastT;
    this.chart.options.scales!.x!.min = 0;
    this.chart.options.scales!.x!.max = WINDOW_S;
    this.chart.update('none');
  }

  reset(): void {
    this.data[0].length = 0;
    this.data[1].length = 0;
    this.data[2].length = 0;
    this.lastT = 0;
    this.lastUpdate = 0;
    this.windowStart = 0;
    this.chart.options.scales!.x!.min = 0;
    this.chart.options.scales!.x!.max = WINDOW_S;
    this.chart.update('none');
  }
}