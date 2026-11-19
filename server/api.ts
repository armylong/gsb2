/**
 * Local HTTP API. The Vite dev server in front of it only deals with the UI;
 * all image work stays here so Node + sharp remain the source of truth.
 */

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { AtlasService } from '../server/service';
import type { AnimationSpec, PackSettings } from '../shared/types';
import { DEFAULT_ANIMATION } from '../shared/types';

export interface ApiAppOptions {
  service?: AtlasService;
  /** Serve the built UI from this directory when present (production mode). */
  staticDir?: string;
}

export function createApiApp(options: ApiAppOptions = {}) {
  const service = options.service ?? new AtlasService();
  const app = express();
  app.use(express.json({ limit: '96mb' }));

  const wrap =
    (handler: (req: Request, res: Response) => Promise<void> | void) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        await handler(req, res);
      } catch (error) {
        next(error);
      }
    };

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, frames: service.store.size });
  });

  app.get(
    '/api/frames',
    wrap((_req, res) => {
      res.json({ frames: service.listFrames() });
    }),
  );

  app.post(
    '/api/import',
    wrap(async (req, res) => {
      const body = req.body as { files?: { name?: string; sourceKey?: string; dataBase64?: string }[] };
      if (!body || !Array.isArray(body.files)) {
        res.status(400).json({ error: 'Request body must be { files: [...] }' });
        return;
      }
      const files = body.files.map((file) => ({
        name: String(file.name ?? ''),
        sourceKey: String(file.sourceKey ?? file.name ?? ''),
        dataBase64: String(file.dataBase64 ?? ''),
      }));
      const invalid = files.filter((file) => !file.name || !file.dataBase64);
      if (invalid.length > 0) {
        res.status(400).json({ error: 'Each file needs a name and dataBase64' });
        return;
      }
      res.json(await service.importMany(files));
    }),
  );

  app.post(
    '/api/frames/samples',
    wrap(async (_req, res) => {
      res.json(await service.loadSamples());
    }),
  );

  app.post(
    '/api/frames/remove',
    wrap((req, res) => {
      const body = req.body as { ids?: string[] };
      if (!body || !Array.isArray(body.ids)) {
        res.status(400).json({ error: 'Request body must be { ids: string[] }' });
        return;
      }
      service.removeFrames(body.ids.map(String));
      res.json({ frames: service.listFrames() });
    }),
  );

  app.get(
    '/api/src/:id.png',
    wrap((req, res) => {
      const png = service.getSourcePng(String(req.params.id));
      if (!png) {
        res.status(404).json({ error: 'Unknown source frame' });
        return;
      }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(png);
    }),
  );

  app.post(
    '/api/pack',
    wrap(async (req, res) => {
      const body = req.body as { settings?: PackSettings; frameIds?: string[] };
      if (!body || typeof body.settings !== 'object' || body.settings === null) {
        res.status(400).json({ error: 'Request body must be { settings, frameIds? }' });
        return;
      }
      if (body.frameIds !== undefined && !Array.isArray(body.frameIds)) {
        res.status(400).json({ error: 'frameIds must be an array of frame ids' });
        return;
      }
      res.json(await service.pack(body.settings, body.frameIds));
    }),
  );

  app.get(
    '/api/build/:buildId/:file',
    wrap((req, res) => {
      const png = service.getPagePng(String(req.params.buildId), String(req.params.file));
      if (!png) {
        res.status(404).json({ error: 'Unknown page' });
        return;
      }
      res.setHeader('Content-Type', 'image/png');
      res.send(png);
    }),
  );

  app.post(
    '/api/export',
    wrap(async (req, res) => {
      const body = req.body as { buildId?: string; animation?: AnimationSpec };
      if (!body || typeof body.buildId !== 'string') {
        res.status(400).json({ error: 'Request body must be { buildId, animation }' });
        return;
      }
      const animation = normalizeAnimation(body.animation);
      res.json(await service.export(body.buildId, animation));
    }),
  );

  app.get(
    '/api/export/:exportId/file/*path',
    wrap((req, res) => {
      const rawPath = req.params.path;
      const path = Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath ?? '');
      const file = service.getExportFile(String(req.params.exportId), path);
      if (!file) {
        res.status(404).json({ error: 'Unknown export file' });
        return;
      }
      res.setHeader('Content-Type', contentType(path));
      res.send(Buffer.from(file));
    }),
  );

  app.get(
    '/api/export/:exportId/zip',
    wrap((req, res) => {
      const record = service.getExport(String(req.params.exportId));
      if (!record) {
        res.status(404).json({ error: 'Unknown export' });
        return;
      }
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="sprite-atlas-${record.exportId}.zip"`);
      res.send(record.artifacts.zip);
    }),
  );

  app.get(
    '/api/export/:exportId/atlas.json',
    wrap((req, res) => {
      const record = service.getExport(String(req.params.exportId));
      if (!record) {
        res.status(404).json({ error: 'Unknown export' });
        return;
      }
      res.json(record.artifacts.manifest);
    }),
  );

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  });

  if (options.staticDir) {
    app.use(express.static(options.staticDir));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) {
        next();
        return;
      }
      res.sendFile('index.html', { root: options.staticDir! });
    });
  }

  return { app, service };
}

export function normalizeAnimation(input: unknown): AnimationSpec {
  const candidate = (input ?? {}) as Partial<AnimationSpec>;
  const frames = Array.isArray(candidate.frames)
    ? candidate.frames
        .filter((frame) => frame && typeof frame.id === 'string')
        .map((frame) => ({
          id: String(frame.id),
          durationMs: Number.isFinite(frame.durationMs) ? Math.round(frame.durationMs) : 120,
        }))
    : [];
  return {
    format: DEFAULT_ANIMATION.format,
    name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : 'animation',
    loop: typeof candidate.loop === 'boolean' ? candidate.loop : true,
    anchor:
      candidate.anchor &&
      Number.isFinite(candidate.anchor.x) &&
      Number.isFinite(candidate.anchor.y)
        ? { x: candidate.anchor.x, y: candidate.anchor.y }
        : { ...DEFAULT_ANIMATION.anchor },
    frames,
  };
}

function contentType(path: string): string {
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (path.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}
