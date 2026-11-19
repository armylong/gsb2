import type { ReactNode } from 'react';

interface SectionProps {
  title: string;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}

export function Section({ title, eyebrow, actions, children, className, id }: SectionProps) {
  return (
    <section className={['panel', className].filter(Boolean).join(' ')} id={id}>
      <header className="panel-head">
        <div>
          {eyebrow ? <p className="panel-eyebrow">{eyebrow}</p> : null}
          <h2 className="panel-title">{title}</h2>
        </div>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}
