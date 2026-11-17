import './ui/styles.css';
import { App } from './ui/App';

const app = new App();
app.start();

// Expose for quick manual debugging in the browser console.
declare global {
  interface Window {
    dollyApp: App;
  }
}
window.dollyApp = app;
