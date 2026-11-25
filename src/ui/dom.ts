// 极简 hyperscript 辅助：h('div.cls#id', {onClick}, children)
export type ElChild = Node | string | null | undefined | false | ElChild[];

type Props = Record<string, unknown>;

function parseSelector(sel: string): { tag: string; id?: string; classes: string[] } {
  const m = sel.match(/^([a-zA-Z0-9-]+)?(.*)$/s)!;
  const tag = m[1] || 'div';
  const rest = m[2] || '';
  let id: string | undefined;
  const classes: string[] = [];
  for (const token of rest.match(/[#.][^#.]+/g) ?? []) {
    if (token.startsWith('#')) id = token.slice(1);
    else classes.push(token.slice(1));
  }
  return { tag, id, classes };
}

export function h(selector: string, props?: Props | null, ...children: ElChild[]): HTMLElement {
  const { tag, id, classes } = parseSelector(selector);
  const el = document.createElement(tag);
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(' ');

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'dataset') {
        Object.assign(el.dataset, value as Record<string, string>);
      } else if (key === 'text') {
        el.textContent = String(value);
      } else if (key === 'html') {
        el.innerHTML = String(value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key === 'aria') {
        for (const [ak, av] of Object.entries(value as Record<string, string>)) {
          el.setAttribute(`aria-${ak}`, av);
        }
      } else if (key === 'role') {
        el.setAttribute('role', String(value));
      } else {
        el.setAttribute(key, String(value === true ? '' : value));
      }
    }
  }

  appendChildren(el, children);
  return el;
}

function appendChildren(el: HTMLElement, children: ElChild[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(el, child);
    } else if (child instanceof Node) {
      el.appendChild(child);
    } else {
      el.appendChild(document.createTextNode(String(child)));
    }
  }
}

/** 清空容器并渲染新内容。 */
export function mount(container: HTMLElement, node: Node): void {
  container.replaceChildren(node);
}
