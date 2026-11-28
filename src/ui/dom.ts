type Child = Node | string | number | null | undefined | false;

export interface ElOptions {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string | number | boolean>;
  style?: Partial<CSSStyleDeclaration>;
  on?: Partial<Record<keyof HTMLElementEventMap, (event: never) => void>>;
  dataset?: Record<string, string>;
}

/** 极简 DOM 构造器：避免整页 innerHTML，便于挂事件与保持可读性。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title) node.title = options.title;
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      if (value === false || value === undefined) continue;
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  if (options.style) Object.assign(node.style, options.style);
  if (options.dataset) {
    for (const [key, value] of Object.entries(options.dataset)) node.dataset[key] = value;
  }
  if (options.on) {
    for (const [event, handler] of Object.entries(options.on)) {
      node.addEventListener(event, handler as EventListener);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'number' ? String(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.firstChild.remove();
}

export function icon(name: 'rotate' | 'flip' | 'undo' | 'eye' | 'mask' | 'inspect' | 'check' | 'cross' | 'play' | 'reset' | 'stamp'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  const paths: Record<typeof name, string> = {
    rotate: 'M20 7v5h-5M4 17v-5h5M6.6 8.5A7.5 7.5 0 0 1 20 12M17.4 15.5A7.5 7.5 0 0 1 4 12',
    flip: 'M12 3v18M8 7 4 12l4 5M16 7l4 5-4 5',
    undo: 'M9 14 4 9l5-5M4 9h9a6 6 0 1 1 0 12h-3',
    eye: 'M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Zm10 2.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z',
    mask: 'M5 4h14v16H5zM5 8h14M9 4v4M15 4v4M8 13h8M8 16h5',
    inspect: 'M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Zm5.6-1.9L21 21',
    check: 'm4 12.5 5 5L20 6.5',
    cross: 'M6 6l12 12M18 6 6 18',
    play: 'M8 5.5v13l11-6.5z',
    reset: 'M4 4v6h6M20 20v-6h-6M5.6 15a7 7 0 0 0 11.7 2.6L20 14M4 10l2.7-3.6A7 7 0 0 1 18.4 9',
    stamp: 'M6 3h12l-1.5 7h-9L6 3Zm3.5 7v4h5v-4M5 18h14v3H5z',
  };
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.7');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

export function chip(text: string, className = ''): HTMLSpanElement {
  return el('span', { class: `chip ${className}`.trim(), text });
}
