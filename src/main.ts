import { App } from './app';

const canvas = document.getElementById('scene') as HTMLCanvasElement | null;
if (!canvas) throw new Error('缺少 #scene canvas 元素');
new App(canvas);
