/** 16-bit PCM WAV 编码（单声道或立体声），纯前端 Blob 下载。 */

export function encodeWavPcm16(channels: Float64Array[], sampleRate: number): Blob {
  const ch = channels.length;
  const frames = channels[0].length;
  for (const c of channels) {
    if (c.length !== frames) throw new Error('各声道长度必须一致');
  }
  const bytesPerSample = 2;
  const dataSize = frames * ch * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  let p = 0;
  const writeAscii = (s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i));
  };
  const writeU32 = (v: number) => { view.setUint32(p, v, true); p += 4; };
  const writeU16 = (v: number) => { view.setUint16(p, v, true); p += 2; };

  writeAscii('RIFF');
  writeU32(36 + dataSize);
  writeAscii('WAVE');
  writeAscii('fmt ');
  writeU32(16);
  writeU16(1); // PCM
  writeU16(ch);
  writeU32(sampleRate);
  writeU32(sampleRate * ch * bytesPerSample);
  writeU16(ch * bytesPerSample);
  writeU16(16);
  writeAscii('data');
  writeU32(dataSize);

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(p, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      p += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
