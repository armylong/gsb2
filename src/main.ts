import { SceneApp } from './SceneApp';
import { buildUI } from './ui';
import { DEFAULT_PARAMS, DEFAULT_ANGLES, DEFAULT_BASE } from './config';
import './styles.css';

const container = document.getElementById('viewport')!;
const panel = document.getElementById('panel')!;

const scene = new SceneApp(container, DEFAULT_PARAMS, DEFAULT_ANGLES, DEFAULT_BASE);
buildUI(panel, scene);

// Test hook: lets the Playwright e2e script drive the real running app.
(window as unknown as Record<string, unknown>).__armScene = scene;
