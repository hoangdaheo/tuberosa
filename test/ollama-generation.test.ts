import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { OllamaGenerationProvider } from '../src/model/ollama-generation.js';
import { ModelProviderError } from '../src/errors.js';

function fakeFetch(handler: (url: string, body: Record<string, unknown>) => Response): typeof fetch {
  return (async (url: unknown, init?: { body?: string }) =>
    handler(String(url), JSON.parse(init?.body ?? '{}'))) as typeof fetch;
}

function chatResponse(content: unknown): Response {
  return new Response(JSON.stringify({ message: { content: JSON.stringify(content) } }), { status: 200 });
}

test('extractAtoms posts to /api/chat with schema format and parses atoms', async () => {
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
  assert.equal(captured.body!.stream, false);
  assert.equal((captured.body!.format as { type?: string }).type, 'object');
});

test('judgeAtomUtility parses the verdict', async () => {
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

test('missing message content throws ModelProviderError', async () => {
  const provider = new OllamaGenerationProvider({
    modelId: 'qwen3.5:latest',
    fetchFn: (async () => new Response(JSON.stringify({ message: {} }), { status: 200 })) as typeof fetch,
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
