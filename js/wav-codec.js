/*
 * wav-codec.js — 手写 WAV 解析/生成，不依赖 Web Audio 解码（保证采样位置与文件严格一致）
 * 支持：PCM 8/16/24/32-bit、IEEE float32、单/双声道、WAVE_FORMAT_EXTENSIBLE
 * UMD：浏览器挂到 globalThis.WavCodec，Node 下 module.exports。
 */
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.WavCodec = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  class WavError extends Error {
    constructor(message) {
      super(message);
      this.name = 'WavError';
    }
  }

  function readAscii(view, offset, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
    return s;
  }

  /* 解析 ArrayBuffer/Uint8Array，返回 { sampleRate, channels, bitDepth, encoding, frameCount, durationSec, data: Float32Array[] } */
  function decodeWav(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.byteLength === 0) throw new WavError('文件为空（0 字节）');
    if (bytes.byteLength < 12) throw new WavError('文件过短，不是有效的 WAV 文件');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (readAscii(view, 0, 4) !== 'RIFF') throw new WavError('不是 WAV 文件（缺少 RIFF 标识）');
    if (readAscii(view, 8, 4) !== 'WAVE') throw new WavError('不是 WAV 文件（缺少 WAVE 标识）');

    let fmt = null;
    let dataBytes = null;
    let off = 12;
    while (off + 8 <= bytes.byteLength) {
      const id = readAscii(view, off, 4);
      const size = view.getUint32(off + 4, true);
      const body = off + 8;
      if (body + size > bytes.byteLength) throw new WavError('文件已损坏：数据块超出文件长度（可能被截断）');
      if (id === 'fmt ' && !fmt) fmt = { offset: body, size };
      else if (id === 'data' && !dataBytes) dataBytes = { offset: body, size };
      off = body + size + (size % 2); // 块按字对齐
    }
    if (!fmt) throw new WavError('WAV 结构不完整（缺少 fmt 块）');
    if (!dataBytes) throw new WavError('WAV 结构不完整（缺少 data 块）');
    if (fmt.size < 16) throw new WavError('fmt 块长度异常，文件可能已损坏');

    let audioFormat = view.getUint16(fmt.offset, true);
    const channels = view.getUint16(fmt.offset + 2, true);
    const sampleRate = view.getUint32(fmt.offset + 4, true);
    const blockAlign = view.getUint16(fmt.offset + 12, true);
    const bitsPerSample = view.getUint16(fmt.offset + 14, true);

    if (audioFormat === 0xfffe) {
      // WAVE_FORMAT_EXTENSIBLE：真实编码在 SubFormat GUID 的前两个字节
      if (fmt.size < 40) throw new WavError('不支持的 WAV 编码（Extensible 头不完整）');
      audioFormat = view.getUint16(fmt.offset + 24, true);
    }
    const encoding = audioFormat === 1 ? 'PCM' : audioFormat === 3 ? 'FLOAT' : null;
    if (!encoding) throw new WavError('不支持的 WAV 编码（仅支持无压缩 PCM / IEEE float，压缩格式请先转换）');
    if (channels !== 1 && channels !== 2) throw new WavError('仅支持单声道或双声道 WAV（收到 ' + channels + ' 声道）');
    if (sampleRate === 0) throw new WavError('采样率为 0，文件已损坏');
    if (bitsPerSample === 0 || blockAlign === 0) throw new WavError('位深/块对齐信息异常，文件已损坏');
    if (dataBytes.size === 0) throw new WavError('音频数据为空（data 块长度为 0）');

    const validBits = encoding === 'PCM' ? [8, 16, 24, 32] : [32];
    if (!validBits.includes(bitsPerSample)) {
      throw new WavError('不支持的位深：' + bitsPerSample + '-bit' + (encoding === 'PCM' ? '（支持 8/16/24/32）' : '（浮点仅支持 32）'));
    }
    const expectAlign = channels * (bitsPerSample / 8);
    if (blockAlign !== expectAlign) throw new WavError('块对齐与声道/位深不符，文件已损坏');
    if (dataBytes.size % blockAlign !== 0) throw new WavError('文件已损坏：音频数据被截断（长度不是整块）');

    const frameCount = dataBytes.size / blockAlign;
    const out = [];
    for (let c = 0; c < channels; c++) out.push(new Float32Array(frameCount));

    const p0 = dataBytes.offset;
    for (let i = 0; i < frameCount; i++) {
      for (let c = 0; c < channels; c++) {
        const p = p0 + (i * channels + c) * (bitsPerSample / 8);
        let v;
        if (encoding === 'FLOAT') {
          v = view.getFloat32(p, true);
          if (!Number.isFinite(v)) v = 0;
        } else if (bitsPerSample === 8) {
          v = (view.getUint8(p) - 128) / 128; // 8-bit PCM 无符号
        } else if (bitsPerSample === 16) {
          v = view.getInt16(p, true) / 32768;
        } else if (bitsPerSample === 24) {
          const x = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16);
          v = ((x & 0x800000) ? x | 0xff000000 : x) / 8388608;
        } else {
          v = view.getInt32(p, true) / 2147483648;
        }
        out[c][i] = v;
      }
    }

    return {
      sampleRate,
      channels,
      bitDepth: bitsPerSample,
      encoding,
      frameCount,
      durationSec: frameCount / sampleRate,
      data: out,
    };
  }

  /* 把平面 Float32 声道数组编码为 16-bit PCM WAV ArrayBuffer */
  function encodeWav16(channels, sampleRate) {
    if (!Array.isArray(channels) || channels.length === 0) throw new WavError('没有可导出的音频数据');
    const chCount = channels.length;
    if (chCount !== 1 && chCount !== 2) throw new WavError('仅支持单声道/双声道导出');
    const frames = channels[0].length;
    if (frames === 0) throw new WavError('不能导出空音频（帧数为 0）');
    for (const ch of channels) {
      if (ch.length !== frames) throw new WavError('各声道长度不一致，无法导出');
    }
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new WavError('采样率无效');

    const blockAlign = chCount * 2;
    const dataLen = frames * blockAlign;
    const buf = new ArrayBuffer(44 + dataLen);
    const view = new DataView(buf);
    const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataLen, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);            // PCM
    view.setUint16(22, chCount, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataLen, true);

    let p = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < chCount; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i]));
        let v = Math.round(s * 32767);
        if (v > 32767) v = 32767;
        if (v < -32768) v = -32768;
        view.setInt16(p, v, true);
        p += 2;
      }
    }
    return buf;
  }

  return { WavError, decodeWav, encodeWav16 };
});
