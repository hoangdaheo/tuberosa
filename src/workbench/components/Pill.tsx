import type { ComponentChildren } from 'preact';

type PillKind = 'default' | 'accent' | 'good' | 'warn' | 'bad' | 'muted';

interface Props {
  kind?: PillKind;
  children: ComponentChildren;
  title?: string;
}

export function Pill({ kind = 'default', children, title }: Props) {
  const cls = kind === 'default' ? 'pill' : `pill ${kind}`;
  return <span class={cls} title={title}>{children}</span>;
}
