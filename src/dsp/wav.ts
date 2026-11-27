/**
 * 最小 WAV（PCM16 / PCM32 / IEEE_F32）编码器与解析器。
 * 全部本地处理，不上传任何数据。
 */

export function encodeWav(channels: Float32Array[], sampleRate: number, bitDepth: 16 | 32 = 16): Blob {
  const numCh = channels.length;
  const frames = channels[0].length;
  const bytesPerSample = bitDepth / 8;
  const dataSize = frames * numCh * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buffer);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  const audioFormat = bitDepth === 32 ? 3 : 1; // 3 = IEEE float
  dv.setUint16(20, audioFormat, true);
  dv.setUint16(22, numCh, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * numCh * bytesPerSample, true);
  dv.setUint16(32, numCh * bytesPerSample, true);
  dv.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  dv.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const v = Math.max(-1, Math.min(1, channels[ch][i]));
      if (bitDepth === 16) {
        // 加 ±0.5 LSB 的三角抖动，量化噪声不与信号相关
        const dither = (Math.random() - 0.5) / 32768;
        dv.setInt16(off, (v + dither) * 32767, true);
      } else {
        dv.setFloat32(off, v, true);
      }
      off += bytesPerSample;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export interface ParsedWav {
  channels: Float32Array[];
  sampleRate: number;
  numChannels: number;
  bitDepth: number;
}

export function parseWav(buf: ArrayBuffer): ParsedWav {
  const dv = new DataView(buf);
  const readStr = (off: number, n: number) => {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(off + i));
    return s;
  };
  if (readStr(0, 4) !== 'RIFF' || readStr(8, 4) !== 'WAVE') {
    throw new Error('不是 RIFF/WAVE 文件');
  }
  let off = 12;
  let audioFormat = 1;
  let numChannels = 2;
  let sampleRate = 44100;
  let bitDepth = 16;
  let dataOff = -1;
  let dataSize = 0;
  while (off + 8 <= buf.byteLength) {
    const id = readStr(off, 4);
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') {
      audioFormat = dv.getUint16(off + 8, true);
      numChannels = dv.getUint16(off + 10, true);
      sampleRate = dv.getUint32(off + 12, true);
      bitDepth = dv.getUint16(off + 22, true);
    } else if (id === 'data') {
      dataOff = off + 8;
      dataSize = size;
    }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0) throw new Error('WAV 中没有 data 块');

  const bytesPerSample = bitDepth / 8;
  const frames = Math.floor(dataSize / (numChannels * bytesPerSample));
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(new Float32Array(frames));

  let p = dataOff;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let v = 0;
      if (audioFormat === 3) {
        v = bitDepth === 32 ? dv.getFloat32(p, true) : dv.getFloat64(p, true);
      } else if (bitDepth === 16) {
        v = dv.getInt16(p, true) / 32768;
      } else if (bitDepth === 24) {
        const b0 = dv.getUint8(p);
        const b1 = dv.getUint8(p + 1);
        const b2 = dv.getUint8(p + 2);
        let x = b0 | (b1 << 8) | (b2 << 16);
        if (x & 0x800000) x |= ~0xffffff;
        v = x / 8388608;
      } else if (bitDepth === 32) {
        v = dv.getInt32(p, true) / 2147483648;
      } else if (bitDepth === 8) {
        v = (dv.getUint8(p) - 128) / 128;
      }
      channels[ch][i] = v;
      p += bytesPerSample;
    }
  }
  return { channels, sampleRate, numChannels, bitDepth };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
