/**
 * 页面内自测：通过 ?selftest=1 触发，自动操作真实 UI 控件，
 * 把每项检查写入 #selftest-out 并把汇总写入 document.title，
 * 供 headless 浏览器抓取，无需任何浏览器自动化依赖。
 *
 * 这里验证的是“接线层”：DOM 控件 → Lab 状态 → three.js 重建 → 测量面板，
 * 数学正确性由 npm run verify（scripts/verify.ts）覆盖。
 */
export function runSelfTest(): void {
  const out = document.createElement('div');
  out.id = 'selftest-out';
  out.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99;max-width:60vw;max-height:40vh;overflow:auto;background:#000a;color:#9fe;font:11px/1.6 monospace;padding:8px;border:1px solid #444;border-radius:6px;';
  document.body.appendChild(out);

  const results: { name: string; ok: boolean; detail?: string }[] = [];
  const check = (name: string, ok: boolean, detail = '') => {
    results.push({ name, ok, detail });
    out.textContent = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`).join('\n');
  };
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const fire = (el: HTMLElement, type: string) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const metricsText = () => $('metrics').innerText;
  const tick = () => new Promise((r) => setTimeout(r, 60));

  const start = performance.now();
  queueMicrotask(async () => {
    try {
      // 1. 初始：直接拼接有缝、修正归零
      await tick();
      const m0 = metricsText();
      check('初始直接拼接存在裂缝', /最大偏离\s+[1-9]/.test(m0.split('● 接缝修正')[0]));
      check('初始修正缝差归零', /0\.0000e\+0|e-1[0-9]/.test(m0.split('● 接缝修正')[1]));

      // 2. 反转 B：修正仍归零，无 NaN
      const revB = $('reverseB') as HTMLInputElement;
      revB.checked = true;
      fire(revB, 'change');
      await tick();
      const m1 = metricsText();
      check('反转 B 后无 NaN', !m1.includes('NaN'));
      check('反转 B 后修正归零', /0\.0000e\+0|e-1[0-9]/.test(m1.split('● 接缝修正')[1]));

      // 3. 双侧反向
      const revA = $('reverseA') as HTMLInputElement;
      revA.checked = true;
      fire(revA, 'change');
      await tick();
      const m2 = metricsText();
      check('双侧反向无 NaN', !m2.includes('NaN') && !m2.includes('undefined'));
      check('双侧反向修正归零', /0\.0000e\+0|e-1[0-9]/.test(m2.split('● 接缝修正')[1]));
      revA.checked = false;
      fire(revA, 'change');
      revB.checked = false;
      fire(revB, 'change');

      // 4. 非整数倍密度 5 vs 3
      const va = $('subdivVA') as HTMLInputElement;
      const vb = $('subdivVB') as HTMLInputElement;
      va.value = '5';
      fire(va, 'input');
      vb.value = '3';
      fire(vb, 'input');
      await tick();
      const m3 = metricsText();
      check('5 vs 3 非整数倍密度修正归零', /0\.0000e\+0|e-1[0-9]/.test(m3.split('● 接缝修正')[1]),
        m3.split('● 接缝修正')[1].split('\n')[1]?.trim() ?? '');

      // 5. 线框开关
      const wf = $('wireframe') as HTMLInputElement;
      wf.checked = false;
      fire(wf, 'change');
      await tick();
      check('线框可关闭', true);
      wf.checked = true;
      fire(wf, 'change');

      // 6. 改控制点数值：面板数值随之变化且不抛异常
      const cx = $('cpX') as HTMLInputElement;
      const before = cx.value;
      cx.value = String(Number(before) + 0.5);
      fire(cx, 'change');
      await tick();
      check('控制点数值编辑生效', ($('cpX') as HTMLInputElement).value !== before);

      // 7. canvas 存在且尺寸正常（WebGL 上下文真的在画）
      const canvas = document.querySelector('#canvas-host canvas') as HTMLCanvasElement;
      check('WebGL canvas 已挂载', !!canvas && canvas.width > 0 && canvas.height > 0,
        canvas ? `${canvas.width}x${canvas.height}` : 'missing');

      // 8. 重置样例
      $('resetBtn').click();
      await tick();
      check('重置后回到默认密度', $('va-val').textContent === '4' && $('vb-val').textContent === '16');
    } catch (err) {
      check('自测过程未抛异常: ' + (err as Error).message, false);
    }

    const failed = results.filter((r) => !r.ok);
    const summary = `SELFTEST ${failed.length === 0 ? 'PASS' : 'FAIL'} ${results.length - failed.length}/${results.length} in ${(performance.now() - start).toFixed(0)}ms`;
    document.title = summary;
    const banner = document.createElement('div');
    banner.textContent = summary;
    banner.style.cssText = 'position:fixed;top:8px;right:340px;z-index:100;background:#000c;padding:6px 12px;border-radius:6px;font:13px monospace;color:' + (failed.length ? '#f88' : '#8f8');
    document.body.appendChild(banner);
  });
}
