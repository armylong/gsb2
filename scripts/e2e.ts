/**
 * 浏览器端到端验证（不进 src，不参与构建）：
 * 启动 vite dev → puppeteer-core 驱动本机 Chrome → 遍历预设姿态，
 * 截图到 screenshots/ 并断言奇点/安全状态/遮挡点选/锚点稳定。
 *
 * 运行：npx tsx scripts/e2e.ts
 */
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOT_DIR = new URL('../screenshots/', import.meta.url);

interface SignDump {
  id: string;
  faceMode: string;
  sizeMode: string;
  undecidable: boolean;
  safety: string;
  anchor: [number, number, number];
  currentScale: number;
  baseHeight: number;
}

interface EvalResult {
  signs: SignDump[];
  cameraKind: string;
  errors: string[];
}

declare global {
  interface Window {
    __lab: {
      signs: {
        id: string;
        faceMode: string;
        sizeMode: string;
        undecidable: boolean;
        safety: string;
        group: { position: { x: number; y: number; z: number } };
      }[];
      rig: { kind: string };
      pickAt: (x: number, y: number) => string | null;
      setFace: (id: string, mode: string) => void;
      setShelfAnim: (on: boolean) => void;
      occluders: unknown[];
      pickIgnoringOccluders: (x: number, y: number) => string | null;
    };
  }
}

async function main(): Promise<void> {
  await mkdir(SHOT_DIR, { recursive: true });
  const server = await createServer({
    server: { port: 5199, strictPort: false },
  });
  await server.listen();
  const actualPort = server.config.server.port!;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  await page.goto(`http://localhost:${actualPort}/`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !!window.__lab, { timeout: 10000 });
  // 暂停架子动画，所有姿态可复现
  await page.evaluate(() => window.__lab.setShelfAnim(false));
  await new Promise((r) => setTimeout(r, 800));

  const collect = (): Promise<EvalResult> =>
    page.evaluate((errs) => {
      const lab = window.__lab;
      return {
        cameraKind: lab.rig.kind,
        errors: errs,
        signs: lab.signs.map((s) => ({
          id: s.id,
          faceMode: s.faceMode,
          sizeMode: s.sizeMode,
          undecidable: s.undecidable,
          safety: s.safety,
          anchor: [s.group.position.x, s.group.position.y, s.group.position.z],
          currentScale: s.currentScale,
          baseHeight: s.baseHeightValue,
        })),
      };
    }, consoleErrors);

  const failures: string[] = [];
  const check = (cond: boolean, msg: string): void => {
    if (!cond) failures.push(msg);
  };

  // 点按页面里的预设按钮
  const applyPose = async (poseId: string): Promise<void> => {
    await page.evaluate((id) => {
      const btn = document.querySelector(
        `button.pose[data-pose-id="${id}"]`,
      ) as HTMLButtonElement | null;
      btn?.click();
    }, poseId);
    await new Promise((r) => setTimeout(r, 900));
  };

  // ---- 1. 每个预设姿态：截图 + 无控制台错误 + 状态合理 ----
  const poseIds = await page.$$eval('button.pose', (bs) =>
    bs.map((b) => (b as HTMLElement).dataset.poseId ?? ''),
  );
  for (const poseId of poseIds) {
    await applyPose(poseId);
    const r = await collect();
    await page.screenshot({ path: new URL(`${poseId}.png`, SHOT_DIR).pathname });
    check(
      r.signs.every((s) => ['OK', 'NEAR', 'CLIPPED', 'BEHIND', 'CLAMPED'].includes(s.safety)),
      `${poseId}: 出现未知 safety 状态`,
    );
    if (poseId.endsWith('top')) {
      const undecided = r.signs.filter((s) => s.undecidable);
      check(undecided.length >= 1, `${poseId}: 应当至少有一块竖轴/全向牌进入奇点`);
    }
    if (poseId.endsWith('behind')) {
      check(
        r.signs.some((s) => s.safety === 'BEHIND'),
        `${poseId}: 应当有牌处于相机背后(BEHIND)`,
      );
    }
  }

  // ---- 2. 远景：SCREEN 牌保持可见（OK 或被最大占比钳制 CLAMPED，都符合安全设计） ----
  await applyPose('persp-far');
  let r = await collect();
  const marker = r.signs.find((s) => s.id === 'screen-marker')!;
  check(
    marker.safety === 'OK' || marker.safety === 'CLAMPED',
    `远景下屏幕尺寸牌应可见且受控，实际: ${marker.safety}`,
  );
  check(
    r.signs.filter((s) => s.sizeMode === 'WORLD').every((s) => s.safety === 'OK'),
    '远景下世界尺寸牌不应触发安全状态',
  );

  // ---- 3. 半遮挡：整屏网格扫描，命中结果只能是“某张牌”或 null（被墙挡住） ----
  await applyPose('persp-half');
  const sweep = await page.evaluate(() => {
    let nullHits = 0;
    const signHits = new Set<string>();
    for (let y = 120; y <= 820; y += 40) {
      for (let x = 320; x <= 1400; x += 40) {
        const id = window.__lab.pickAt(x, y);
        if (id) signHits.add(id);
        else nullHits++;
      }
    }
    return { nullHits, signHits: [...signHits] };
  });
  check(sweep.nullHits > 20, `墙体/空白区域应返回 null，实际 null 数: ${sweep.nullHits}`);
  check(sweep.signHits.length >= 2, `至少应能点中 2 张可见牌，实际: ${sweep.signHits}`);
  check(
    sweep.signHits.every((id) => r.signs.some((s) => s.id === id)),
    '点选返回了不存在的牌 id',
  );

  // 隔断遮挡验证：网格扫描全屏幕，找出“射线先碰到隔断、其后才有牌”的像素，
  // 直接证明遮挡判定按屏幕实际深度生效（而不是简单地按对象类型）。
  const occlusion = await page.evaluate(() => {
    const lab = window.__lab;
    let occludedPixels = 0;
    const examples: { x: number; y: number }[] = [];
    for (let y = 120; y <= 820; y += 20) {
      for (let x = 320; x <= 1400; x += 20) {
        // pickAt 返回 null 且该像素确实落在某个遮挡物投影内：
        // 用一次“临时把遮挡物去掉”的对照判定该点背后是否有牌
        const direct = lab.pickAt(x, y);
        if (direct === null) {
          // 再问一次：如果该点射线能命中牌，说明是被墙挡住而非空白
          const behind = lab.pickIgnoringOccluders(x, y);
          if (behind) {
            occludedPixels++;
            if (examples.length < 3) examples.push({ x, y });
          }
        }
      }
    }
    return { occludedPixels, examples };
  });
  check(
    occlusion.occludedPixels >= 5,
    `应能找到被墙挡住的牌像素，实际: ${occlusion.occludedPixels}`,
  );

  // ---- 4. 切换朝向模式：锚点位置逐帧不变 ----
  await applyPose('persp-overview');
  const before = await collect();
  await page.evaluate(() => {
    for (const m of ['FIXED', 'BILLBOARD', 'Y_LOCKED']) {
      window.__lab.setFace('shelf-ylock', m);
    }
    window.__lab.setFace('shelf-ylock', 'Y_LOCKED');
  });
  await new Promise((res) => setTimeout(res, 400));
  const after = await collect();
  for (const b of before.signs) {
    const a = after.signs.find((x) => x.id === b.id)!;
    const moved = b.anchor.some((v, i) => Math.abs(v - a.anchor[i]) > 1e-9);
    check(!moved, `切换模式后 ${b.id} 锚点发生移动`);
  }

  // ---- 5. 近裁面：贴近屏幕尺寸牌 D，验证淡入/钳制，且 SCREEN 牌不盖住整屏 ----
  await applyPose('persp-near');
  r = await collect();
  const nearD = r.signs.find((s) => s.id === 'screen-marker')!;
  check(
    nearD.safety === 'NEAR' || nearD.safety === 'CLIPPED' || nearD.safety === 'CLAMPED',
    `近裁面姿态 D 牌应进入 NEAR/CLIPPED/CLAMPED，实际: ${nearD.safety}`,
  );

  // 屏幕占比硬检查：SCREEN 牌被钳制，最大包围高度 ≤ 35% 视口
  const maxRatio = await page.evaluate(() => {
    const cam = window.__lab.rig.active;
    let worst = 0;
    let worstId = '';
    for (const s of window.__lab.signs) {
      if (!s.mesh.visible || s.sizeMode !== 'SCREEN') continue;
      const h = s.baseHeightValue * s.currentScale;
      const w =
        (s.mesh.geometry as { parameters: { width: number } }).parameters.width *
        s.currentScale;
      // 用 mesh 世界矩阵直接变换四角再投影
      const m = s.mesh.matrixWorld;
      const local: [number, number, number][] = [
        [-w / 2, -h / 2, 0],
        [w / 2, -h / 2, 0],
        [w / 2, h / 2, 0],
        [-w / 2, h / 2, 0],
      ];
      const ys: number[] = [];
      for (const [lx, ly, lz] of local) {
        // 从相机位置克隆出一个 Vector3（保证是 Vector3 实例），再归零设为局部角点
        const p = cam.position.clone().set(lx, ly, lz).applyMatrix4(m).project(cam);
        ys.push(p.y);
      }
      const ratio = (Math.max(...ys) - Math.min(...ys)) / 2;
      if (ratio > worst) {
        worst = ratio;
        worstId = s.id;
      }
    }
    return { worst, worstId };
  });
  check(
    maxRatio.worst <= 0.35,
    `近裁面下 SCREEN 牌最大屏幕高度占比 ${maxRatio.worst.toFixed(2)} (${maxRatio.worstId}) 超过 0.35`,
  );

  // ---- 6. 背后姿态：A 牌处于相机身后被隐藏 ----
  await applyPose('persp-behind');
  r = await collect();
  const behindA = r.signs.find((s) => s.id === 'fixed-exit')!;
  check(
    behindA.safety === 'BEHIND',
    `背后姿态 A 牌应为 BEHIND，实际: ${behindA.safety}`,
  );

  // ---- 6. 正交相机远景也正常 ----
  await applyPose('ortho-far');
  r = await collect();
  check(r.cameraKind === 'orthographic', '正交相机切换失败');
  check(r.signs.every((s) => s.safety !== 'CLIPPED'), '正交远景不应有裁切');

  const finalErrors = consoleErrors.filter(
    (e) => !e.includes('WebGL has been used') && !e.includes('GPU'),
  );
  check(finalErrors.length === 0, `控制台错误: ${finalErrors.join(' | ')}`);

  await browser.close();
  await server.close();

  console.log(`截图目录: ${new URL('.', SHOT_DIR).pathname}`);
  if (failures.length) {
    console.error('\n❌ 端到端检查失败:');
    for (const f of failures) console.error(' -', f);
    process.exit(1);
  }
  console.log('✅ 全部端到端检查通过');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
