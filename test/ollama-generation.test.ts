import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { OllamaGenerationProvider } from '../src/model/ollama-generation.js';
import { ModelProviderError } from '../src/errors.js';

function fakeFetch(handler: (url: string, body: Record<string, unknown>) => Response): typeof fetch {
  return (async (url: unknown, init?: { body?: string }) =>
    handler(String(url), JSON.parse(init?.body ?? '{}'))) as typeof fetch;
}

/**
 * Build an NDJSON streaming /api/chat response that splits `content` across
 * multiple chunks, proving the provider accumulates `message.content`.
 */
function chatResponse(content: unknown): Response {
  const serialized = JSON.stringify(content);
  const mid = Math.floor(serialized.length / 2);
  const lines = [
    JSON.stringify({ message: { content: serialized.slice(0, mid) }, done: false }),
    JSON.stringify({ message: { content: serialized.slice(mid) }, done: false }),
    JSON.stringify({ message: { content: '' }, done: true }),
  ];
  return new Response(lines.join('\n') + '\n', { status: 200 });
}

/** Build an NDJSON response from explicit raw lines (for error/edge cases). */
function ndjsonResponse(lines: string[]): Response {
  return new Response(lines.join('\n') + '\n', { status: 200 });
}

test('extractAtoms posts to /api/chat with streaming and parses atoms across chunks', async () => {
  let captured: { url?: string; body?: Record<string, unknown> } = {};
  const provider = new OllamaGenerationProvider({
    modelId: 'qwen3.5:latest',
    ollamaUrl: 'http://localhost:11434/',
    fetchFn: fakeFetch((url, body) => {
      captured = { url, body };
      return chatResponse({
        atoms: [{
          claim: 'Memory store and postgres store must stay behavior-identical.',
          type: 'convention',
          evidence: [{ kind: 'file', path: 'src/storage/store.ts' }],
          trigger: { files: ['src/storage/memory-store.ts'] },
        }],
      });
    }),
  });

  const atoms = await provider.extractAtoms({ project: 'tuberosa', sessionPrompt: 'fix store parity' });
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0]!.type, 'convention');
  assert.equal(captured.url, 'http://localhost:11434/api/chat');
  assert.equal(captured.body!.model, 'qwen3.5:latest');
  assert.equal(captured.body!.stream, true);
  assert.equal((captured.body!.format as { type?: string }).type, 'object');
});

test('judgeAtomUtility parses the verdict from a streamed response', async () => {
  const provider = new OllamaGenerationProvider({
    modelId: 'qwen3.5:latest',
    fetchFn: fakeFetch(() => chatResponse({ generalizable: false, reason: 'one-time event', confidence: 0.9 })),
  });
  const verdict = await provider.judgeAtomUtility({ claim: 'ran tests once', type: 'fact', trigger: {} });
  assert.equal(verdict.generalizable, false);
  assert.equal(verdict.confidence, 0.9);
});

test('non-200 response throws ModelProviderError', async () => {
  const provider = new OllamaGenerationProvider({
    modelId: 'qwen3.5:latest',
    fetchFn: (async () => new Response('boom', { status: 500 })) as typeof fetch,
  });
  await assert.rejects(
    provider.extractAtoms({ project: 'p', sessionPrompt: 'x' }),
    ModelProviderError,
  );
});

test('a completed stream with no content throws ModelProviderError', async () => {
  const provider = new OllamaGenerationProvider({
    modelId: 'qwen3.5:latest',
    fetchFn: (async () =>
      ndjsonResponse([JSON.stringify({ message: { content: '' }, done: true })])) as typeof fetch,
  });
  await assert.rejects(
    provider.extractAtoms({ project: 'p', sessionPrompt: 'x' }),
    ModelProviderError,
  );
});

test('an error line mid-stream throws ModelProviderError and cancels the reader', async () => {
  let cancelled = false;
  const lines = [
    JSON.stringify({ message: { content: '{"atoms":' }, done: false }),
    JSON.stringify({ error: 'something broke' }),
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(lines.join('\n') + '\n'));
      // Never closed: simulates a server still streaming a long generation.
    },
    cancel() {
      cancelled = true;
    },
  });
  const provider = new OllamaGenerationProvider({
    modelId: 'qwen3.5:latest',
    fetchFn: (async () => new Response(body, { status: 200 })) as typeof fetch,
  });
  await assert.rejects(
    provider.extractAtoms({ project: 'p', sessionPrompt: 'x' }),
    ModelProviderError,
  );
  assert.equal(cancelled, true);
});

test('an invalid-JSON stream line throws ModelProviderError (not a raw SyntaxError)', async () => {
  const provider = new OllamaGenerationProvider({
    modelId: 'qwen3.5:latest',
    fetchFn: (async () => ndjsonResponse(['not json at all'])) as typeof fetch,
  });
  await assert.rejects(
    provider.extractAtoms({ project: 'p', sessionPrompt: 'x' }),
    ModelProviderError,
  );
});

test('network failure is wrapped in ModelProviderError', async () => {
  const provider = new OllamaGenerationProvider({
    modelId: 'qwen3.5:latest',
    fetchFn: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch,
  });
  await assert.rejects(
    provider.judgeAtomUtility({ claim: 'c', type: 'fact', trigger: {} }),
    ModelProviderError,
  );
});
