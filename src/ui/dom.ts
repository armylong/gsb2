export function $(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少元素 #${id}`);
  return element;
}

export function $button(id: string): HTMLButtonElement {
  const element = $(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`#${id} 不是按钮`);
  return element;
}

export function $input(id: string): HTMLInputElement {
  const element = $(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`#${id} 不是输入框`);
  return element;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function clearChildren(element: HTMLElement): void {
  while (element.firstChild) element.removeChild(element.firstChild);
}

export function setText(id: string, text: string): void {
  $(id).textContent = text;
}

export function fmt(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  return value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '.0');
}

export function fmtVec(v: readonly number[], digits = 3): string {
  return `(${v.map((item) => fmt(item, digits)).join(', ')})`;
}

export function setStatus(text: string, tone: 'ok' | 'bad' | 'neutral' = 'neutral'): void {
  const element = document.getElementById('view-status');
  if (!element) return;
  element.textContent = text;
  element.classList.toggle('ok', tone === 'ok');
  element.classList.toggle('bad', tone === 'bad');
}

export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
