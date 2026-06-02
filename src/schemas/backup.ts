import { z } from 'zod';
import type {
  CleanupOperationsInput,
  CreateBackupInput,
  BackupRetentionInput,
  RestoreBackupInput,
} from '../types.js';
import { zOptionalString, zPositiveInteger } from './primitives.js';

export const cleanupOperationsSchema = z.object({
  olderThanDays: zPositiveInteger.optional(),
  dryRun: z.boolean().optional(),
}) as z.ZodType<CleanupOperationsInput>;

export const createBackupSchema = z.object({
  id: zOptionalString,
  reason: zOptionalString,
  prune: z.boolean().optional(),
}) as z.ZodType<CreateBackupInput>;

export const backupRetentionSchema = z.object({
  dryRun: z.boolean().optional(),
  keepCount: zPositiveInteger.optional(),
  maxAgeDays: zPositiveInteger.optional(),
}) as z.ZodType<BackupRetentionInput>;

export const restoreBackupSchema = z.object({
  backupIdOrPath: zOptionalString,
  dryRun: z.boolean().optional(),
  replace: z.boolean().optional(),
}) as z.ZodType<RestoreBackupInput>;
