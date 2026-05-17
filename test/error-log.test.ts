import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { ErrorLogInsightService } from '../src/error-log/insights.js';
import { ErrorLogService } from '../src/error-log/service.js';
import type { ReflectionDraftInput } from '../src/types.js';

test('error log service writes sanitized incidents and merges duplicate fingerprints', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'tuberosa-error-logs-'));
  const service = new ErrorLogService({ rootDir, maxBytes: 8 * 1024 });

  try {
    const first = await service.recordLog({
      project: 'tuberosa',
      category: 'agent_tool',
      severity: 'error',
      title: 'Codex command failed',
      message: 'Command failed with token=super-secret-token-value-12345',
      command: 'pnpm test',
      tags: ['tests'],
      references: [{ type: 'file', uri: 'test/error-log.test.ts' }],
    });

    equal(first.occurrenceCount, 1);
    equal(first.message.includes('super-secret-token-value-12345'), false);
    ok(first.message.includes('[REDACTED:secret]'));

    const second = await service.recordLog({
      project: 'tuberosa',
      category: 'agent_tool',
      severity: 'critical',
      title: 'Codex command failed',
      message: 'Command failed with token=super-secret-token-value-12345',
      command: 'pnpm test',
      tags: ['tests', 'retry'],
    });

    equal(second.id, first.id);
    equal(second.occurrenceCount, 2);
    equal(second.severity, 'critical');
    ok(second.tags.includes('retry'));

    const listed = await service.listLogs({ project: 'tuberosa', status: 'open', limit: 10 });
    equal(listed.length, 1);
    equal(listed[0].id, first.id);

    const markdown = await service.readLogMarkdown(first.id);
    ok(markdown?.includes('# Codex command failed'));
    ok(markdown?.includes('pnpm test'));

    const stored = await service.getLog(first.id);
    ok(stored);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('error log service updates status and reflection linkage', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'tuberosa-error-logs-'));
  const service = new ErrorLogService({ rootDir });

  try {
    const log = await service.recordLog({
      project: 'tuberosa',
      category: 'mcp',
      title: 'MCP tool failed',
      message: 'Unexpected tool failure.',
    });

    const updated = await service.updateLog(log.id, {
      status: 'fixed',
      reflectionDraftId: 'draft-1',
      notes: 'Fixed by validating the filesystem journal path.',
      category: 'agent_tool',
    });

    equal(updated?.status, 'fixed');
    equal(updated?.category, 'agent_tool');
    equal(updated?.reflectionDraftId, 'draft-1');
    ok(updated?.resolvedAt);
    ok(Array.isArray(updated?.metadata.notes));

    const listed = await service.listLogs({ category: 'agent_tool', status: 'fixed', limit: 10 });
    equal(listed.length, 1);

    const json = await readFile(
      join(rootDir, 'tuberosa', 'agent_tool', log.firstSeenAt.slice(0, 7), `${log.id}.json`),
      'utf8',
    );
    ok(json.includes('"reflectionDraftId": "draft-1"'));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('error log insight service collects compact agent context with clusters and rollups', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'tuberosa-error-logs-'));
  let now = new Date('2026-05-17T01:00:00.000Z');
  const service = new ErrorLogService({ rootDir, now: () => now });
  const insights = new ErrorLogInsightService(service, fakeReflectionService());

  try {
    await service.recordLog({
      project: 'tuberosa',
      category: 'mcp',
      severity: 'error',
      title: 'MCP tool failed',
      summary: 'The context tool failed.',
      message: 'Stack detail should not appear in collection output.',
      stack: 'Error: no\n  at secretFrame',
      files: ['src/mcp/server.ts'],
      symbols: ['handleMcpRequest'],
      errors: ['Search exploded'],
      tags: ['mcp'],
    });
    now = new Date('2026-05-17T02:00:00.000Z');
    await service.recordLog({
      project: 'tuberosa',
      category: 'mcp',
      severity: 'critical',
      title: 'MCP tool failed',
      summary: 'The context tool failed again.',
      message: 'Stack detail should not appear in collection output.',
      stack: 'Error: no\n  at secretFrame',
      files: ['src/mcp/server.ts'],
      symbols: ['handleMcpRequest'],
      errors: ['Search exploded'],
      tags: ['mcp', 'retry'],
    });
    await service.recordLog({
      project: 'tuberosa',
      category: 'database',
      severity: 'warning',
      status: 'triaged',
      title: 'Migration warning',
      summary: 'A migration warning was triaged.',
      files: ['src/storage/migrations.ts'],
      tags: ['migration'],
    });

    const collection = await insights.collect({
      project: 'tuberosa',
      statuses: ['open'],
      limit: 10,
      offset: 0,
    });

    equal(collection.totalMatched, 1);
    equal(collection.logs.length, 1);
    equal('message' in collection.logs[0], false);
    equal('stack' in collection.logs[0], false);
    equal(collection.clusters[0].occurrenceCount, 2);
    equal(collection.rollups.categories[0].value, 'mcp');
    ok(collection.agentBrief.includes('Recurring Patterns'));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('error log insight service creates reflection drafts and links selected logs', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'tuberosa-error-logs-'));
  const service = new ErrorLogService({ rootDir });
  const draftInputs: ReflectionDraftInput[] = [];
  const insights = new ErrorLogInsightService(service, fakeReflectionService(draftInputs));

  try {
    const log = await service.recordLog({
      project: 'tuberosa',
      category: 'agent_tool',
      severity: 'error',
      title: 'Build command failed',
      summary: 'The TypeScript build failed.',
      files: ['src/error-log/insights.ts'],
      errors: ['TS2345'],
      references: [{ type: 'file', uri: 'src/error-log/insights.ts' }],
    });

    const result = await insights.createReflectionDraft({ errorLogIds: [log.id] });
    equal(result.draft.id, 'draft-from-error-log');
    equal(result.linkedErrorLogIds[0], log.id);
    equal(draftInputs[0].itemType, 'bugfix');
    equal(draftInputs[0].triggerType, 'error_recovery');
    equal(draftInputs[0].metadata?.taxonomy, 'incident_lesson');
    ok(draftInputs[0].references?.some((reference) => reference.uri === `tuberosa://error-logs/${log.id}`));

    const linked = await service.getLog(log.id);
    equal(linked?.reflectionDraftId, 'draft-from-error-log');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('error log insight service resolves incidents with fix metadata', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'tuberosa-error-logs-'));
  const service = new ErrorLogService({ rootDir });
  const insights = new ErrorLogInsightService(service, fakeReflectionService());

  try {
    const log = await service.recordLog({
      project: 'tuberosa',
      category: 'agent_tool',
      severity: 'error',
      title: 'Verification failed',
      summary: 'The verification command failed.',
      files: ['src/error-log/insights.ts'],
      errors: ['ERR_ASSERTION'],
    });

    const result = await insights.resolve({
      id: log.id,
      rootCause: 'The resolver did not preserve resolution metadata.',
      resolutionSummary: 'Stored resolution details under metadata.resolution.',
      changedFiles: ['src/error-log/insights.ts'],
      verificationCommands: ['pnpm test'],
      reflectionDraftId: 'draft-1',
    });

    equal(result?.log.status, 'fixed');
    equal(result?.log.reflectionDraftId, 'draft-1');
    equal((result?.log.metadata.resolution as { rootCause?: string }).rootCause, 'The resolver did not preserve resolution metadata.');
    ok(Array.isArray(result?.log.metadata.notes));
    ok(result?.instruction.includes('linked'));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

function fakeReflectionService(captured: ReflectionDraftInput[] = []) {
  return {
    createDraft: async (input: ReflectionDraftInput) => {
      captured.push(input);
      return {
        id: 'draft-from-error-log',
        project: input.project,
        title: input.title,
        summary: input.summary,
        content: input.content,
        itemType: input.itemType ?? 'memory',
        triggerType: input.triggerType,
        status: 'pending',
        suggestedLabels: input.labels ?? [],
        references: input.references ?? [],
        metadata: input.metadata ?? {},
        duplicateCandidates: [],
        createdAt: new Date().toISOString(),
      };
    },
  } as never;
}
