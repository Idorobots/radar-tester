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
            ticks: { color: '#5b6478', font: { size: 9 }, maxTicksLimit: 7, callback: (value) => `${value}s` },
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
    for (let i = 0; i < frame.targets.length; i++) {
      const target = frame.targets[i];
      if (!target.active) continue;
      const samples = this.data[i];
      samples.push({ x: sessionT, y: Math.hypot(target.xMm, target.yMm) / 1000 });
      while (samples.length > MAX_POINTS || (samples.length > 0 && samples[0].x < sessionT - WINDOW_S)) {
        samples.shift();
      }
    }
  }

  update(force = false): void {
    if (!force && this.lastT - this.lastUpdate < 0.25) return;
    this.lastUpdate = this.lastT;
    const min = Math.max(0, this.lastT - WINDOW_S);
    this.chart.options.scales!.x!.min = min;
    this.chart.options.scales!.x!.max = Math.max(WINDOW_S, this.lastT);
    this.chart.update('none');
  }

  reset(): void {
    this.data[0].length = 0;
    this.data[1].length = 0;
    this.data[2].length = 0;
    this.lastT = 0;
    this.lastUpdate = 0;
    this.chart.options.scales!.x!.min = 0;
    this.chart.options.scales!.x!.max = WINDOW_S;
    this.chart.update('none');
  }
}