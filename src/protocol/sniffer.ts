export interface SniffStats {
  totalBytes: number;
  aaBytes: number;
  fdBytes: number;
}

const RING_LEN = 128;
const ROW_BYTES = 16;

export class StreamSniffer {
  readonly stats: SniffStats = {
    totalBytes: 0,
    aaBytes: 0,
    fdBytes: 0,
  };

  private ring = new Uint8Array(RING_LEN);
  private ringFilled = 0;
  private ringPos = 0;

  feed(data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
      const byte = data[i];
      this.stats.totalBytes++;
      if (byte === 0xaa) this.stats.aaBytes++;
      else if (byte === 0xfd) this.stats.fdBytes++;
    }

    const start = Math.max(0, data.length - RING_LEN);
    const toCopy = Math.min(RING_LEN, data.length - start);
    for (let i = 0; i < toCopy; i++) {
      this.ring[this.ringPos] = data[start + i];
      this.ringPos = (this.ringPos + 1) % RING_LEN;
      this.ringFilled = Math.min(RING_LEN, this.ringFilled + 1);
    }
  }

  reset(): void {
    this.stats.totalBytes = 0;
    this.stats.aaBytes = 0;
    this.stats.fdBytes = 0;
    this.ringFilled = 0;
    this.ringPos = 0;
  }

  hexDump(): string {
    if (this.ringFilled === 0) return 'no bytes received';
    const start = (this.ringPos - this.ringFilled + RING_LEN) % RING_LEN;
    const rows: string[] = [];
    for (let row = 0; row < this.ringFilled; row += ROW_BYTES) {
      const count = Math.min(ROW_BYTES, this.ringFilled - row);
      let hex = '';
      let ascii = '';
      for (let i = 0; i < ROW_BYTES; i++) {
        if (i < count) {
          const byte = this.ring[(start + row + i) % RING_LEN];
          hex += `${byte.toString(16).padStart(2, '0')} `;
          ascii += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.';
        } else {
          hex += '   ';
          ascii += ' ';
        }
      }
      rows.push(`${hex.trimEnd().padEnd(47)} ${ascii}`);
    }
    return rows.join('\n');
  }

  recentBytes(): number[] {
    const out: number[] = [];
    const start = (this.ringPos - this.ringFilled + RING_LEN) % RING_LEN;
    for (let i = 0; i < this.ringFilled; i++) out.push(this.ring[(start + i) % RING_LEN]);
    return out;
  }
}