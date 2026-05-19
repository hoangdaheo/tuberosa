import test from 'node:test';
import { deepEqual, equal, rejects, throws } from 'node:assert/strict';
import {
  formatOrganizationExport,
  parseOrganizationArgs,
  runOrganizationExport,
} from '../src/operations/organization-cli.js';

test('organization CLI parser accepts commands and shared options', () => {
  deepEqual(parseOrganizationArgs([
    'project-map',
    '--project',
    'tuberosa',
    '--limit',
    '5',
    '--out',
    'exports/project-map.json',
  ]), {
    command: 'project-map',
    project: 'tuberosa',
    limit: 5,
    out: 'exports/project-map.json',
    help: false,
  });

  throws(() => parseOrganizationArgs([]), /Command is required/);
  throws(() => parseOrganizationArgs(['unknown']), /Unknown organization command/);
  throws(() => parseOrganizationArgs(['project-map', '--limit', '0']), /positive integer/);
});

test('organization CLI runner dispatches and formats exports', async () => {
  const operations = {
    exportProjectMap: async (options: { project?: string; limit: number }) => ({
      project: options.project,
      generatedAt: '2026-05-19T00:00:00.000Z',
      knowledgeCount: options.limit,
      relationCount: 2,
      labelCount: 3,
      sources: [],
      relationTypes: [],
    }),
    exportKnowledgeGraphJsonl: async () => ({
      project: 'tuberosa',
      generatedAt: '2026-05-19T00:00:00.000Z',
      content: '{"kind":"knowledge"}',
    }),
    exportReadableSummary: async () => ({
      project: 'tuberosa',
      generatedAt: '2026-05-19T00:00:00.000Z',
      content: '# Tuberosa Knowledge Summary',
    }),
  };

  const projectMap = await runOrganizationExport(operations, {
    command: 'project-map',
    project: 'tuberosa',
    limit: 7,
    help: false,
  });
  equal(JSON.parse(formatOrganizationExport('project-map', projectMap)).knowledgeCount, 7);

  const graph = await runOrganizationExport(operations, {
    command: 'knowledge-graph',
    project: 'tuberosa',
    limit: 10,
    help: false,
  });
  equal(formatOrganizationExport('knowledge-graph', graph), '{"kind":"knowledge"}');

  await rejects(
    () => runOrganizationExport(operations, { limit: 10, help: false }),
    /Organization command is required/,
  );
});
