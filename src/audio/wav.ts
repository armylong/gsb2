/**
 * WAV 编解码（16-bit PCM，单声道）。
 *
 * 纯 TypeScript、零依赖，浏览器与 Node（测试）都能跑：
 *  - encodeWav：离线渲染的 Float32 PCM → WAV 字节；
 *  - decodeWav：读回 WAV → 采样率与 Float32 PCM，用于对照包络与结尾长度。
 */

export interface DecodedWav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  pcm: Float32Array;
}

/** 字符串写四字符 ID。 */
function writeId(view: DataView, offset: number, id: string): void {
  for (let i = 0; i < 4; i++) view.setUint8(offset + i, id.charCodeAt(i));
}

function readId(view: DataView, offset: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

export function encodeWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeId(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeId(view, 8, 'WAVE');
  writeId(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeId(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    // 对称量化：正负半区都用 32768 刻度，再钳到 int16 范围
    const int16 = Math.max(-32768, Math.min(32767, Math.round(s * 32768)));
    view.setInt16(44 + i * 2, int16, true);
  }
  return buffer;
}

/**
 * 解析 WAV。只要求标准 RIFF/WAVE 结构，fmt/data 块按 chunk 查找，
 * 跳过未知块（如 LIST），这样对常见导出文件都宽容。
 */
export function decodeWav(buffer: ArrayBuffer): DecodedWav {
  const view = new DataView(buffer);
  if (readId(view, 0) !== 'RIFF' || readId(view, 8) !== 'WAVE') {
    throw new Error('不是合法的 WAV 文件：缺少 RIFF/WAVE 头');
  }

  let offset = 12;
  let audioFormat = 1;
  let channels = 1;
  let sampleRate = 44100;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.byteLength) {
    const chunkId = readId(view, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (chunkId === 'fmt ') {
      audioFormat = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (chunkId === 'data') {
      dataOffset = body;
      dataSize = chunkSize;
    }
    offset = body + chunkSize + (chunkSize % 2); // chunk 按字对齐
  }

  if (dataOffset < 0) throw new Error('WAV 中没有 data 块');
  if (audioFormat !== 1) throw new Error(`暂只支持 PCM WAV，format=${audioFormat}`);

  const frameCount = Math.floor(dataSize / (bitsPerSample / 8) / channels);
  const pcm = new Float32Array(frameCount);

  if (bitsPerSample === 16) {
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        sum += view.getInt16(dataOffset + (i * channels + c) * 2, true) / 0x8000;
      }
      pcm[i] = sum / channels;
    }
  } else if (bitsPerSample === 24) {
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        const b0 = view.getUint8(dataOffset + (i * channels + c) * 3);
        const b1 = view.getUint8(dataOffset + (i * channels + c) * 3 + 1);
        const b2 = view.getUint8(dataOffset + (i * channels + c) * 3 + 2);
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v |= ~0xffffff;
        sum += v / 0x800000;
      }
      pcm[i] = sum / channels;
    }
  } else if (bitsPerSample === 32) {
    for (let i = 0; i < frameCount; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        sum += view.getInt32(dataOffset + (i * channels + c) * 4, true) / 0x80000000;
      }
      pcm[i] = sum / channels;
    }
  } else {
    throw new Error(`不支持的位深：${bitsPerSample}`);
  }

  return { sampleRate, channels, bitsPerSample, pcm };
}

/** 统计最后一个超过噪声门限的采样之后的静音长度（采样数）。 */
export function trailingSilence(pcm: Float32Array, noiseFloor = 1e-4): number {
  for (let i = pcm.length - 1; i >= 0; i--) {
    if (Math.abs(pcm[i]) > noiseFloor) return pcm.length - 1 - i;
  }
  return pcm.length;
}
