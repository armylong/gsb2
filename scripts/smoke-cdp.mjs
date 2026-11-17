/**
 * Minimal Chrome DevTools Protocol smoke driver (no external deps; uses the
 * Node global WebSocket). Launches headless Chrome against the Vite dev server,
 * loads the app, collects console messages / page exceptions, waits long enough
 * for several animation frames, then:
 *   - asserts no uncaught errors,
 *   - reads back WebGL canvas pixels to prove both viewports actually rendered,
 *   - saves a screenshot for manual inspection.
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const PORT = 9222;
const OUT = '/tmp/dolly-shot';

function getJSON(path) {
  return fetch(`http://127.0.0.1:${PORT}${path}`).then((r) => r.json());
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      '--disable-gpu',
      '--no-sandbox',
      '--enable-unsafe-swiftshader',
      '--window-size=1600,1000',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );

  const errors = [];
  const logs = [];
  try {
    let target;
    for (let i = 0; i < 40; i++) {
      try {
        const list = await getJSON('/json');
        target = list.find((t) => t.type === 'page');
        if (target?.webSocketDebuggerUrl) break;
      } catch {
        /* retry */
      }
      await sleep(250);
    }
    if (!target) throw new Error('Chrome DevTools endpoint did not come up');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = (e) => rej(e);
    });

    let id = 0;
    const pending = new Map();
    const send = (method, params = {}) =>
      new Promise((res) => {
        const mid = ++id;
        pending.set(mid, res);
        ws.send(JSON.stringify({ id: mid, method, params }));
      });

    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result);
        pending.delete(msg.id);
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map((a) => a.value ?? a.description).join(' ');
        logs.push(`[console.${msg.params.type}] ${text}`);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push(d.exception?.description ?? d.text);
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        errors.push(msg.params.entry.text);
      }
    };

    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: URL });

    // Let the app mount and render many frames.
    await sleep(3500);

    // Functional probes inside the page.
    const probe = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const canvases = [...document.querySelectorAll('canvas')];
        const glInfo = canvases.map((c) => {
          const gl = c.getContext('webgl2') || c.getContext('webgl');
          let nonZero = 0;
          if (gl) {
            const px = new Uint8Array(c.width * c.height * 4);
            gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
            for (let i = 0; i < px.length; i += 4096) if (px[i] + px[i+1] + px[i+2] > 0) nonZero++;
          }
          return { width: c.width, height: c.height, sampledNonZero: nonZero };
        });
        const app = window.dollyApp;
        return {
          canvasCount: canvases.length,
          glInfo,
          hasApp: !!app,
          leftPanelText: document.getElementById('left-panel')?.innerText?.slice(0, 40),
          readoutText: document.getElementById('readout')?.innerText?.slice(0, 60),
          hasVerifyButton: !!document.getElementById('verify'),
        };
      })()`,
    });

    // Exercise the app through its public surface to surface runtime errors.
    const interaction = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const a = window.dollyApp;
        a.seek(4);
        for (const id of ['ordinary','vertical','closed']) {
          a.applyPresetPublic(id);
          a.seek(a.duration / 2);
        }
        a.applyPresetPublic('closed');
        a.seek(0);
        const start = a.constructor ? document.getElementById('readout').innerText : '';
        a.seek(a.duration);
        const seam = document.getElementById('readout').innerText;
        return { startReadout: start.slice(0, 70), seamReadout: seam.slice(0, 70) };
      })()`,
    });

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`${OUT}/smoke.png`, Buffer.from(shot.data, 'base64'));

    console.log('CONSOLE LOGS:', logs.length ? logs.join('\n') : '(none)');
    console.log('PAGE ERRORS:', errors.length ? errors.join('\n') : '(none)');
    console.log('PROBE:', JSON.stringify(probe.result.value, null, 2));
    console.log('INTERACTION:', JSON.stringify(interaction.result.value, null, 2));

    ws.close();

    const v = probe.result.value;
    const ok =
      errors.length === 0 &&
      v.hasApp &&
      v.canvasCount === 2 &&
      v.glInfo.every((g) => g.sampledNonZero > 0);
    console.log(ok ? '\nSMOKE PASS' : `\nSMOKE FAIL (canvasCount=${v.canvasCount})`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    try {
      process.kill(-chrome.pid);
    } catch {
      /* already gone */
    }
  }
}

main().catch((e) => {
  console.error('smoke driver failed:', e);
  process.exit(1);
});
