import type { TaskType, ContextNoiseTolerance } from '../types.js';

export const TASK_TYPES = [
  'debugging',
  'implementation',
  'refactor',
  'review',
  'planning',
  'exploration',
  'testing',
  'unknown',
] as const satisfies readonly TaskType[];

export const TASK_TYPE_ALIASES = new Map<string, TaskType>([
  ['bug', 'debugging'],
  ['bug_fix', 'debugging'],
  ['bugfix', 'debugging'],
  ['coding', 'implementation'],
  ['development', 'implementation'],
  ['investigation', 'debugging'],
]);

/** Normalize a raw taskType string: trim, lowercase, collapse spaces/hyphens to underscore. */
export function taskTypeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/** Type guard: is `t` a canonical TaskType (not just an alias)? */
export const isTaskType = (t: string): t is TaskType => (TASK_TYPES as readonly string[]).includes(t);

export const CONTEXT_MODES = ['compact', 'layered'] as const;
export const CONTEXT_NOISE_TOLERANCES = ['balanced', 'strict'] as const satisfies readonly ContextNoiseTolerance[];
