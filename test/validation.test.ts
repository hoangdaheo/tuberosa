import test from 'node:test';
import { doesNotThrow, equal, throws } from 'node:assert/strict';
import {
  validateContextSearchInput,
  validateFeedbackInput,
  validateFinishAgentSessionInput,
  validateKnowledgeInput,
  validateRecordAgentContextDecisionInput,
  validateReflectionDraftInput,
  validateStartAgentSessionInput,
} from '../src/validation.js';

type Validator = (value: unknown) => unknown;

interface Row {
  name: string;
  fn: Validator;
  input: unknown;
  expect: 'ok' | 'fail';
}

const CASES: Row[] = [
  // -- validateContextSearchInput -------------------------------------------
  { name: 'CS happy minimal', fn: validateContextSearchInput, input: { prompt: 'x' }, expect: 'ok' },
  { name: 'CS happy full', fn: validateContextSearchInput, input: {
    prompt: 'x', project: 'p', cwd: '/tmp', taskType: 'debugging',
    files: ['a.ts'], symbols: ['Foo'], errors: ['ENOENT'],
    tokenBudget: 4000, contextMode: 'layered', noiseTolerance: 'strict',
    deepContextBudget: 60000, includeDeepContext: true,
    rejectedKnowledgeIds: ['x'], bypassCache: false, debug: false,
  }, expect: 'ok' },
  { name: 'CS not an object', fn: validateContextSearchInput, input: null, expect: 'fail' },
  { name: 'CS not an object (array)', fn: validateContextSearchInput, input: [], expect: 'fail' },
  { name: 'CS missing prompt', fn: validateContextSearchInput, input: {}, expect: 'fail' },
  { name: 'CS prompt wrong type', fn: validateContextSearchInput, input: { prompt: 42 }, expect: 'fail' },
  { name: 'CS contextMode=compact', fn: validateContextSearchInput, input: { prompt: 'x', contextMode: 'compact' }, expect: 'ok' },
  { name: 'CS contextMode=layered', fn: validateContextSearchInput, input: { prompt: 'x', contextMode: 'layered' }, expect: 'ok' },
  { name: 'CS contextMode invalid', fn: validateContextSearchInput, input: { prompt: 'x', contextMode: 'lean' }, expect: 'fail' },
  { name: 'CS noiseTolerance=strict', fn: validateContextSearchInput, input: { prompt: 'x', noiseTolerance: 'strict' }, expect: 'ok' },
  { name: 'CS noiseTolerance=balanced', fn: validateContextSearchInput, input: { prompt: 'x', noiseTolerance: 'balanced' }, expect: 'ok' },
  { name: 'CS noiseTolerance invalid', fn: validateContextSearchInput, input: { prompt: 'x', noiseTolerance: 'wide' }, expect: 'fail' },
  { name: 'CS taskType=debugging', fn: validateContextSearchInput, input: { prompt: 'x', taskType: 'debugging' }, expect: 'ok' },
  { name: 'CS taskType alias bugfix', fn: validateContextSearchInput, input: { prompt: 'x', taskType: 'bugfix' }, expect: 'ok' },
  { name: 'CS taskType alias coding', fn: validateContextSearchInput, input: { prompt: 'x', taskType: 'coding' }, expect: 'ok' },
  { name: 'CS taskType unknown literal', fn: validateContextSearchInput, input: { prompt: 'x', taskType: 'unknown' }, expect: 'ok' },
  { name: 'CS taskType bogus', fn: validateContextSearchInput, input: { prompt: 'x', taskType: 'bogus' }, expect: 'fail' },
  { name: 'CS tokenBudget negative', fn: validateContextSearchInput, input: { prompt: 'x', tokenBudget: -1 }, expect: 'fail' },
  { name: 'CS tokenBudget zero', fn: validateContextSearchInput, input: { prompt: 'x', tokenBudget: 0 }, expect: 'fail' },
  { name: 'CS tokenBudget positive', fn: validateContextSearchInput, input: { prompt: 'x', tokenBudget: 1024 }, expect: 'ok' },
  { name: 'CS files must be array', fn: validateContextSearchInput, input: { prompt: 'x', files: 'a.ts' }, expect: 'fail' },
  { name: 'CS files of non-strings', fn: validateContextSearchInput, input: { prompt: 'x', files: [42] }, expect: 'fail' },
  { name: 'CS symbols not array', fn: validateContextSearchInput, input: { prompt: 'x', symbols: { foo: 1 } }, expect: 'fail' },
  { name: 'CS rejectedKnowledgeIds not array', fn: validateContextSearchInput, input: { prompt: 'x', rejectedKnowledgeIds: 'a' }, expect: 'fail' },
  { name: 'CS includeDeepContext non-bool', fn: validateContextSearchInput, input: { prompt: 'x', includeDeepContext: 'yes' }, expect: 'fail' },

  // -- validateKnowledgeInput ----------------------------------------------
  { name: 'Knowledge happy minimal', fn: validateKnowledgeInput, input: {
    project: 'p', sourceType: 'file', sourceUri: 'a.ts',
    itemType: 'wiki', title: 't', content: 'c',
  }, expect: 'ok' },
  { name: 'Knowledge missing project', fn: validateKnowledgeInput, input: {
    sourceType: 'file', sourceUri: 'a.ts', itemType: 'wiki', title: 't', content: 'c',
  }, expect: 'fail' },
  { name: 'Knowledge missing sourceUri', fn: validateKnowledgeInput, input: {
    project: 'p', sourceType: 'file', itemType: 'wiki', title: 't', content: 'c',
  }, expect: 'fail' },
  { name: 'Knowledge missing title', fn: validateKnowledgeInput, input: {
    project: 'p', sourceType: 'file', sourceUri: 'a.ts', itemType: 'wiki', content: 'c',
  }, expect: 'fail' },
  { name: 'Knowledge missing content', fn: validateKnowledgeInput, input: {
    project: 'p', sourceType: 'file', sourceUri: 'a.ts', itemType: 'wiki', title: 't',
  }, expect: 'fail' },
  { name: 'Knowledge itemType=spec', fn: validateKnowledgeInput, input: {
    project: 'p', sourceType: 'file', sourceUri: 'a.ts', itemType: 'spec', title: 't', content: 'c',
  }, expect: 'ok' },
  { name: 'Knowledge itemType invalid', fn: validateKnowledgeInput, input: {
    project: 'p', sourceType: 'file', sourceUri: 'a.ts', itemType: 'bogus', title: 't', content: 'c',
  }, expect: 'fail' },
  { name: 'Knowledge labels missing type', fn: validateKnowledgeInput, input: {
    project: 'p', sourceType: 'file', sourceUri: 'a.ts', itemType: 'wiki', title: 't', content: 'c',
    labels: [{ value: 'foo' }],
  }, expect: 'fail' },
  { name: 'Knowledge labels invalid type enum', fn: validateKnowledgeInput, input: {
    project: 'p', sourceType: 'file', sourceUri: 'a.ts', itemType: 'wiki', title: 't', content: 'c',
    labels: [{ type: 'bogus', value: 'foo' }],
  }, expect: 'fail' },
  { name: 'Knowledge references missing uri', fn: validateKnowledgeInput, input: {
    project: 'p', sourceType: 'file', sourceUri: 'a.ts', itemType: 'wiki', title: 't', content: 'c',
    references: [{ type: 'file' }],
  }, expect: 'fail' },
  { name: 'Knowledge references invalid type', fn: validateKnowledgeInput, input: {
    project: 'p', sourceType: 'file', sourceUri: 'a.ts', itemType: 'wiki', title: 't', content: 'c',
    references: [{ type: 'bogus', uri: 'x' }],
  }, expect: 'fail' },

  // -- validateStartAgentSessionInput --------------------------------------
  { name: 'StartSession happy', fn: validateStartAgentSessionInput, input: { prompt: 'x' }, expect: 'ok' },
  { name: 'StartSession with agentName', fn: validateStartAgentSessionInput, input: { prompt: 'x', agentName: 'mother' }, expect: 'ok' },
  { name: 'StartSession bad cwd type', fn: validateStartAgentSessionInput, input: { prompt: 'x', cwd: 123 }, expect: 'fail' },
  { name: 'StartSession agentName non-string', fn: validateStartAgentSessionInput, input: { prompt: 'x', agentName: 7 }, expect: 'fail' },

  // -- validateRecordAgentContextDecisionInput -----------------------------
  { name: 'Decision selected (sessionId via input)', fn: validateRecordAgentContextDecisionInput, input: {
    sessionId: '11111111-1111-1111-1111-111111111111', feedbackType: 'selected',
  }, expect: 'ok' },
  { name: 'Decision missing feedbackType', fn: validateRecordAgentContextDecisionInput, input: {
    sessionId: '11111111-1111-1111-1111-111111111111',
  }, expect: 'fail' },
  { name: 'Decision bogus feedbackType', fn: validateRecordAgentContextDecisionInput, input: {
    sessionId: '11111111-1111-1111-1111-111111111111', feedbackType: 'maybe',
  }, expect: 'fail' },
  { name: 'Decision feedbackType=selected_but_noisy', fn: validateRecordAgentContextDecisionInput, input: {
    sessionId: '11111111-1111-1111-1111-111111111111', feedbackType: 'selected_but_noisy',
  }, expect: 'ok' },
  { name: 'Decision rejectedKnowledgeIds not array', fn: validateRecordAgentContextDecisionInput, input: {
    sessionId: '11111111-1111-1111-1111-111111111111', feedbackType: 'rejected', rejectedKnowledgeIds: 'x',
  }, expect: 'fail' },

  // -- validateFinishAgentSessionInput -------------------------------------
  { name: 'Finish completed', fn: validateFinishAgentSessionInput, input: {
    sessionId: '11111111-1111-1111-1111-111111111111', outcome: 'completed',
  }, expect: 'ok' },
  { name: 'Finish bogus outcome', fn: validateFinishAgentSessionInput, input: {
    sessionId: '11111111-1111-1111-1111-111111111111', outcome: 'sorta',
  }, expect: 'fail' },
  { name: 'Finish missing outcome', fn: validateFinishAgentSessionInput, input: {
    sessionId: '11111111-1111-1111-1111-111111111111',
  }, expect: 'fail' },
  { name: 'Finish learningMode invalid', fn: validateFinishAgentSessionInput, input: {
    sessionId: '11111111-1111-1111-1111-111111111111', outcome: 'completed', learningMode: 'sometimes',
  }, expect: 'fail' },
  { name: 'Finish learningMode=draft_only', fn: validateFinishAgentSessionInput, input: {
    sessionId: '11111111-1111-1111-1111-111111111111', outcome: 'completed', learningMode: 'draft_only',
  }, expect: 'ok' },
  { name: 'Finish changedFiles not array', fn: validateFinishAgentSessionInput, input: {
    sessionId: '11111111-1111-1111-1111-111111111111', outcome: 'completed', changedFiles: 'a.ts',
  }, expect: 'fail' },
  { name: 'Finish reflectionDraft must be object', fn: validateFinishAgentSessionInput, input: {
    sessionId: '11111111-1111-1111-1111-111111111111', outcome: 'completed', reflectionDraft: 'no',
  }, expect: 'fail' },

  // -- validateFeedbackInput -----------------------------------------------
  { name: 'Feedback happy', fn: validateFeedbackInput, input: { feedbackType: 'selected' }, expect: 'ok' },
  { name: 'Feedback missing feedbackType', fn: validateFeedbackInput, input: {}, expect: 'fail' },
  { name: 'Feedback bogus feedbackType', fn: validateFeedbackInput, input: { feedbackType: 'whatever' }, expect: 'fail' },
  { name: 'Feedback rejectedKnowledgeIds not array', fn: validateFeedbackInput, input: { feedbackType: 'rejected', rejectedKnowledgeIds: 'x' }, expect: 'fail' },

  // -- validateReflectionDraftInput ----------------------------------------
  { name: 'Draft happy', fn: validateReflectionDraftInput, input: {
    title: 't', summary: 's', content: 'c', triggerType: 'manual',
  }, expect: 'ok' },
  { name: 'Draft missing title', fn: validateReflectionDraftInput, input: {
    summary: 's', content: 'c', triggerType: 'manual',
  }, expect: 'fail' },
  { name: 'Draft missing summary', fn: validateReflectionDraftInput, input: {
    title: 't', content: 'c', triggerType: 'manual',
  }, expect: 'fail' },
  { name: 'Draft missing content', fn: validateReflectionDraftInput, input: {
    title: 't', summary: 's', triggerType: 'manual',
  }, expect: 'fail' },
  { name: 'Draft missing triggerType', fn: validateReflectionDraftInput, input: {
    title: 't', summary: 's', content: 'c',
  }, expect: 'fail' },
  { name: 'Draft triggerType invalid', fn: validateReflectionDraftInput, input: {
    title: 't', summary: 's', content: 'c', triggerType: 'spontaneous',
  }, expect: 'fail' },
  { name: 'Draft itemType=memory', fn: validateReflectionDraftInput, input: {
    title: 't', summary: 's', content: 'c', triggerType: 'manual', itemType: 'memory',
  }, expect: 'ok' },
  { name: 'Draft itemType invalid', fn: validateReflectionDraftInput, input: {
    title: 't', summary: 's', content: 'c', triggerType: 'manual', itemType: 'sticky',
  }, expect: 'fail' },
];

for (const row of CASES) {
  test(`validation: ${row.name} (expect=${row.expect})`, () => {
    if (row.expect === 'ok') {
      doesNotThrow(() => row.fn(row.input));
    } else {
      throws(() => row.fn(row.input));
    }
  });
}

test('validation: tokenBudget is clamped to the 200k ceiling', () => {
  const clamped = validateContextSearchInput({ prompt: 'x', tokenBudget: 5_000_000 });
  equal(clamped.tokenBudget, 200_000);

  const passthrough = validateContextSearchInput({ prompt: 'x', tokenBudget: 4000 });
  equal(passthrough.tokenBudget, 4000);
});
