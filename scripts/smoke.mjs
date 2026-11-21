#!/usr/bin/env node
/**
 * 端到端冒烟测试：启动真实 Vite 服务 + 无头 Chromium，验证
 *
 *   1. 程序生成的曲面、贴面折线和标签能正常渲染；
 *   2. 折线逐段落在所属三角形平面内，且不越出三角形范围（不穿模、不跨孔）；
 *   3. 旋转模型后，标注点仍贴在表面上（世界坐标跟随模型刚体变换）；
 *   4. 拖动 / 移动一个路线点时只重算相邻线段，其它段 revision 不变；
 *   5. 编辑一个网格顶点后只重算受影响的线段，并且没有旧线段残留；
 *   6. 双岛样例的跨岛线段被判定为“断开”，不会画穿空气的直线；
 *   7. 保存 → 清空 → 载入后，相机、路线长度和表面三角形集合都恢复；
 *   8. 真实鼠标点击能在表面上加点（UI 事件链路可用）。
 *
 * 用法：
 *   node scripts/smoke.mjs            # 自动找本机 Chrome / Playwright Chromium
 *   CHROME_PATH=/path/to/chrome node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.SMOKE_PORT ?? 4173);
const BASE_URL = `http://127.0.0.1:${PORT}/`;

function findChromeExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const playwrightCache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (existsSync(playwrightCache)) {
    const versions = ['chromium-1255', 'chromium-1148'];
    for (const v of versions) {
      candidates.push(
        join(
          playwrightCache,
          v,
          'chrome-mac-arm64',
          'Google Chrome for Testing.app',
          'Contents',
          'MacOS',
          'Google Chrome for Testing',
        ),
      );
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Vite 服务在 ${timeoutMs}ms 内没有就绪: ${url}`);
}

const failures = [];
const passes = [];
function check(name, condition, details) {
  if (condition) {
    passes.push(name);
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, details });
    console.error(`  ✗ ${name}${details ? ` — ${details}` : ''}`);
  }
}

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

async function run() {
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error(
      '找不到可用的 Chrome。请安装 Google Chrome，或用 CHROME_PATH=/path/to/chrome 指定浏览器路径。',
    );
  }

  const vite = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none' } },
  );
  let viteLog = '';
  vite.stdout.on('data', (chunk) => (viteLog += chunk.toString()));
  vite.stderr.on('data', (chunk) => (viteLog += chunk.toString()));

  let browser;
  try {
    await waitForServer(BASE_URL);

    browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('favicon')) pageErrors.push(msg.text());
    });

    const consoleStep = (title) => console.log(`\n${title}`);
    const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__routeApp?.ready === true, null, { timeout: 30000 });
    await settle();

    consoleStep('1. 渲染与初始路线');
    const initial = await page.evaluate(() => ({
      summary: window.__routeApp.getSummary(),
      waypoints: window.__routeApp.getWaypoints(),
      segments: window.__routeApp.getSegments(),
      render: window.__routeApp.getRenderInfo(),
      segmentVisuals: window.__routeApp.countSegmentVisuals(),
      labels: document.querySelectorAll('.pin-label').length,
      measureCards: document.querySelectorAll('.measure-panel').length,
      canvasWidth: document.querySelector('#view').clientWidth,
    }));
    check('曲面网格已生成', initial.render.triangles > 1000, `triangles=${initial.render.triangles}`);
    check('WebGL 至少绘制了一次', initial.render.drawCalls > 0, `drawCalls=${initial.render.drawCalls}`);
    check('默认路线有 5 个点 / 4 段', initial.waypoints.length === 5 && initial.segments.length === 4);
    check('所有线段都连通', initial.segments.every((s) => s.ok));
    check(
      '可视线段对象数量 == 线段数量（无重复对象）',
      initial.segmentVisuals === initial.segments.length,
      `visuals=${initial.segmentVisuals}, segments=${initial.segments.length}`,
    );
    check('存在标注标签', initial.labels >= initial.waypoints.length, `labels=${initial.labels}`);

    consoleStep('2. 折线严格贴在表面三角形内');
    const deviation = await page.evaluate(() => window.__routeApp.maxPathDeviation());
    check(
      '所有折线点都在所属三角形平面上',
      deviation.maxPlaneDeviation < 1e-5,
      `maxPlaneDeviation=${deviation.maxPlaneDeviation.toExponential(2)}`,
    );
    check(
      '没有任何折线段越出所属三角形',
      deviation.maxBaryOvershoot < 1e-4,
      `maxBaryOvershoot=${deviation.maxBaryOvershoot.toExponential(2)}`,
    );

    const holeCheck = await page.evaluate(() => {
      const app = window.__routeApp;
      const holes = app.getHoleCircles();
      const allTris = app.getSegments().flatMap((s) => s.triangles);
      const centroids = app.getTriangleCentroids(allTris);
      let offenders = 0;
      for (const c of centroids) {
        for (const h of holes) {
          const dx = (c[0] - h.center[0]) / (h.radius * 0.85);
          const dz = (c[2] - h.center[1]) / (h.radius * 0.74 * 0.85);
          if (dx * dx + dz * dz < 1) offenders++;
        }
      }
      return { offenders, holes: holes.length, centroidCount: centroids.length };
    });
    check(
      '路线经过的表面三角形都不在孔洞内部',
      holeCheck.offenders === 0,
      `offenders=${holeCheck.offenders}/${holeCheck.centroidCount}`,
    );

    consoleStep('3. 旋转模型后标注仍贴合表面');
    const glueBefore = await page.evaluate(() => window.__routeApp.getMarkerGlue());
    const worldBefore = await page.evaluate(() => window.__routeApp.getSegmentWorldPoints());
    await page.evaluate(() => window.__routeApp.rotateModelY(Math.PI / 3));
    await settle();
    const glueAfter = await page.evaluate(() => window.__routeApp.getMarkerGlue());
    const worldAfter = await page.evaluate(() => window.__routeApp.getSegmentWorldPoints());

    check(
      '旋转后标注点与表面点的距离不变',
      glueBefore.every((b, i) => approx(b.markerToSurface, glueAfter[i].markerToSurface, 1e-6)),
      glueBefore.map((b, i) => `${(glueAfter[i].markerToSurface - b.markerToSurface).toExponential(2)}`).join(','),
    );
    check(
      '旋转确实改变了标注的世界坐标（不是原地不动）',
      worldBefore.some((seg, i) =>
        seg.points.some((p, j) => {
          const q = worldAfter[i].points[j];
          return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 0.5;
        }),
      ),
    );
    const rigid = await page.evaluate(() => window.__routeApp.getMarkerGlue());
    check(
      '旋转后标注距离表面仍在容差内（0.05）',
      rigid.every((g) => g.markerToSurface < 0.05),
      `max=${Math.max(...rigid.map((g) => g.markerToSurface)).toFixed(4)}`,
    );
    await page.evaluate(() => window.__routeApp.rotateModelY(-Math.PI / 3));
    await settle();

    consoleStep('4. 移动路线点只重算相邻线段');
    const moveResult = await page.evaluate(() => {
      const app = window.__routeApp;
      const before = app.getSegments().map((s) => ({ id: s.id, revision: s.revision, length: s.length }));
      const target = app.getWaypoints()[1];
      const oldSummary = app.getSummary().totalLength;
      app.moveWaypoint(target.id, -2.0, 1.2, 2.0);
      const after = app.getSegments().map((s) => ({ id: s.id, revision: s.revision, length: s.length }));
      const changed = after.filter((s, i) => s.revision !== before[i].revision).map((s) => s.id);
      const adjacent = new Set(
        app
          .getSegments()
          .filter((s) => s.fromId === target.id || s.toId === target.id)
          .map((s) => s.id),
      );
      return { changed, adjacent: [...adjacent], oldSummary, newSummary: app.getSummary().totalLength };
    });
    check(
      '只有与移动点相邻的 2 段被更新',
      moveResult.changed.length === 2 &&
        moveResult.changed.every((id) => moveResult.adjacent.includes(id)),
      `changed=${moveResult.changed.length}`,
    );
    check('总长度随移动发生变化', !approx(moveResult.oldSummary, moveResult.newSummary, 1e-4));

    consoleStep('4b. 真实鼠标拖动路线点');
    const dragPoint = await page.evaluate(() => {
      const app = window.__routeApp;
      app.setMode('select');
      app.selectSegment(null);
      return new Promise((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            // 找一个屏幕上可见、且远离侧栏的路线点
            const panel = document.querySelector('#panel').getBoundingClientRect();
            for (const wp of app.getWaypoints()) {
              const pos = app.getWaypointScreenPosition(wp.id);
              if (!pos) continue;
              if (pos.x < panel.right + 30) continue;
              if (!app.getRaycastSurfacePoint(pos.x, pos.y)) continue;
              // 找到拖动目标：同一条水平线上偏移 70px 的表面像素
              for (const dx of [70, -70, 95, -95]) {
                const hit = app.getRaycastSurfacePoint(pos.x + dx, pos.y);
                if (hit) return resolve({ wp, from: pos, to: { x: pos.x + dx, y: pos.y } });
              }
            }
            resolve(null);
          }),
        );
      });
    });

    if (dragPoint) {
      const beforeState = await page.evaluate((id) => {
        const app = window.__routeApp;
        return {
          anchor: app.getWaypoints().find((w) => w.id === id).anchor,
          revisions: app.getSegments().map((s) => ({ id: s.id, revision: s.revision })),
          length: app.getSummary().totalLength,
        };
      }, dragPoint.wp.id);

      await page.mouse.move(dragPoint.from.x, dragPoint.from.y);
      await page.mouse.down();
      await page.mouse.move(dragPoint.to.x, dragPoint.to.y, { steps: 8 });
      await page.mouse.up();
      await settle();

      const afterState = await page.evaluate((id) => {
        const app = window.__routeApp;
        const adjacent = app
          .getSegments()
          .filter((s) => s.fromId === id || s.toId === id)
          .map((s) => s.id);
        return {
          anchor: app.getWaypoints().find((w) => w.id === id).anchor,
          revisions: app.getSegments().map((s) => ({ id: s.id, revision: s.revision })),
          adjacent,
          length: app.getSummary().totalLength,
          deviation: app.maxPathDeviation(),
          visuals: app.countSegmentVisuals(),
          segments: app.getSegments().length,
        };
      }, dragPoint.wp.id);

      const movedAnchor =
        afterState.anchor.tri !== beforeState.anchor.tri ||
        afterState.anchor.bary.some((b, i) => Math.abs(b - beforeState.anchor.bary[i]) > 1e-6);
      const changed = afterState.revisions.filter((s, i) => s.revision !== beforeState.revisions[i].revision);
      check('鼠标拖动确实移动了路线点', movedAnchor);
      check(
        '拖动只重算相邻线段',
        changed.length === afterState.adjacent.length &&
          changed.every((s) => afterState.adjacent.includes(s.id)),
        `changed=${changed.length}, adjacent=${afterState.adjacent.length}`,
      );
      check('拖动后总长度更新', !approx(afterState.length, beforeState.length, 1e-4));
      check(
        '拖动后折线仍严格贴面',
        afterState.deviation.maxPlaneDeviation < 1e-5 && afterState.deviation.maxBaryOvershoot < 1e-4,
      );
      check(
        '拖动后可视对象数量与线段数量一致',
        afterState.visuals === afterState.segments,
        `${afterState.visuals} vs ${afterState.segments}`,
      );
      await page.evaluate(() => window.__routeApp.setMode('add'));
    } else {
      check('能找到可拖动的路线点', false);
    }

    consoleStep('5. 编辑网格顶点只更新受影响线段，无旧路径残留');
    const vertexResult = await page.evaluate(() => {
      const app = window.__routeApp;
      const segsBefore = app.getSegments().map((s) => ({ id: s.id, revision: s.revision }));
      const visualBefore = app.countSegmentVisuals();
      const first = app.getSegments()[0];
      // 取第一段路径中点附近的一个三角形，抬高它附近的一个顶点
      const tri = first.triangles[Math.floor(first.triangles.length / 2)];
      const app2 = app;
      const centroids = app2.getTriangleCentroids([tri]);
      const c = centroids[0];
      const edit = app.editVertexNear(c[0], c[1], c[2], 0.45);
      const segsAfter = app.getSegments().map((s) => ({ id: s.id, revision: s.revision }));
      const changed = segsAfter.filter((s, i) => s.revision !== segsBefore[i].revision).map((s) => s.id);
      return {
        edit,
        changed,
        firstId: first.id,
        visualBefore,
        visualAfter: app.countSegmentVisuals(),
        deviation: app.maxPathDeviation(),
        summary: app.getSummary(),
      };
    });
    check(
      '编辑顶点后至少重算了受影响的线段',
      vertexResult.edit !== null && vertexResult.changed.length >= 1,
      `updated=${vertexResult.edit?.updatedSegments.length ?? 0}`,
    );
    check(
      '第一段（被顶点影响）一定在更新列表里',
      vertexResult.changed.includes(vertexResult.firstId),
      `changed=${vertexResult.changed.join(',')}`,
    );
    check(
      '可视对象数量没有增加（旧路径被替换而不是叠加）',
      vertexResult.visualAfter === vertexResult.visualBefore,
      `${vertexResult.visualBefore} -> ${vertexResult.visualAfter}`,
    );
    check(
      '重算后的折线仍然严格贴面',
      vertexResult.deviation.maxPlaneDeviation < 1e-5 && vertexResult.deviation.maxBaryOvershoot < 1e-4,
      `plane=${vertexResult.deviation.maxPlaneDeviation.toExponential(2)}, bary=${vertexResult.deviation.maxBaryOvershoot.toExponential(2)}`,
    );

    consoleStep('6. 跨面 / 断开表面');
    await page.evaluate(() => window.__routeApp.loadSample('twin-islands'));
    await settle();
    const islands = await page.evaluate(() => ({
      summary: window.__routeApp.getSummary(),
      segments: window.__routeApp.getSegments(),
    }));
    check('双岛样例中存在断开线段', islands.summary.failedCount >= 1);
    check(
      '断开线段原因为 disconnected',
      islands.segments.some((s) => !s.ok && s.reason === 'disconnected'),
      islands.segments.map((s) => `${s.ok ? 'ok' : s.reason}`).join(','),
    );
    check(
      '断开线段没有伪造长度',
      islands.segments.filter((s) => !s.ok).every((s) => s.length === 0),
    );
    const twinDeviation = await page.evaluate(() => window.__routeApp.maxPathDeviation());
    check(
      '双岛样例中连通的线段也严格贴面',
      twinDeviation.maxPlaneDeviation < 1e-5 && twinDeviation.maxBaryOvershoot < 1e-4,
    );

    consoleStep('7. 保存 / 恢复（相机与标注数据）');
    await page.evaluate(() => window.__routeApp.loadSample('curved-holey'));
    await settle();
    const saved = await page.evaluate(() => {
      const app = window.__routeApp;
      app.setCamera({
        position: [5.5, 4.2, 6.1],
        target: [0.4, 0.1, 0.2],
        up: [0, 1, 0],
        fov: 42,
      });
      app.rotateModelY(0.4);
      const save = app.save();
      const summary = app.getSummary();
      const tris = [...new Set(app.getSegments().flatMap((s) => s.triangles))].sort((a, b) => a - b);
      const text = JSON.stringify(save);
      app.loadSample('twin-islands');
      return { save, text, summary, tris };
    });
    await settle();
    const restored = await page.evaluate((text) => {
      const app = window.__routeApp;
      app.restore(text);
      return {
        camera: app.getCamera(),
        summary: app.getSummary(),
        tris: [...new Set(app.getSegments().flatMap((s) => s.triangles))].sort((a, b) => a - b),
        sampleId: app.getSampleId(),
        segments: app.getSegments().length,
      };
    }, saved.text);
    check('恢复后回到了原来的样例', restored.sampleId === 'curved-holey');
    check(
      '相机位置 / 目标 / FOV 完全恢复',
      restored.camera.position.every((v, i) => approx(v, saved.save.camera.position[i], 1e-6)) &&
        restored.camera.target.every((v, i) => approx(v, saved.save.camera.target[i], 1e-6)) &&
        approx(restored.camera.fov, saved.save.camera.fov, 1e-9),
    );
    check(
      '路线总长度恢复',
      approx(restored.summary.totalLength, saved.summary.totalLength, 1e-6),
      `${restored.summary.totalLength} vs ${saved.summary.totalLength}`,
    );
    check(
      '线段数量恢复',
      restored.segments === saved.summary.segmentCount,
      `${restored.segments} vs ${saved.summary.segmentCount}`,
    );
    check(
      '经过的表面三角形集合恢复',
      restored.tris.length === saved.tris.length && restored.tris.every((t, i) => t === saved.tris[i]),
    );
    const rotation = await page.evaluate(() => window.__routeApp.view.getModelRotation());
    check('模型自身的旋转也恢复了', approx(rotation[1], 0.4, 1e-9), `y=${rotation[1]}`);
    const glueAfterRestore = await page.evaluate(() => window.__routeApp.getMarkerGlue());
    check(
      '恢复后标注仍贴在表面上',
      glueAfterRestore.every((g) => g.markerToSurface < 0.05),
      `max=${Math.max(...glueAfterRestore.map((g) => g.markerToSurface)).toFixed(4)}`,
    );
    const restoreDeviation = await page.evaluate(() => window.__routeApp.maxPathDeviation());
    check('恢复后的折线仍严格贴面', restoreDeviation.maxPlaneDeviation < 1e-5);

    consoleStep('8. 真实鼠标点击加点');
    const clickPoint = await page.evaluate(() => {
      const app = window.__routeApp;
      // 斜俯视：画面中心附近既有表面也有孔洞，扫描出第一个真正能命中的像素
      app.setCamera({
        position: [0.2, 7.2, 4.6],
        target: [0.2, 0, 0],
        up: [0, 1, 0],
        fov: 45,
      });
      app.setMode('add');
      app.selectSegment(null);
      return new Promise((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const canvas = document.querySelector('#view');
            const rect = canvas.getBoundingClientRect();
            const panel = document.querySelector('#panel').getBoundingClientRect();
            // 排除落在侧栏下面、以及离已有路线点太近的像素
            const markers = app
              .getWaypoints()
              .map((w) => app.getWaypointScreenPosition(w.id))
              .filter(Boolean);
            for (let gy = 0.15; gy <= 0.9; gy += 0.04) {
              for (let gx = 0.1; gx <= 0.95; gx += 0.04) {
                const x = rect.left + gx * rect.width;
                const y = rect.top + gy * rect.height;
                if (x < panel.right + 16) continue;
                if (markers.some((m) => Math.hypot(m.x - x, m.y - y) < 48)) continue;
                const hit = app.getRaycastSurfacePoint(x, y);
                if (hit) {
                  resolve({ x, y, tri: hit.tri, count: app.getWaypoints().length, segments: app.getSegments().length });
                  return;
                }
              }
            }
            resolve(null);
          }),
        );
      });
    });

    if (clickPoint) {
      await page.mouse.move(clickPoint.x, clickPoint.y);
      await page.mouse.down();
      await page.mouse.up();
      await settle();
      const after = await page.evaluate(() => ({
        count: window.__routeApp.getWaypoints().length,
        segments: window.__routeApp.getSegments().length,
        lastAnchorTri: window.__routeApp.getWaypoints().at(-1).anchor.tri,
        segmentVisuals: window.__routeApp.countSegmentVisuals(),
      }));
      check(
        '在表面上单击会新增路线点与线段',
        after.count === clickPoint.count + 1 && after.segments === clickPoint.segments + 1,
        `${clickPoint.count} -> ${after.count} 点, ${clickPoint.segments} -> ${after.segments} 段`,
      );
      check('新点的锚点就是被点中的三角形', after.lastAnchorTri === clickPoint.tri, `tri=${after.lastAnchorTri}/${clickPoint.tri}`);
      check(
        '新增后可视对象与线段数量仍然一致（没有旧对象残留）',
        after.segmentVisuals === after.segments,
        `visuals=${after.segmentVisuals}, segments=${after.segments}`,
      );
    } else {
      check('能找到可点击的表面像素', false);
    }

    consoleStep('9. 改网格模式：点顶点 → 拖动箭头 → 只更新受影响线段');
    const gizmo = await page.evaluate(() => {
      const app = window.__routeApp;
      app.loadSample('curved-holey');
      app.setMode('vertex');
      return new Promise((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            // 在屏幕上扫描，找第一个“命中的三角形属于某条线段”的像素
            const canvas = document.querySelector('#view');
            const rect = canvas.getBoundingClientRect();
            const segTriangles = new Map();
            for (const seg of app.getSegments()) {
              for (const tri of seg.triangles) {
                if (!segTriangles.has(tri)) segTriangles.set(tri, seg.id);
              }
            }
            for (let gy = 0.2; gy <= 0.85; gy += 0.03) {
              for (let gx = 0.15; gx <= 0.9; gx += 0.03) {
                const x = rect.left + gx * rect.width;
                const y = rect.top + gy * rect.height;
                const hit = app.getRaycastSurfacePoint(x, y);
                if (hit && segTriangles.has(hit.tri)) {
                  resolve({ screen: { x, y }, tri: hit.tri, segmentId: segTriangles.get(hit.tri) });
                  return;
                }
              }
            }
            resolve(null);
          }),
        );
      });
    });

    if (gizmo) {
      const before = await page.evaluate(() => {
        const app = window.__routeApp;
        return {
          revisions: app.getSegments().map((s) => ({ id: s.id, revision: s.revision })),
          visuals: app.countSegmentVisuals(),
          lengths: app.getSegments().map((s) => ({ id: s.id, length: s.length })),
        };
      });
      await page.mouse.click(gizmo.screen.x, gizmo.screen.y);
      await settle();
      const picked = await page.evaluate(() => window.__routeApp.getVertexGizmoState());
      check('点击网格顶点后出现沿法线的拖动手柄', picked.enabled && picked.attached && picked.vertexIndex !== null);

      const nudged = await page.evaluate(() => {
        const app = window.__routeApp;
        const ok = app.nudgeSelectedVertex(0.5);
        return {
          ok,
          revisions: app.getSegments().map((s) => ({ id: s.id, revision: s.revision })),
          lengths: app.getSegments().map((s) => ({ id: s.id, length: s.length })),
          visuals: app.countSegmentVisuals(),
          deviation: app.maxPathDeviation(),
          summary: app.getSummary(),
        };
      });
      const changedIds = nudged.revisions
        .filter((s, i) => s.revision !== before.revisions[i].revision)
        .map((s) => s.id);
      check(
        '拖动网格顶点只更新经过该处三角形的线段',
        nudged.ok && changedIds.length >= 1 && changedIds.includes(gizmo.segmentId),
        `changed=${changedIds.join(',') || '无'}, target=${gizmo.segmentId}`,
      );
      const unchangedBefore = before.lengths.filter(
        (l) => !changedIds.includes(l.id),
      );
      const unchangedAfter = nudged.lengths.filter((l) => !changedIds.includes(l.id));
      check(
        '未受影响的线段长度完全不变',
        unchangedBefore.length === unchangedAfter.length &&
          unchangedBefore.every((l, i) => approx(l.length, unchangedAfter[i].length, 1e-9)),
        `${unchangedBefore.length} 段未变`,
      );
      check(
        '拖动后可视对象数量不变（无旧路径残留）',
        nudged.visuals === before.visuals,
        `${before.visuals} -> ${nudged.visuals}`,
      );
      check(
        '拖动后折线仍严格贴面',
        nudged.deviation.maxPlaneDeviation < 1e-5 && nudged.deviation.maxBaryOvershoot < 1e-4,
        `plane=${nudged.deviation.maxPlaneDeviation.toExponential(2)}`,
      );
    } else {
      check('能在屏幕上找到可直接编辑的网格顶点', false);
    }

    consoleStep('10. 页面无运行时错误');
    check('浏览器控制台 / 页面无错误', pageErrors.length === 0, pageErrors.join(' | '));

    const shotDir = join(process.cwd(), 'artifacts');
    mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: join(shotDir, 'smoke.png') }).catch((err) => {
      console.warn(`截图失败: ${err.message}`);
    });

    console.log(`\n通过 ${passes.length} 项，失败 ${failures.length} 项。`);
    if (failures.length > 0) {
      for (const f of failures) console.error(` - ${f.name}${f.details ? `: ${f.details}` : ''}`);
      process.exitCode = 1;
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    vite.kill('SIGTERM');
    if (viteLog.includes('error')) {
      console.error('\n[vite 日志]\n' + viteLog.slice(-2000));
    }
  }
}

run().catch((err) => {
  console.error('\n冒烟测试失败：', err);
  process.exitCode = 1;
});
