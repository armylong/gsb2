import './style.css';
import { App } from './ui/app';

const root = document.querySelector<HTMLElement>('#root');
if (!root) {
  throw new Error('缺少 #root 容器');
}

declare global {
  interface Window {
    __logicLab?: App;
  }
}

window.__logicLab = new App(root);
