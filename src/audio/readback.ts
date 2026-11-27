import { analyzeWav, expectedBeat, type ReadbackReport } from '../dsp/analyze';
import { parseWav } from '../dsp/wav';

/** 回读 WAV：核对左右声道接线、主频与拍频，并与导出时的期望值比对 */
export async function readWavFile(file: File, expected?: { fA: number; fB: number }): Promise<string> {
  const buf = await file.arrayBuffer();
  const parsed = parseWav(buf);
  const report: ReadbackReport = analyzeWav(parsed.channels, parsed.sampleRate);

  const lines: string[] = [];
  lines.push(`文件：${file.name}`);
  lines.push(`采样率 ${report.sampleRate} Hz · 时长 ${report.duration.toFixed(2)} s · ${parsed.numChannels} 声道 · ${parsed.bitDepth} bit`);
  lines.push('');
  const routeText =
    report.routing === 'split' ? '左右分送 split' : report.routing === 'mix' ? '混合同送 mix' : '无法明确判定';
  lines.push(`接线判定：${routeText}`);
  lines.push(
    `左声道主频 ${report.leftFreq.toFixed(2)} Hz（幅度 ${report.left.amplitude.toFixed(3)}，RMS ${report.left.rms.toFixed(3)}）`,
  );
  lines.push(
    `右声道主频 ${report.rightFreq.toFixed(2)} Hz（幅度 ${report.right.amplitude.toFixed(3)}，RMS ${report.right.rms.toFixed(3)}）`,
  );
  lines.push(`实测拍频 |Δf| = ${report.beatHz.toFixed(3)} Hz`);

  if (expected) {
    const exp = expectedBeat(expected.fA, expected.fB);
    const err = Math.abs(report.beatHz - exp);
    lines.push('');
    lines.push(`期望拍频 ${exp.toFixed(3)} Hz，偏差 ${err.toFixed(3)} Hz ${err < 0.5 ? '✓' : '✗'}`);
    const errL = Math.min(
      Math.abs(report.leftFreq - expected.fA),
      Math.abs(report.leftFreq - expected.fB),
    );
    const errR = Math.min(
      Math.abs(report.rightFreq - expected.fA),
      Math.abs(report.rightFreq - expected.fB),
    );
    lines.push(`左声道频率匹配偏差 ${errL.toFixed(2)} Hz · 右声道 ${errR.toFixed(2)} Hz`);
  }
  if (report.warnings.length) {
    lines.push('');
    report.warnings.forEach((w) => lines.push(`⚠ ${w}`));
  }
  return lines.join('\n');
}
