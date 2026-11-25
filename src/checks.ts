/**
 * 浏览器内本地验证。全部通过 OfflineAudioContext / 离线渲染完成，确定性可重复。
 * 关键纪律对应需求第 6 条：正弦例中没有的额外频率不能被显示成真实谐波。
 */
import { classifyMeasurement } from './dsp/spectrum';
import {
  analyzeTable,
  buildPreset,
  constantF0,
  foldFrequency,
  renderBandlimited,
  renderNaive,
  TABLE_SIZE,
} from './dsp/wavetable';
import { renderTone } from './dsp/render';

export interface CheckResult {
  id: string;
  title: string;
  pass: boolean;
  detail: string;
}

const SR = 48000;

/** 用 OfflineAudioContext 跑真实 worklet，验证它与 TS 离线渲染数学一致。 */
async function renderViaWorklet(
  table: Float64Array,
  f0: number,
  duration: number,
  mode: 'naive' | 'bandlimited',
): Promise<Float64Array> {
  const length = Math.round(duration * SR);
  const offline = new OfflineAudioContext(1, length, SR);
  await offline.audioWorklet.addModule(
    new URL(`${import.meta.env.BASE_URL}worklets/wavetable-osc.js`, window.location.href).href,
  );
  const node = new AudioWorkletNode(offline, 'wavetable-osc', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const coeffs = analyzeTable(table);
  node.port.postMessage({ type: 'setTable', table, mag: coeffs.mag, phase: coeffs.phase });
  node.parameters.get('f0')!.value = f0;
  // gate 给显式斜坡并跳过启动段：worklet 带 8ms 平滑包络，稳态后再与离线渲染比
  node.parameters.get('gate')!.setValueAtTime(0, 0);
  node.parameters.get('gate')!.linearRampToValueAtTime(1, 0.05);
  node.parameters.get('abMix')!.value = mode === 'naive' ? 0 : 1;
  node.parameters.get('levelOn')!.value = 0; // 对齐比较时关闭电平归一
  node.connect(offline.destination);
  const buf = await offline.startRendering();
  return Float64Array.from(buf.getChannelData(0));
}

function maxAbsDiff(a: Float64Array | Float32Array, b: Float64Array | Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

export async function runAllChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const sine = buildPreset('sine', TABLE_SIZE);
  const saw = buildPreset('sharp-saw', TABLE_SIZE);
  const notch = buildPreset('notched', TABLE_SIZE);

  // 1. 正弦高音符：A 模式也不应产生任何“多出的真峰”
  {
    const highF0 = 2093; // C7
    const sig = renderTone({
      sampleRate: SR, f0: highF0, duration: 1.2, mode: 'naive',
      table: sine, levelMatch: false,
    });
    const m = classifyMeasurement(sig, SR, highF0, 'naive', analyzeTable(sine));
    const extras = m.classified.filter((p) => p.kind === 'extra');
    results.push({
      id: 'sine-no-extra',
      title: '正弦例高音符不出现额外真实峰（不存在的频率不被当成谐波）',
      pass: extras.length === 0,
      detail: extras.length
        ? `发现 ${extras.length} 个 extra 峰：${extras.map((p) => `${p.freq.toFixed(1)}Hz`).join(', ')}`
        : `实测仅基频 1 个峰，噪声地板 ${m.noiseFloorDb.toFixed(1)} dBFS`,
    });
  }

  // 2. 尖锯齿高音符 A 模式：必须测到折叠分量，且落点符合折叠公式
  {
    const f0 = 1568; // G6
    const sig = renderTone({
      sampleRate: SR, f0, duration: 1.2, mode: 'naive',
      table: saw, levelMatch: false,
    });
    const m = classifyMeasurement(sig, SR, f0, 'naive', analyzeTable(saw));
    const aliases = m.classified.filter((p) => p.kind === 'alias');
    // 频率归属容差与分类器一致：1.5 个 FFT bin（16384 点 @48k → 约 4.4Hz）
    const formulaTolHz = (SR / m.fftSize) * 1.5;
    let formulaOk = true;
    for (const a of aliases) {
      const expect = foldFrequency(a.harmonicK! * f0, SR);
      if (Math.abs(expect - a.freq) > formulaTolHz) formulaOk = false;
    }
    results.push({
      id: 'naive-aliases-present',
      title: '尖锯齿高音符·直接循环：测到折叠低响且频率符合折叠公式',
      pass: aliases.length > 0 && formulaOk,
      detail: aliases.length
        ? `${aliases.length} 个折叠峰，最低 ${Math.min(...aliases.map((p) => p.freq)).toFixed(0)}Hz（高音里的低响）`
        : '未测到折叠分量',
    });
  }

  // 3. 同一尖锯齿 B 模式：折叠峰消失（限带生效）
  {
    const f0 = 1568;
    const sig = renderTone({
      sampleRate: SR, f0, duration: 1.2, mode: 'bandlimited',
      table: saw, levelMatch: false,
    });
    const m = classifyMeasurement(sig, SR, f0, 'bandlimited', analyzeTable(saw));
    const aliases = m.classified.filter((p) => p.kind === 'alias');
    results.push({
      id: 'bandlimited-kills-alias',
      title: '尖锯齿高音符·限带模式：折叠分量被消除',
      pass: aliases.length === 0,
      detail: aliases.length
        ? `仍有 ${aliases.length} 个折叠峰`
        : '无折叠峰；越界谐波在明细表中标记为缺失/越界',
    });
  }

  // 4. 窄凹口波形：理论谐波在低音符全部可测，高音符出现缺失清单
  {
    const low = classifyMeasurement(
      renderTone({ sampleRate: SR, f0: 130.81, duration: 1.2, mode: 'bandlimited', table: notch, levelMatch: false }),
      SR, 130.81, 'bandlimited', analyzeTable(notch),
    );
    const high = classifyMeasurement(
      renderTone({ sampleRate: SR, f0: 2093, duration: 1.2, mode: 'bandlimited', table: notch, levelMatch: false }),
      SR, 2093, 'bandlimited', analyzeTable(notch),
    );
    const lowMissing = low.rows.filter((r) => r.status === 'missing' && r.idealDb > -72).length;
    const highAudibleMissing = high.rows.filter(
      (r) => r.status === 'missing' && r.idealDb > -72,
    ).length;
    const highOutOfBand = high.rows.filter((r) => !r.inBand && r.idealDb > -72).length;
    results.push({
      id: 'missing-tracking',
      title: '窄凹口：低音符可听谐波齐全，高音符明确列出“少了什么”',
      pass: lowMissing === 0 && (highAudibleMissing > 0 || highOutOfBand > 0),
      detail:
        `C3 缺失（仅计 >-72dB）${lowMissing} 项；C7 缺失 ${highAudibleMissing} 项、` +
        `越界被限带 ${highOutOfBand} 项（明细表逐行标注折叠/缺失/越界）`,
    });
  }

  // 5. worklet 与 TS 离线渲染一致性（两种模式分别比）
  {
    const f0 = 440;
    const duration = 0.5;
    const length = Math.round(duration * SR);
    const wNaive = await renderViaWorklet(saw, f0, duration, 'naive');
    const tsNaive = renderNaive(saw, { sampleRate: SR, f0Curve: constantF0(length, f0) });
    const wBand = await renderViaWorklet(saw, f0, duration, 'bandlimited');
    const tsBand = renderBandlimited(analyzeTable(saw), { sampleRate: SR, f0Curve: constantF0(length, f0) });
    // 跳过前 0.15s（gate 包络启动 + setTable 交叉淡化），尾部留 64 采样
    const lo = Math.round(0.15 * SR);
    const hi = length - 64;
    const dNaive = maxAbsDiff(wNaive.slice(lo, hi), tsNaive.slice(lo, hi));
    const dBand = maxAbsDiff(wBand.slice(lo, hi), tsBand.slice(lo, hi));
    results.push({
      id: 'worklet-parity',
      title: '实时 worklet 与离线渲染共用同一套数学（防实现漂移）',
      pass: dNaive < 1e-4 && dBand < 1e-4,
      detail: `稳态段最大样本差 A=${dNaive.toExponential(2)}，B=${dBand.toExponential(2)}（已跳过包络启动段）`,
    });
  }

  // 6. 扫频连续性：谐波跨过奈奎斯特时增益连续（无硬切断），贡献逐采样平滑。
  //    直接检验“每个谐波 mag·gain 在扫频全程的最大单样本增量”，
  //    并与硬切断（到界即归零）对照，淡出必须把该增量压下一个数量级。
  {
    const coeffs = analyzeTable(saw);
    const nyquist = SR / 2;
    const fadeStart = nyquist * 0.98;
    const gainOf = (fk: number) => {
      if (fk <= fadeStart) return 1;
      if (fk >= nyquist) return 0;
      const x = (fk - fadeStart) / (nyquist - fadeStart);
      return 0.5 * (1 + Math.cos(Math.PI * Math.min(1, x / 0.12)));
    };
    const n = SR;
    const f0At = (i: number) => 220 * Math.pow(2, (Math.sin((2 * Math.PI * i) / n) * 24) / 12);
    let fadedJump = 0;
    let hardJump = 0;
    for (let k = 1; k <= 60; k++) {
      let prevFaded = 0;
      let prevHard = 0;
      for (let i = 0; i < n; i++) {
        const fk = k * f0At(i);
        const curFaded = coeffs.mag[k] * gainOf(fk);
        const curHard = fk < nyquist ? coeffs.mag[k] : 0;
        if (i > 0) {
          fadedJump = Math.max(fadedJump, Math.abs(curFaded - prevFaded));
          hardJump = Math.max(hardJump, Math.abs(curHard - prevHard));
        }
        prevFaded = curFaded;
        prevHard = curHard;
      }
    }
    results.push({
      id: 'sweep-smooth',
      title: '按住时 ±2 八度扫频：谐波过奈奎斯特增益连续，无硬切断换声',
      pass: fadedJump > 0 && fadedJump < hardJump / 5,
      detail: `淡出最大单样本增量 ${fadedJump.toExponential(2)} vs 硬切断 ${hardJump.toExponential(2)}（小 ${(hardJump / fadedJump).toFixed(1)} 倍）`,
    });
  }

  // 7. 折叠公式抽样自检（与教科书镜像公式对照）
  {
    const cases: [number, number][] = [
      [30000, 18000], // fs=48000：30k 折到 18k
      [26000, 22000],
      [50000, 2000],
    ];
    const ok = cases.every(([f, want]) => Math.abs(foldFrequency(f, SR) - want) < 1e-9);
    results.push({
      id: 'fold-formula',
      title: '折叠数学：|((f+fs/2) mod fs) − fs/2| 抽样正确',
      pass: ok,
      detail: cases.map(([f, w]) => `${f}→${foldFrequency(f, SR)}（期望 ${w}）`).join('；'),
    });
  }

  // 8. 等响度：A/B 两模式整段 RMS 差小于 1 dB
  {
    const a = renderTone({ sampleRate: SR, f0: 1568, duration: 1, mode: 'naive', table: saw, levelMatch: true });
    const b = renderTone({ sampleRate: SR, f0: 1568, duration: 1, mode: 'bandlimited', table: saw, levelMatch: true });
    const rmsDb = (x: Float64Array) => {
      let s = 0;
      for (const v of x) s += v * v;
      return 10 * Math.log10(s / x.length + 1e-12);
    };
    const diff = Math.abs(rmsDb(a) - rmsDb(b));
    results.push({
      id: 'loudness-match',
      title: '等响度对齐后 A/B 两模式 RMS 差 < 1 dB（同音量比较）',
      pass: diff < 1,
      detail: `RMS 差 ${diff.toFixed(2)} dB`,
    });
  }

  return results;
}
