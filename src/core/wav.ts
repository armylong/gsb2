/**
 * 最小 16-bit PCM WAV 编码器 (单声道)。纯函数, 可在 Node 与浏览器运行。
 */
export function encodeWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
  const dataSize = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

export interface WavHeaderInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataSize: number;
  totalSamples: number;
}

export function parseWavHeader(bytes: ArrayBuffer | Uint8Array): WavHeaderInfo {
  const view = new DataView(bytes instanceof ArrayBuffer ? bytes : bytes.buffer);
  const sampleRate = view.getUint32(24, true);
  const channels = view.getUint16(22, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataSize = view.getUint32(40, true);
  return {
    sampleRate,
    channels,
    bitsPerSample,
    dataSize,
    totalSamples: dataSize / (bitsPerSample / 8) / channels,
  };
}
