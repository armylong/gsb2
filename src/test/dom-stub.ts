/**
 * Minimal DOM stub — just enough surface for the App controller to mount its
 * panels and wire event handlers in a headless (node) environment. It parses a
 * small, controlled subset of HTML (tags carrying an id or data-* attribute)
 * so getElementById/querySelectorAll work against innerHTML markup. It is not a
 * browser: WebGL viewports are injected separately and never instantiated here.
 */

type Handler = (e?: Event) => void;

export class StubElement {
  tagName: string;
  id = '';
  className = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  value = '';
  disabled = false;
  onclick: Handler | null = null;
  onchange: Handler | null = null;
  oninput: Handler | null = null;
  readonly children: StubElement[] = [];
  clientWidth = 800;
  clientHeight = 600;
  private readonly handlers: Record<string, Handler> = {};
  private readonly doc: () => StubDocument;
  private _innerHTML = '';

  constructor(tag: string, doc: () => StubDocument) {
    this.tagName = tag.toUpperCase();
    this.doc = doc;
  }

  get innerHTML(): string {
    return this._innerHTML;
  }
  set innerHTML(v: string) {
    this._innerHTML = v;
    this.children.length = 0;
    parseMarkup(v, this.doc(), this);
  }

  get textContent(): string {
    return this._innerHTML.replace(/<[^>]*>/g, '');
  }
  set textContent(v: string) {
    this._innerHTML = v;
  }

  classList = {
    _set: new Set<string>(),
    add: (c: string) => this.classList._set.add(c),
    remove: (c: string) => this.classList._set.delete(c),
    toggle: (c: string, on?: boolean) => {
      const has = this.classList._set.has(c);
      const want = on === undefined ? !has : on;
      if (want) this.classList._set.add(c);
      else this.classList._set.delete(c);
    },
    contains: (c: string) => this.classList._set.has(c),
  };

  appendChild(c: StubElement): StubElement {
    this.children.push(c);
    return c;
  }
  removeChild(c: StubElement): void {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
  }
  addEventListener(type: string, fn: Handler): void {
    this.handlers[type] = fn;
  }
  removeEventListener(): void {
    /* no-op */
  }
  dispatch(type: string, event?: Event): void {
    this.handlers[type]?.(event);
  }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  querySelectorAll(sel: string): StubElement[] {
    const attrMatch = sel.match(/^\[([^\]=]+)(?:=[^\]]*)?\]$/);
    const idMatch = sel.match(/^#([\w-]+)$/);
    const tag = sel.match(/^([a-zA-Z][\w-]*)$/)?.[1]?.toUpperCase();
    const out: StubElement[] = [];
    const walk = (el: StubElement): void => {
      for (const c of el.children) {
        let match = false;
        const dataKey = attrMatch
          ? attrMatch[1].startsWith('data-')
            ? attrMatch[1].slice(5)
            : attrMatch[1]
          : undefined;
        if (tag && c.tagName === tag) match = true;
        if (idMatch && c.id === idMatch[1]) match = true;
        if (dataKey && dataKey in c.dataset) match = true;
        if (match) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): StubElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  getBoundingClientRect(): DOMRect {
    return {
      left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  }
}

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseMarkup(markup: string, doc: StubDocument, parent: StubElement): void {
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(markup)) !== null) {
    const tag = m[1];
    const attrs = m[2] ?? '';
    const el = doc.createElement(tag);
    let a: RegExpExecArray | null;
    ATTR_RE.lastIndex = 0;
    while ((a = ATTR_RE.exec(attrs)) !== null) {
      const name = a[1];
      const val = a[2] ?? a[3] ?? a[4] ?? '';
      if (name === 'id') {
        el.id = val;
        doc.register(el);
      } else if (name === 'class') {
        el.className = val;
        val.split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
      } else if (name.startsWith('data-')) {
        el.dataset[name.slice(5)] = val;
        doc.registerData(el);
      } else if (name === 'value') {
        el.value = val;
      } else if (name === 'disabled') {
        el.disabled = true;
      }
    }
    parent.children.push(el);
  }
}

export interface StubDocument {
  elements: Map<string, StubElement>;
  byData: Map<string, StubElement[]>;
  createElement(tag: string): StubElement;
  getElementById(id: string): StubElement;
  querySelectorAll(sel: string): StubElement[];
  register(el: StubElement): void;
  registerData(el: StubElement): void;
  body: StubElement;
}

export function createStubDocument(): StubDocument {
  const elements = new Map<string, StubElement>();
  const byData = new Map<string, StubElement[]>();
  const self: StubDocument = {
    elements,
    byData,
    body: null as unknown as StubElement,
    createElement(tag: string): StubElement {
      return new StubElement(tag, () => self);
    },
    register(el: StubElement): void {
      elements.set(el.id, el);
    },
    registerData(el: StubElement): void {
      for (const key of Object.keys(el.dataset)) {
        const list = byData.get(key) ?? [];
        if (!list.includes(el)) list.push(el);
        byData.set(key, list);
      }
    },
    getElementById(id: string): StubElement {
      let el = elements.get(id);
      if (!el) {
        el = new StubElement('div', () => self);
        el.id = id;
        elements.set(id, el);
      }
      return el;
    },
    querySelectorAll(sel: string): StubElement[] {
      // Supports [data-x], [data-x="v"] and #id selectors used by the App.
      const attrMatch = sel.match(/^\[([^\]=]+)(?:=[^\]]*)?\]$/);
      const idMatch = sel.match(/^#([\w-]+)$/);
      if (attrMatch) {
        const raw = attrMatch[1].startsWith('data-') ? attrMatch[1].slice(5) : attrMatch[1];
        return byData.get(raw) ?? [];
      }
      if (idMatch) {
        const e = elements.get(idMatch[1]);
        return e ? [e] : [];
      }
      return [];
    },
  };
  self.body = new StubElement('body', () => self);
  return self;
}
