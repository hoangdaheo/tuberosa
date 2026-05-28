import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { pickAnchorWindow } from '../src/retrieval/anchor-window.js';

test('pickAnchorWindow: selects the densest window over uniform noise', () => {
  const noise = 'lorem ipsum dolor sit amet '.repeat(400);
  const dense = '\nupdate src/retrieval/fusion.ts. The PaywallSelectionModal failed with TS2304.\n';
  const prompt = noise + dense + noise;
  const w = pickAnchorWindow(prompt, 200);
  assert.ok(w.text.includes('fusion.ts'));
});

test('pickAnchorWindow: small prompts return the whole prompt as the window', () => {
  const prompt = 'tiny';
  const w = pickAnchorWindow(prompt, 1500);
  assert.equal(w.text, prompt);
  assert.equal(w.start, 0);
  assert.equal(w.end, prompt.length);
});

test('pickAnchorWindow: result is deterministic for the same input', () => {
  const prompt = 'a'.repeat(5000) + ' update src/x.ts ' + 'b'.repeat(5000);
  const a = pickAnchorWindow(prompt, 500);
  const b = pickAnchorWindow(prompt, 500);
  assert.equal(a.start, b.start);
  assert.equal(a.end, b.end);
});
