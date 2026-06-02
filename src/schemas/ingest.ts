import { z } from 'zod';
import type { IngestFileInput } from '../ingest/service.js';
import { KNOWLEDGE_ITEM_TYPES, INGESTION_MODES } from './enums.js';
import { zRequiredString, zOptionalString, zRecord } from './primitives.js';
import { optionalLabelsSchema } from './common.js';

/**
 * Per-file shape (matches validateIngestFileInput). `project` defaults to the
 * request-level project when omitted; otherwise must be a non-blank string.
 */
function ingestFileSchema(defaultProject: string): z.ZodType<IngestFileInput> {
  return z.object({
    project: zOptionalString.transform((p) => p ?? defaultProject),
    path: zRequiredString,
    content: zRequiredString,
    itemType: z.enum(KNOWLEDGE_ITEM_TYPES).optional(),
    mode: z.enum(INGESTION_MODES).optional(),
    labels: optionalLabelsSchema,
    metadata: zRecord.optional(),
  }) as unknown as z.ZodType<IngestFileInput>;
}

/**
 * Full request (matches validateIngestFilesRequest). `project` is required and
 * is threaded as the per-file default; `files` must be an array of file shapes.
 */
export const ingestFilesSchema = z
  .object({
    project: zRequiredString,
    files: z.array(z.unknown()),
    mode: z.enum(INGESTION_MODES).optional(),
  })
  .transform((req, ctx) => {
    const fileSchema = ingestFileSchema(req.project);
    const files: IngestFileInput[] = req.files.map((file, index) => {
      const result = fileSchema.safeParse(file);
      if (!result.success) {
        for (const issue of result.error.issues) {
          ctx.addIssue({
            code: 'custom',
            message: issue.message,
            path: ['files', index, ...issue.path],
          });
        }
        return undefined as unknown as IngestFileInput;
      }
      return result.data;
    });
    return { project: req.project, files, mode: req.mode };
  });
