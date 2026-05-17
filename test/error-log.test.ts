import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { ErrorLogService } from '../src/error-log/service.js';

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
