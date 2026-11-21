import { Camera, Vector3 } from 'three';
import { CullFrame } from '../culling/cullController';
import { reasonText } from '../culling/cullController';
import { SampleScene } from '../scene/sampleScene';

interface LabelEntry {
  el: HTMLDivElement;
  kind: 'group' | 'mesh';
  id: string;
}

const STATUS_CLASS: Record<string, string> = {
  in: 'label-in',
  intersect: 'label-intersect',
  out: 'label-out',
};

export class LabelOverlay {
  private entries: LabelEntry[] = [];
  private projection = new Vector3();

  constructor(
    private container: HTMLElement,
    scene: SampleScene,
  ) {
    for (const groupEntity of scene.groups) {
      this.entries.push({ el: this.make(groupEntity.id, 'group'), kind: 'group', id: groupEntity.id });
      for (const member of groupEntity.members) {
        this.entries.push({ el: this.make(member.id, 'mesh'), kind: 'mesh', id: member.id });
      }
    }
  }

  private make(id: string, kind: 'group' | 'mesh'): HTMLDivElement {
    const el = document.createElement('div');
    el.className = `tag tag-${kind}`;
    el.textContent = id;
    el.dataset.id = id;
    el.dataset.kind = kind;
    this.container.appendChild(el);
    return el;
  }

  update(frame: CullFrame, overviewCamera: Camera, width: number, height: number): void {
    const lookup = new Map<string, { status: string; text: string; world: Vector3; drawn: boolean }>();
    for (const groupInfo of frame.groups) {
      lookup.set(groupInfo.groupEntity.id, {
        status: groupInfo.result.status,
        text: reasonText(groupInfo.result),
        world: groupInfo.groupEntity.worldSphere.center,
        drawn: groupInfo.result.status !== 'out',
      });
      for (const member of groupInfo.members) {
        lookup.set(member.entity.id, {
          status: member.drawn ? member.result.status : 'out',
          text: reasonText(member.result),
          world: member.entity.worldSphere.center,
          drawn: member.drawn,
        });
      }
    }

    for (const entry of this.entries) {
      const info = lookup.get(entry.id);
      if (!info) {
        entry.el.style.display = 'none';
        continue;
      }
      this.projection.copy(info.world).project(overviewCamera);
      const behind = this.projection.z > 1 || this.projection.z < -1;
      if (behind) {
        entry.el.style.display = 'none';
        continue;
      }
      entry.el.style.display = '';
      const x = (this.projection.x * 0.5 + 0.5) * width;
      const y = (-this.projection.y * 0.5 + 0.5) * height;
      entry.el.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      entry.el.classList.remove('label-in', 'label-intersect', 'label-out');
      entry.el.classList.add(STATUS_CLASS[info.status]);
      entry.el.textContent = `${entry.id} · ${info.text}${entry.kind === 'mesh' ? (info.drawn ? ' · 提交' : ' · 剔除') : ''}`;
    }
  }

  setVisible(visible: boolean): void {
    this.container.style.display = visible ? '' : 'none';
  }
}
