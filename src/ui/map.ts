import type { RadarFrame } from '../protocol/types.ts';

export const TARGET_COLORS = ['#22d3ee', '#a78bfa', '#f472b6'] as const;

interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

const TRAIL_AGE_MS = 15_000;
const TRAIL_MAX = 220;
const LABEL_COLOR = '#5b6478';
const GRID_COLOR = '#1a2130';
const AXIS_COLOR = '#2a3344';
const FOV_COLOR = 'rgba(34, 211, 238, 0.05)';
const FOV_EDGE = 'rgba(34, 211, 238, 0.22)';

export class RadarMap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private trails: TrailPoint[][] = [[], [], []];
  private lastFrame: RadarFrame | null = null;
  private rangeM = 8;
  private invertX = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
  }

  setRange(rangeM: number): void {
    this.rangeM = rangeM;
  }

  setInvertX(invert: boolean): void {
    this.invertX = invert;
  }

  clearTrails(): void {
    this.trails = [[], [], []];
  }

  reset(): void {
    this.lastFrame = null;
    this.clearTrails();
  }

  addFrame(frame: RadarFrame): void {
    this.lastFrame = frame;
    for (let i = 0; i < frame.targets.length; i++) {
      const target = frame.targets[i];
      if (!target.active) continue;
      const trail = this.trails[i];
      trail.push({ x: target.xMm / 1000, y: target.yMm / 1000, t: frame.receivedAt });
      while (trail.length > TRAIL_MAX) trail.shift();
      while (trail.length > 0 && frame.receivedAt - trail[0].t > TRAIL_AGE_MS) trail.shift();
    }
  }

  render(now = performance.now()): void {
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) return;
    const pxWidth = Math.round(width * dpr);
    const pxHeight = Math.round(height * dpr);
    if (this.canvas.width !== pxWidth || this.canvas.height !== pxHeight) {
      this.canvas.width = pxWidth;
      this.canvas.height = pxHeight;
    }

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0d1118';
    ctx.fillRect(0, 0, width, height);

    const range = this.rangeM;
    const pad = 34;
    const scale = Math.min((width - pad * 2) / (range * 2), (height - pad * 2) / range);
    const usedHeight = range * scale;
    const cx = width / 2;
    const top = (height - usedHeight) / 2;
    const cy = top + usedHeight;

    const toPx = (xM: number, yM: number): [number, number] => {
      const plotX = this.invertX ? -xM : xM;
      return [cx + plotX * scale, cy - yM * scale];
    };

    // Detection wedge (±60° around forward).
    const startAngle = -Math.PI / 2 - Math.PI / 3;
    const endAngle = -Math.PI / 2 + Math.PI / 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, range * scale, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = FOV_COLOR;
    ctx.fill();

    // Range rings.
    ctx.lineWidth = 1;
    ctx.strokeStyle = GRID_COLOR;
    const ringStep = range <= 2 ? 0.5 : range <= 4 ? 1 : 2;
    for (let r = ringStep; r <= range + 0.001; r += ringStep) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * scale, startAngle, endAngle);
      ctx.stroke();
    }

    // Radial FOV lines.
    ctx.strokeStyle = AXIS_COLOR;
    for (const deg of [-60, -30, 0, 30, 60]) {
      const angle = (-90 + deg) * (Math.PI / 180);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * range * scale, cy + Math.sin(angle) * range * scale);
      ctx.stroke();
    }

    // Wedge edges.
    ctx.strokeStyle = FOV_EDGE;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(startAngle) * range * scale, cy + Math.sin(startAngle) * range * scale);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(endAngle) * range * scale, cy + Math.sin(endAngle) * range * scale);
    ctx.stroke();

    // Sensor symbol.
    ctx.fillStyle = '#22d3ee';
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.4)';
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.stroke();

    // Range labels along the centre line.
    ctx.fillStyle = LABEL_COLOR;
    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let r = ringStep; r <= range + 0.001; r += ringStep) {
      const [, y] = toPx(0, r);
      ctx.fillText(`${r.toFixed(r < 1 ? 1 : 0)} m`, cx + 6, y);
    }
    ctx.textAlign = 'center';
    ctx.fillText('Y forward', cx, cy - usedHeight - 10);
    ctx.fillText('X', width - 18, cy - 12);

    // Trails, oldest faded.
    for (let i = 0; i < this.trails.length; i++) {
      const trail = this.trails[i];
      if (trail.length < 2) continue;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      for (let j = 1; j < trail.length; j++) {
        const age = now - trail[j].t;
        if (age > TRAIL_AGE_MS) continue;
        const alpha = Math.max(0.05, 1 - age / TRAIL_AGE_MS) * (0.25 + (j / trail.length) * 0.75);
        const [x0, y0] = toPx(trail[j - 1].x, trail[j - 1].y);
        const [x1, y1] = toPx(trail[j].x, trail[j].y);
        ctx.strokeStyle = this.withAlpha(TARGET_COLORS[i], alpha);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }

    // Targets.
    if (this.lastFrame) {
      for (let i = 0; i < this.lastFrame.targets.length; i++) {
        const target = this.lastFrame.targets[i];
        if (!target.active) continue;
        const [x, y] = toPx(target.xMm / 1000, target.yMm / 1000);
        const distanceM = Math.hypot(target.xMm, target.yMm) / 1000;
        const color = TARGET_COLORS[i];

        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = '#e6fefd';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#e6fefd';
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();

        const label = `T${i + 1}  ${distanceM.toFixed(2)} m`;
        ctx.font = '600 11px -apple-system, Segoe UI, sans-serif';
        const textWidth = ctx.measureText(label).width;
        const labelX = Math.min(width - textWidth - 8, Math.max(8, x + 10));
        const labelY = Math.min(height - 8, Math.max(14, y - 10));
        ctx.fillStyle = 'rgba(10, 13, 19, 0.82)';
        ctx.fillRect(labelX - 4, labelY - 11, textWidth + 8, 16);
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, labelX, labelY - 3);
      }
    }

    // Scale bar.
    const barMeters = range <= 2 ? 1 : range <= 4 ? 1 : 2;
    const barPx = barMeters * scale;
    const bx = 14;
    const by = height - 16;
    ctx.strokeStyle = '#8a94a6';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + barPx, by);
    ctx.moveTo(bx, by - 4);
    ctx.lineTo(bx, by + 4);
    ctx.moveTo(bx + barPx, by - 4);
    ctx.lineTo(bx + barPx, by + 4);
    ctx.stroke();
    ctx.fillStyle = '#8a94a6';
    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${barMeters} m`, bx, by - 6);
  }

  private withAlpha(hex: string, alpha: number): string {
    const value = hex.replace('#', '');
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
  }
}