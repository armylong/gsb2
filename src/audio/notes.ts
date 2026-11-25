const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToName(midi: number): string {
  const name = NOTE_NAMES[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

export function nameToMidi(name: string): number {
  const match = /^([A-G]#?)(-?\d+)$/.exec(name);
  if (!match) throw new Error(`bad note name: ${name}`);
  const idx = NOTE_NAMES.indexOf(match[1]);
  return idx + (parseInt(match[2], 10) + 1) * 12;
}

export function isBlackKey(midi: number): boolean {
  return NOTE_NAMES[midi % 12].includes('#');
}
