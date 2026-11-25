export interface ChannelPeaks {
  min: Float32Array;
  max: Float32Array;
}

export interface WavePeaks {
  channels: ChannelPeaks[];
  buckets: number;
}

export function computePeaks(buffer: AudioBuffer, buckets = 2600): WavePeaks {
  const count = Math.max(1, Math.min(buckets, Math.floor(buffer.length / 64) || 1));
  const channels: ChannelPeaks[] = [];

  for (let channel = 0; channel < Math.min(2, buffer.numberOfChannels); channel += 1) {
    const data = buffer.getChannelData(channel);
    const min = new Float32Array(count);
    const max = new Float32Array(count);
    const bucketSize = data.length / count;

    for (let bucket = 0; bucket < count; bucket += 1) {
      const start = Math.floor(bucket * bucketSize);
      const end = Math.max(start + 1, Math.floor((bucket + 1) * bucketSize));
      let lo = 1;
      let hi = -1;
      for (let i = start; i < Math.min(data.length, end); i += 1) {
        const value = data[i];
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
      min[bucket] = lo;
      max[bucket] = hi;
    }
    channels.push({ min, max });
  }

  return { channels, buckets: count };
}
