export interface ClassifierLike {
  symbols: string[];
  errors: string[];
  files: string[];
  businessAreas: string[];
  technologies: string[];
  taskType?: string;
}

export interface Chip {
  kind: 'task' | 'symbol' | 'file' | 'error' | 'tech' | 'area';
  label: string;
}

export function toSignalChips(c: ClassifierLike): Chip[] {
  const chips: Chip[] = [];
  if (c.taskType) chips.push({ kind: 'task', label: c.taskType });
  c.symbols.forEach((s) => chips.push({ kind: 'symbol', label: s }));
  c.files.forEach((s) => chips.push({ kind: 'file', label: s }));
  c.errors.forEach((s) => chips.push({ kind: 'error', label: s }));
  c.technologies.forEach((s) => chips.push({ kind: 'tech', label: s }));
  c.businessAreas.forEach((s) => chips.push({ kind: 'area', label: s }));
  return chips;
}
