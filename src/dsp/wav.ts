/** 16-bit PCM WAV 的编码与回读解析，纯本地实现，不依赖 AudioContext */

export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

export interface DecodedWav {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
}

/** 解析本工具写出的 WAV（16-bit PCM），用于“导出→回读”闭环验证 */
export function decodeWav(buffer: ArrayBuffer): DecodedWav {
  const view = new DataView(buffer);
  const readStr = (offset: number, len: number) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
    return s;
  };
  if (readStr(0, 4) !== 'RIFF' || readStr(8, 4) !== 'WAVE') {
    throw new Error('不是合法的 WAV 文件');
  }
  let offset = 12;
  let sampleRate = 44100;
  let channels = 1;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.byteLength) {
    const id = readStr(offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      const format = view.getUint16(offset + 8, true);
      if (format !== 1) throw new Error('回读仅支持 PCM 格式 WAV');
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error('WAV 中找不到 data 块');
  const frameCount = dataLength / (2 * channels);
  const samples = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    // 单声道取第一通道；多声道时取首通道
    samples[i] = view.getInt16(dataOffset + i * channels * 2, true) / 0x8000;
  }
  return { samples, sampleRate, channels };
}

export function downloadWav(samples: Float32Array, sampleRate: number, filename: string): void {
  const buf = encodeWav(samples, sampleRate);
  const blob = new Blob([buf], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
