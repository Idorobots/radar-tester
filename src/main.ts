import './style.css';
import type { RadarFrame, RadarTarget, SensorInfo } from './protocol/types.ts';
import { Ld2450Parser } from './protocol/parser.ts';
import { StreamSniffer } from './protocol/sniffer.ts';
import { CommandClient } from './protocol/commands.ts';
import { BAUD_RATES } from './protocol/encode.ts';
import { BRIDGE_FILTERS, DEFAULT_BAUD, SerialSource } from './serial/connection.ts';
import type { SerialPortInfoLite } from './serial/connection.ts';
import { BleSource } from './serial/ble.ts';
import type { BleInfo } from './serial/ble.ts';
import { DeviceSimSource } from './sim/deviceSim.ts';
import { RadarMap } from './ui/map.ts';
import { DistanceHistory } from './ui/history.ts';
import { evaluateHealth } from './ui/health.ts';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const dom = {
  baud: el<HTMLSelectElement>('baud'),
  statusPill: el<HTMLDivElement>('statusPill'),
  statusText: el<HTMLSpanElement>('statusText'),
  btnConnect: el<HTMLButtonElement>('btnConnect'),
  btnConnectAll: el<HTMLButtonElement>('btnConnectAll'),
  btnBle: el<HTMLButtonElement>('btnBle'),
  btnSim: el<HTMLButtonElement>('btnSim'),
  btnPause: el<HTMLButtonElement>('btnPause'),
  btnExport: el<HTMLButtonElement>('btnExport'),
  banner: el<HTMLDivElement>('banner'),
  mapRange: el<HTMLSelectElement>('mapRange'),
  invertX: el<HTMLInputElement>('invertX'),
  btnClearTrails: el<HTMLButtonElement>('btnClearTrails'),
  mapScale: el<HTMLElement>('mapScale'),
  mapEmpty: el<HTMLDivElement>('mapEmpty'),
  chartDistance: el<HTMLCanvasElement>('chartDistance'),
  targetCountBadge: el<HTMLSpanElement>('targetCountBadge'),
  roTracked: el<HTMLElement>('roTracked'),
  roMoving: el<HTMLElement>('roMoving'),
  roStill: el<HTMLElement>('roStill'),
  hz: el<HTMLElement>('hz'),
  frames: el<HTMLElement>('frames'),
  badFooters: el<HTMLElement>('badFooters'),
  garbage: el<HTMLElement>('garbage'),
  lastAge: el<HTMLElement>('lastAge'),
  uptime: el<HTMLElement>('uptime'),
  healthBadge: el<HTMLSpanElement>('healthBadge'),
  healthHint: el<HTMLParagraphElement>('healthHint'),
  btnQueryInfo: el<HTMLButtonElement>('btnQueryInfo'),
  fwVersion: el<HTMLElement>('fwVersion'),
  macAddress: el<HTMLElement>('macAddress'),
  targetMode: el<HTMLElement>('targetMode'),
  protocol: el<HTMLElement>('protocol'),
  setMode: el<HTMLSelectElement>('setMode'),
  setBluetooth: el<HTMLSelectElement>('setBluetooth'),
  setBaud: el<HTMLSelectElement>('setBaud'),
  btnApplyMode: el<HTMLButtonElement>('btnApplyMode'),
  btnApplyBluetooth: el<HTMLButtonElement>('btnApplyBluetooth'),
  btnApplyBaud: el<HTMLButtonElement>('btnApplyBaud'),
  btnRestart: el<HTMLButtonElement>('btnRestart'),
  settingsHint: el<HTMLParagraphElement>('settingsHint'),
  diagSummary: el<HTMLSpanElement>('diagSummary'),
  diagBytes: el<HTMLElement>('diagBytes'),
  diagRate: el<HTMLElement>('diagRate'),
  diagAa: el<HTMLElement>('diagAa'),
  diagFd: el<HTMLElement>('diagFd'),
  diagAcks: el<HTMLElement>('diagAcks'),
  diagResync: el<HTMLElement>('diagResync'),
  hexDump: el<HTMLElement>('hexDump'),
  btnDiag: el<HTMLButtonElement>('btnDiag'),
};

const targetDom = [0, 1, 2].map((index) => ({
  badge: el<HTMLSpanElement>(`t${index + 1}Badge`),
  x: el<HTMLElement>(`t${index + 1}x`),
  y: el<HTMLElement>(`t${index + 1}y`),
  distance: el<HTMLElement>(`t${index + 1}d`),
  angle: el<HTMLElement>(`t${index + 1}a`),
  speed: el<HTMLElement>(`t${index + 1}s`),
  resolution: el<HTMLElement>(`t${index + 1}r`),
  direction: el<HTMLElement>(`t${index + 1}dir`),
}));

interface LogRow {
  t: number;
  targets: Array<{ x: number; y: number; speed: number; distance: number; resolution: number; active: boolean }>;
}

type SourceKind = 'serial' | 'ble' | 'sim';

const LOG_CAP = 100_000;

let source: SourceKind | null = null;
let paused = false;
let sessionStart = performance.now();
let frameTimes: number[] = [];
let byteTimes: number[] = [];
let lastFrameAt: number | null = null;
let lastFrame: RadarFrame | null = null;
let log: LogRow[] = [];
let logTruncated = false;
let querying = false;
let applying = false;
let sensorInfo: SensorInfo = { firmware: null, mac: null, targetMode: null, bluetooth: null };

const sniffer = new StreamSniffer();
const map = new RadarMap(el<HTMLCanvasElement>('mapCanvas'));
const history = new DistanceHistory(dom.chartDistance);

let commandClient: CommandClient | null = null;

const serial = new SerialSource({
  onData: ingest,
  onOpen: (info) => onSourceOpen('serial', info),
  onClose: (error) => onSourceClose(error),
});

const ble = new BleSource({
  onData: ingest,
  onOpen: (info) => onSourceOpen('ble', info),
  onClose: (error) => onSourceClose(error),
});

const sim = new DeviceSimSource({
  onData: ingest,
  onOpen: () => onSourceOpen('sim', null),
  onClose: (error) => onSourceClose(error),
});

const parser = new Ld2450Parser({
  onFrame: handleFrame,
  onAck: (ack) => commandClient?.handleAck(ack),
});

function ingest(data: Uint8Array): void {
  sniffer.feed(data);
  byteTimes.push(performance.now());
  parser.feed(data);
}

function handleFrame(frame: RadarFrame): void {
  lastFrame = frame;
  lastFrameAt = performance.now();
  frameTimes.push(lastFrameAt);
  dom.mapEmpty.classList.add('hidden');
  if (paused) return;
  map.addFrame(frame);
  const sessionT = (lastFrameAt - sessionStart) / 1000;
  history.push(frame, sessionT);
  appendLog(frame, sessionT);
}

function appendLog(frame: RadarFrame, sessionT: number): void {
  log.push({
    t: sessionT,
    targets: frame.targets.map((target) => ({
      x: target.xMm,
      y: target.yMm,
      speed: target.speedCms,
      distance: Math.round(Math.hypot(target.xMm, target.yMm)),
      resolution: target.resolutionMm,
      active: target.active,
    })),
  });
  if (log.length >= LOG_CAP) {
    log.shift();
    logTruncated = true;
  }
}

function resetSession(): void {
  parser.reset();
  sniffer.reset();
  frameTimes = [];
  byteTimes = [];
  lastFrameAt = null;
  lastFrame = null;
  log = [];
  logTruncated = false;
  sessionStart = performance.now();
  map.reset();
  history.reset();
  dom.hexDump.textContent = 'no bytes received';
  dom.btnDiag.disabled = true;
  dom.mapEmpty.classList.remove('hidden');
  dom.mapEmpty.textContent = 'Waiting for the first LD2450 frame…';
}

function setPill(className: string, text: string): void {
  dom.statusPill.className = `pill ${className}`;
  dom.statusText.textContent = text;
}

function hex4(value: number | undefined): string {
  return value === undefined ? '----' : value.toString(16).toUpperCase().padStart(4, '0');
}

function onSourceOpen(kind: SourceKind, info: SerialPortInfoLite | BleInfo | null): void {
  source = kind;
  paused = false;
  sensorInfo = { firmware: null, mac: null, targetMode: null, bluetooth: null };
  dom.btnPause.textContent = 'Pause';
  resetSession();
  renderSensorInfo();
  hideBanner();

  if (kind === 'serial') {
    const serialInfo = info as SerialPortInfoLite | null;
    const label =
      serialInfo?.bluetoothServiceClassId !== undefined
        ? 'Connected · Bluetooth SPP'
        : serialInfo?.usbVendorId !== undefined
          ? `Connected · VID ${hex4(serialInfo.usbVendorId)} PID ${hex4(serialInfo.usbProductId)}`
          : 'Connected · Serial';
    setPill('pill-live', label);
  } else if (kind === 'ble') {
    const bleInfo = info as BleInfo;
    setPill('pill-live', bleInfo.deviceName ? `Connected · BLE ${bleInfo.deviceName}` : 'Connected · BLE');
    dom.settingsHint.textContent = `BLE profile: ${bleInfo.serviceLabel}`;
  } else {
    setPill('pill-sim', 'Simulated LD2450 running');
  }

  dom.btnConnect.textContent = kind === 'sim' ? 'Connect device' : 'Disconnect';
  dom.btnConnect.disabled = kind === 'sim';
  dom.btnConnectAll.disabled = true;
  dom.btnBle.disabled = true;
  dom.btnSim.disabled = kind !== 'sim';
  dom.btnSim.textContent = kind === 'sim' ? 'Stop simulator' : 'Simulate';
  dom.baud.disabled = true;
  dom.btnPause.disabled = false;
  dom.btnClearTrails.disabled = false;
  dom.btnQueryInfo.disabled = false;
  dom.btnRestart.disabled = false;
  updateControlStates();
  setSettingsHint('Querying sensor information…');
  void querySensorInfo();
}

function onSourceClose(error?: string): void {
  const wasSim = source === 'sim';
  source = null;
  commandClient?.dispose();
  paused = false;
  dom.btnPause.textContent = 'Pause';
  dom.btnPause.disabled = true;
  dom.btnClearTrails.disabled = true;
  dom.btnQueryInfo.disabled = true;
  dom.btnApplyMode.disabled = true;
  dom.btnApplyBluetooth.disabled = true;
  dom.btnApplyBaud.disabled = true;
  dom.btnRestart.disabled = true;
  dom.baud.disabled = false;
  dom.btnConnect.textContent = 'Connect device';
  dom.btnConnect.disabled = !serialSupported();
  dom.btnConnectAll.disabled = !serialSupported();
  dom.btnBle.disabled = !bleSupported();
  dom.btnSim.disabled = false;
  dom.btnSim.textContent = 'Simulate';
  dom.btnExport.disabled = log.length === 0;
  setPill('pill-off', 'Disconnected');
  if (error) {
    showBanner(`Connection lost: ${error}`);
    dom.settingsHint.textContent = 'Reconnect to query or configure the sensor.';
  } else {
    hideBanner();
    dom.settingsHint.textContent = wasSim
      ? 'Simulator stopped. Press Simulate to start it again.'
      : 'Changing the sensor baud or Bluetooth state restarts its UART / radio.';
  }
}

function serialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator && navigator.serial !== undefined;
}

function bleSupported(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator && navigator.bluetooth !== undefined;
}

function showBanner(text: string): void {
  dom.banner.textContent = text;
  dom.banner.classList.remove('hidden');
}

function hideBanner(): void {
  dom.banner.classList.add('hidden');
}

function setSettingsHint(text: string): void {
  dom.settingsHint.textContent = text;
}

function updateControlStates(): void {
  const connected = source !== null;
  const busy = querying || applying;
  dom.btnQueryInfo.disabled = !connected || busy;
  dom.btnApplyMode.disabled = !connected || busy;
  dom.btnApplyBluetooth.disabled = !connected || busy;
  dom.btnApplyBaud.disabled = !connected || busy;
  dom.btnRestart.disabled = !connected || busy;
}

/* ---------- readouts ---------- */

function setBadge(element: HTMLElement, text: string, className: string): void {
  element.className = `badge ${className}`;
  element.textContent = text;
}

function signedM(mm: number): string {
  return `${mm >= 0 ? '+' : ''}${(mm / 1000).toFixed(2)} m`;
}

function targetAngle(target: RadarTarget): number {
  return (Math.atan2(target.xMm, target.yMm) * 180) / Math.PI;
}

function updateTargetReadouts(): void {
  let tracked = 0;
  let moving = 0;
  let still = 0;

  for (let i = 0; i < targetDom.length; i++) {
    const ui = targetDom[i];
    const target = lastFrame?.targets[i];
    if (!target?.active) {
      ui.x.textContent = '—';
      ui.y.textContent = '—';
      ui.distance.textContent = '—';
      ui.angle.textContent = '—';
      ui.speed.textContent = '—';
      ui.resolution.textContent = '—';
      ui.direction.textContent = lastFrame ? 'no target in view' : 'waiting for frames';
      setBadge(ui.badge, 'no target', 'badge-off');
      continue;
    }

    tracked++;
    const isMoving = target.speedCms !== 0;
    if (isMoving) moving++;
    else still++;
    const distance = Math.hypot(target.xMm, target.yMm);
    ui.x.textContent = signedM(target.xMm);
    ui.y.textContent = signedM(target.yMm);
    ui.distance.textContent = `${(distance / 1000).toFixed(2)} m`;
    ui.angle.textContent = `${targetAngle(target).toFixed(1)}°`;
    ui.speed.textContent = `${target.speedCms} cm/s`;
    ui.resolution.textContent = `${target.resolutionMm} mm`;
    if (target.speedCms > 0) ui.direction.textContent = 'moving away from sensor';
    else if (target.speedCms < 0) ui.direction.textContent = 'approaching sensor';
    else ui.direction.textContent = 'stationary';
    setBadge(ui.badge, isMoving ? 'moving' : 'still', isMoving ? 'badge-ok' : 'badge-warn');
  }

  dom.roTracked.textContent = String(tracked);
  dom.roMoving.textContent = String(moving);
  dom.roStill.textContent = String(still);
  setBadge(
    dom.targetCountBadge,
    `${tracked} / 3`,
    tracked > 0 ? 'badge-ok' : lastFrame ? 'badge-off' : 'badge-off',
  );
}

function updateHealth(hz: number): void {
  const now = performance.now();
  const lastAgeMs = lastFrameAt === null ? null : now - lastFrameAt;
  const verdict = evaluateHealth({
    connected: source !== null,
    hz,
    framesTotal: parser.stats.frames,
    lastFrame,
    lastAgeMs,
    totalBytes: sniffer.stats.totalBytes,
    bytesPerSec: byteTimes.length,
    garbageBytes: parser.stats.garbageBytes,
    badFooters: parser.stats.badFooters,
  });
  setBadge(dom.healthBadge, verdict.label, `badge-${verdict.level}`);
  dom.healthHint.textContent = verdict.hint;
}

function formatUptime(totalSeconds: number): string {
  const seconds = Math.floor(totalSeconds);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}:${rest.toString().padStart(2, '0')}`;
  return `${Math.floor(minutes / 60)}:${(minutes % 60).toString().padStart(2, '0')}:${rest
    .toString()
    .padStart(2, '0')}`;
}

/* ---------- main update loop ---------- */

function updateUi(): void {
  const now = performance.now();
  frameTimes = frameTimes.filter((time) => now - time <= 1000);
  byteTimes = byteTimes.filter((time) => now - time <= 1000);
  const hz = frameTimes.length;
  const lastAgeMs = lastFrameAt === null ? null : now - lastFrameAt;

  dom.hz.textContent = hz.toFixed(0);
  dom.frames.textContent = parser.stats.frames.toLocaleString();
  dom.badFooters.textContent = parser.stats.badFooters.toLocaleString();
  dom.garbage.textContent = `${parser.stats.garbageBytes.toLocaleString()} B`;
  dom.lastAge.textContent = lastAgeMs === null ? '—' : lastAgeMs < 1000 ? `${lastAgeMs.toFixed(0)} ms` : `${(lastAgeMs / 1000).toFixed(1)} s`;
  dom.uptime.textContent = source === null ? '—' : formatUptime((now - sessionStart) / 1000);
  dom.protocol.textContent = parser.stats.frames > 0 ? 'LD2450 · 30 B' : '—';

  updateTargetReadouts();
  updateHealth(hz);

  dom.diagBytes.textContent = sniffer.stats.totalBytes.toLocaleString();
  dom.diagRate.textContent = `${byteTimes.length} B/s`;
  dom.diagAa.textContent = sniffer.stats.aaBytes.toLocaleString();
  dom.diagFd.textContent = sniffer.stats.fdBytes.toLocaleString();
  dom.diagAcks.textContent = parser.stats.ackFrames.toLocaleString();
  dom.diagResync.textContent = parser.stats.resyncs.toLocaleString();
  dom.diagSummary.textContent =
    sniffer.stats.totalBytes === 0
      ? 'idle'
      : `${parser.stats.frames.toLocaleString()} frames · ${byteTimes.length} B/s`;
  if (sniffer.stats.totalBytes > 0) {
    dom.hexDump.textContent = sniffer.hexDump();
    dom.btnDiag.disabled = false;
  }

  dom.btnExport.disabled = log.length === 0;
  history.update();
}

function animateMap(): void {
  map.render(paused && lastFrameAt !== null ? lastFrameAt : performance.now());
  requestAnimationFrame(animateMap);

const params = new URLSearchParams(window.location.search);
if (params.get('simulate') === '1' || params.has('sim')) {
  window.setTimeout(() => {
    if (source === null) toggleSim();
  }, 100);
}
}

/* ---------- sensor information & settings ---------- */

function renderSensorInfo(): void {
  dom.fwVersion.textContent = sensorInfo.firmware ?? '—';
  dom.macAddress.textContent = sensorInfo.mac ?? '—';
  dom.targetMode.textContent =
    sensorInfo.targetMode === null ? '—' : sensorInfo.targetMode === 'single' ? 'Single-target' : 'Multi-target';
  if (sensorInfo.targetMode) dom.setMode.value = sensorInfo.targetMode;
  dom.setBluetooth.value = sensorInfo.bluetooth === 'off' ? 'off' : 'on';
}

async function querySensorInfo(): Promise<void> {
  if (!source || !commandClient || querying) return;
  querying = true;
  updateControlStates();
  setSettingsHint('Querying firmware, MAC and target mode…');
  try {
    const info = await commandClient.queryAll();
    sensorInfo = {
      ...sensorInfo,
      firmware: info.firmware ?? sensorInfo.firmware,
      mac: info.mac ?? sensorInfo.mac,
      targetMode: info.targetMode ?? sensorInfo.targetMode,
    };
    renderSensorInfo();
    const answered = Boolean(info.firmware || info.mac || info.targetMode);
    setSettingsHint(
      answered
        ? 'Sensor information updated.'
        : 'No response to configuration commands — the device may be in a read-only mode or using a different UART protocol.',
    );
  } finally {
    querying = false;
    updateControlStates();
  }
}

async function applyMode(): Promise<void> {
  if (!commandClient || applying) return;
  const mode = dom.setMode.value === 'single' ? 'single' : 'multi';
  applying = true;
  updateControlStates();
  setSettingsHint(`Setting ${mode}-target mode…`);
  try {
    await commandClient.setTargetMode(mode);
    sensorInfo.targetMode = mode;
    renderSensorInfo();
    setSettingsHint(`Target mode set to ${mode}.`);
  } catch (error) {
    setSettingsHint(`Could not set target mode: ${errorText(error)}`);
  } finally {
    applying = false;
    updateControlStates();
  }
}

async function applyBluetooth(): Promise<void> {
  if (!commandClient || applying) return;
  const on = dom.setBluetooth.value === 'on';
  if (!on && source === 'ble' && !window.confirm('Disabling Bluetooth will drop this BLE connection. Continue?')) {
    return;
  }
  applying = true;
  updateControlStates();
  setSettingsHint(`Turning Bluetooth ${on ? 'on' : 'off'}…`);
  try {
    await commandClient.setBluetooth(on);
    sensorInfo.bluetooth = on ? 'on' : 'off';
    renderSensorInfo();
    setSettingsHint(
      on
        ? 'Bluetooth enabled. The sensor may restart its radio.'
        : 'Bluetooth disabled. Reconnect over USB serial to turn it back on.',
    );
  } catch (error) {
    setSettingsHint(`Could not change Bluetooth: ${errorText(error)}`);
  } finally {
    applying = false;
    updateControlStates();
  }
}

async function applyBaud(): Promise<void> {
  if (!commandClient || applying) return;
  const rate = Number(dom.setBaud.value);
  if (!window.confirm(`Set the sensor UART to ${rate} baud? You must reconnect at ${rate} baud afterwards.`)) {
    return;
  }
  applying = true;
  updateControlStates();
  setSettingsHint(`Setting sensor baud to ${rate}…`);
  try {
    await commandClient.setBaud(rate);
    dom.baud.value = String(rate);
    dom.setBaud.value = String(rate);
    setSettingsHint(`Sensor baud set to ${rate}. Reconnect at ${rate} baud to continue.`);
    showBanner(`Sensor baud changed to ${rate}. Disconnect and reconnect at ${rate} baud.`);
  } catch (error) {
    setSettingsHint(`Could not change baud: ${errorText(error)}`);
  } finally {
    applying = false;
    updateControlStates();
  }
}

async function restartSensor(): Promise<void> {
  if (!commandClient || applying) return;
  if (!window.confirm('Restart the LD2450 sensor?')) return;
  applying = true;
  updateControlStates();
  setSettingsHint('Restarting sensor…');
  try {
    await commandClient.restart();
    setSettingsHint('Restart command accepted. The sensor should resume streaming shortly.');
  } catch (error) {
    setSettingsHint(`Could not restart sensor: ${errorText(error)}`);
  } finally {
    applying = false;
    updateControlStates();
  }
}

/* ---------- connections ---------- */

async function connectSerial(filters?: SerialPortFilter[]): Promise<void> {
  if (source !== null || !serialSupported()) return;
  setPill('pill-connecting', 'Connecting…');
  dom.btnConnect.disabled = true;
  dom.btnConnectAll.disabled = true;
  dom.btnBle.disabled = true;
  dom.btnSim.disabled = true;
  try {
    await serial.connect(Number(dom.baud.value), filters);
  } catch (error) {
    onSourceClose();
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotFoundError') {
      showBanner(filters ? 'No port selected. Use "All ports…" if your adapter is not in the filtered list.' : 'No port selected.');
    } else {
      showBanner(`Could not open serial port: ${errorText(error)}`);
    }
  }
}

async function connectBle(): Promise<void> {
  if (source !== null || !bleSupported()) return;
  setPill('pill-connecting', 'Connecting…');
  dom.btnConnect.disabled = true;
  dom.btnConnectAll.disabled = true;
  dom.btnBle.disabled = true;
  dom.btnSim.disabled = true;
  try {
    await ble.connect();
  } catch (error) {
    onSourceClose();
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotFoundError') showBanner('No BLE device selected.');
    else showBanner(`Could not connect over BLE: ${errorText(error)}`);
  }
}

function toggleSim(): void {
  if (source === 'sim') {
    sim.stop();
    return;
  }
  if (source !== null) return;
  sim.start();
}

function errorText(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/* ---------- export ---------- */

function stamp(): string {
  const date = new Date();
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(
    2,
    '0',
  )}_${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(
    date.getSeconds(),
  ).padStart(2, '0')}`;
}

function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function exportCsv(): void {
  if (log.length === 0) return;
  const targetColumns = [0, 1, 2].flatMap((index) => [
    `t${index + 1}_active`,
    `t${index + 1}_x_mm`,
    `t${index + 1}_y_mm`,
    `t${index + 1}_distance_mm`,
    `t${index + 1}_speed_cm_s`,
    `t${index + 1}_resolution_mm`,
  ]);
  const header = ['t_s', 'frame', ...targetColumns].join(',');
  const rows = log.map((row, frameIndex) => {
    const values: Array<string | number> = [row.t.toFixed(3), frameIndex];
    for (let i = 0; i < 3; i++) {
      const target = row.targets[i];
      values.push(
        target.active ? 1 : 0,
        target.active ? target.x : '',
        target.active ? target.y : '',
        target.active ? target.distance : '',
        target.active ? target.speed : '',
        target.active ? target.resolution : '',
      );
    }
    return values.join(',');
  });
  if (logTruncated) rows.unshift('# note: oldest rows were trimmed at the 100k frame cap');
  downloadText(`ld2450_log_${stamp()}.csv`, `${header}\n${rows.join('\n')}\n`, 'text/csv');
}

function exportDiagnostics(): void {
  const payload = {
    capturedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    source,
    sensorInfo,
    baud: Number(dom.baud.value),
    parser: parser.stats,
    sniffer: sniffer.stats,
    bytesPerSec: byteTimes.length,
    recentBytesHex: sniffer.recentBytes().map((byte) => byte.toString(16).padStart(2, '0')),
  };
  downloadText(`ld2450_diagnostics_${stamp()}.json`, JSON.stringify(payload, null, 2), 'application/json');
}

/* ---------- wiring ---------- */

for (const rate of BAUD_RATES) {
  const option = document.createElement('option');
  option.value = String(rate);
  option.textContent = String(rate);
  if (rate === DEFAULT_BAUD) option.selected = true;
  dom.baud.append(option);

  const sensorOption = document.createElement('option');
  sensorOption.value = String(rate);
  sensorOption.textContent = String(rate);
  if (rate === DEFAULT_BAUD) sensorOption.selected = true;
  dom.setBaud.append(sensorOption);
}

dom.btnConnect.addEventListener('click', () => {
  if (source === 'serial') {
    void serial.disconnect();
    return;
  }
  if (source === 'ble') {
    void ble.disconnect();
    return;
  }
  void connectSerial(BRIDGE_FILTERS);
});

dom.btnConnectAll.addEventListener('click', () => void connectSerial());

dom.btnBle.addEventListener('click', () => {
  if (source === 'ble') {
    void ble.disconnect();
    return;
  }
  if (source === 'serial') return;
  void connectBle();
});

dom.btnSim.addEventListener('click', toggleSim);

dom.btnPause.addEventListener('click', () => {
  paused = !paused;
  dom.btnPause.textContent = paused ? 'Resume' : 'Pause';
});

dom.btnClearTrails.addEventListener('click', () => {
  map.clearTrails();
});

dom.mapRange.addEventListener('change', () => {
  const range = Number(dom.mapRange.value);
  map.setRange(range);
  dom.mapScale.textContent = `±${range.toFixed(1)} m · 120° FOV`;
});

dom.invertX.addEventListener('change', () => {
  map.setInvertX(dom.invertX.checked);
});

dom.btnQueryInfo.addEventListener('click', () => void querySensorInfo());
dom.btnApplyMode.addEventListener('click', () => void applyMode());
dom.btnApplyBluetooth.addEventListener('click', () => void applyBluetooth());
dom.btnApplyBaud.addEventListener('click', () => void applyBaud());
dom.btnRestart.addEventListener('click', () => void restartSensor());
dom.btnExport.addEventListener('click', exportCsv);
dom.btnDiag.addEventListener('click', exportDiagnostics);

/* ---------- boot ---------- */

if (!window.isSecureContext) {
  showBanner(
    'Web Serial and Web Bluetooth require a secure context. Open the page via http://localhost or HTTPS, then reload.',
  );
  dom.btnConnect.disabled = true;
  dom.btnConnectAll.disabled = true;
  dom.btnBle.disabled = true;
} else {
  if (!serialSupported()) {
    showBanner('Web Serial is not available in this browser. Use Chrome, Edge or Opera on desktop — the simulator still works.');
    dom.btnConnect.disabled = true;
    dom.btnConnectAll.disabled = true;
  }
  if (!bleSupported()) {
    dom.btnBle.disabled = true;
  }
}

if (!serialSupported()) dom.btnConnect.disabled = true;
if (!bleSupported()) dom.btnBle.disabled = true;

commandClient = new CommandClient(async (data: Uint8Array) => {
  if (source === 'serial') await serial.write(data);
  else if (source === 'ble') await ble.write(data);
  else if (source === 'sim') sim.write(data);
  else throw new Error('No device connected');
});

setPill('pill-off', 'Disconnected');
dom.mapScale.textContent = `±${Number(dom.mapRange.value).toFixed(1)} m · 120° FOV`;
updateUi();
window.setInterval(updateUi, 150);
requestAnimationFrame(animateMap);