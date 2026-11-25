#!/usr/bin/env node
// Generates the two synthetic, frame-numbered source videos entirely with
// Canvas + MediaRecorder in an installed Chromium/Chrome browser.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public/media');
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const duration = Number(process.env.MEDIA_DURATION || 18);
const fps = 30;

const html = `<!doctype html><html><body><canvas id="c" width="1280" height="720"></canvas></body></html>`;

async function generateInBrowser() {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    page.on('console', msg => console.log('[chrome]', msg.text()));
    const result = await page.evaluate(async ({ duration, fps }) => {
      const candidates = [
        { ext: 'mp4', type: 'video/mp4;codecs=avc1.42E01E' },
        { ext: 'webm', type: 'video/webm;codecs=vp9' },
        { ext: 'webm', type: 'video/webm;codecs=vp8' },
      ];
      const chosen = candidates.find(c => MediaRecorder.isTypeSupported(c.type));
      if (!chosen) throw new Error('No supported MediaRecorder mimeType');

      function roundedRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
      }

      function draw(ctx, route, frame) {
        const W = ctx.canvas.width;
        const H = ctx.canvas.height;
        const t = frame / fps;
        const isA = route === 'A';
        const g = ctx.createLinearGradient(0, 0, W, H);
        if (isA) {
          g.addColorStop(0, '#072f66');
          g.addColorStop(0.55, '#0b6fb8');
          g.addColorStop(1, '#19c2d6');
        } else {
          g.addColorStop(0, '#5b1d05');
          g.addColorStop(0.55, '#c2410c');
          g.addColorStop(1, '#f59e0b');
        }
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);

        // Safe-area grid.
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
        ctx.lineWidth = 2;
        for (let x = 80; x < W; x += 80) {
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        }
        for (let y = 80; y < H; y += 80) {
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        }

        // Same-time moving marker in both recordings.
        const travelX = 120 + ((t * 260) % (W - 240));
        ctx.fillStyle = '#fde047';
        roundedRect(ctx, travelX - 34, 586, 68, 54, 10);
        ctx.fill();
        ctx.fillStyle = '#111827';
        ctx.font = '900 28px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('▼', travelX, 624);

        // Frame corner markers alternate every frame so decoding is visible.
        ctx.fillStyle = frame % 2 === 0 ? '#ffffff' : '#111827';
        for (const [x, y] of [[34, 34], [W - 74, 34], [34, H - 74], [W - 74, H - 74]]) {
          ctx.fillRect(x, y, 40, 40);
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 3;
          ctx.strokeRect(x, y, 40, 40);
        }

        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0,0,0,0.34)';
        roundedRect(ctx, 150, 72, W - 300, 112, 24);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = '900 58px system-ui, -apple-system, "PingFang SC", sans-serif';
        ctx.fillText(isA ? 'A  主 PROGRAM' : 'B  备 BACKUP', W / 2, 148);

        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        roundedRect(ctx, 190, 218, W - 380, 238, 28);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = '900 118px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(`F ${String(frame).padStart(4, '0')}`, W / 2, 342);
        ctx.font = '800 54px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(`T+${t.toFixed(3)}s`, W / 2, 424);

        ctx.font = '700 30px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fillText('COMMON CONTENT TIMEBASE · 30 FPS', W / 2, 505);

        ctx.lineWidth = 18;
        ctx.strokeStyle = isA ? '#67e8f9' : '#fed7aa';
        ctx.strokeRect(9, 9, W - 18, H - 18);
      }

      function record(route) {
        return new Promise((resolve, reject) => {
          const canvas = document.getElementById('c');
          const ctx = canvas.getContext('2d', { alpha: false });
          const stream = canvas.captureStream(fps);
          const recorder = new MediaRecorder(stream, {
            mimeType: chosen.type,
            videoBitsPerSecond: 2_500_000,
          });
          const chunks = [];
          recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
          recorder.onerror = reject;
          recorder.onstop = async () => {
            stream.getTracks().forEach(track => track.stop());
            const blob = new Blob(chunks, { type: chosen.type.split(';')[0] });
            const buffer = new Uint8Array(await blob.arrayBuffer());
            let binary = '';
            const chunkSize = 0x8000;
            for (let i = 0; i < buffer.length; i += chunkSize) {
              binary += String.fromCharCode(...buffer.subarray(i, i + chunkSize));
            }
            resolve({ ext: chosen.ext, base64: btoa(binary), bytes: buffer.length });
          };

          const totalFrames = Math.round(duration * fps);
          let frame = 0;
          draw(ctx, route, frame);
          recorder.start(200);
          const started = performance.now();
          const timer = setInterval(() => {
            frame += 1;
            if (frame >= totalFrames) {
              clearInterval(timer);
              // Let the final frame and recorder flush.
              setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), 350);
              return;
            }
            draw(ctx, route, frame);
            const expected = frame * 1000 / fps;
            const elapsed = performance.now() - started;
            if (elapsed > expected + 80) {
              console.warn(`${route} recorder drawing is behind`, { frame, elapsed, expected });
            }
          }, 1000 / fps);
        });
      }

      // Record sequentially so both clips receive perfectly regular canvas
      // updates instead of competing for software encoder time.
      const a = await record('A');
      const b = await record('B');
      return { mimeType: chosen.type, a, b };
    }, { duration, fps });
    return result;
  } finally {
    await browser.close();
  }
}

await mkdir(outDir, { recursive: true });
const media = await generateInBrowser();
const aPath = resolve(outDir, `program-a.${media.a.ext}`);
const bPath = resolve(outDir, `backup-b.${media.b.ext}`);
await writeFile(aPath, Buffer.from(media.a.base64, 'base64'));
await writeFile(bPath, Buffer.from(media.b.base64, 'base64'));
const manifest = {
  mimeType: media.mimeType,
  generatedAt: new Date().toISOString(),
  A: `/media/program-a.${media.a.ext}`,
  B: `/media/backup-b.${media.b.ext}`,
};
await writeFile(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ ...manifest, aPath, aBytes: media.a.bytes, bPath, bBytes: media.b.bytes }, null, 2));
