/** 音律换算与音名。 */

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI 音符号转频率（A4 = 69 = 440Hz）。 */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function freqToMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

export function midiToName(midi: number): string {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

/** 频率转最近音名 + 偏差（音分）。 */
export function freqToNameCents(freq: number): { name: string; cents: number } {
  const midiFloat = freqToMidi(freq);
  const nearest = Math.round(midiFloat);
  const cents = Math.round((midiFloat - nearest) * 100);
  return { name: midiToName(nearest), cents };
}

/** 试音页使用的固定音高键位：C2..C7 的每个 C 与中间的 G。 */
export function keyboardNotes(): { midi: number; name: string; freq: number }[] {
  const midis: number[] = [];
  for (let oct = 2; oct <= 7; oct++) {
    midis.push(12 * (oct + 1), 12 * (oct + 1) + 7); // C oct 与 G oct
  }
  return midis.map((midi) => ({
    midi,
    name: midiToName(midi),
    freq: midiToFreq(midi),
  }));
}
