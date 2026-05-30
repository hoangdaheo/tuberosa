import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { KnowledgeSafetyService } from '../src/security/knowledge-safety.js';

test('sanitizeContextPack redacts secrets in deepContext content', () => {
  const safety = new KnowledgeSafetyService();
  const pack: any = {
    sections: [],
    deepContext: {
      mode: 'layered',
      budget: 1000,
      tokenEstimate: 10,
      sections: [{
        name: 'essential',
        tokenEstimate: 10,
        items: [{
          knowledgeId: 'k1', title: 'T', summary: 'S', content: 'token sk-ABCDEF1234567890ABCDEF1234567890',
          contextualContent: 'context sk-ABCDEF1234567890ABCDEF1234567890', chunkIds: [], tokenEstimate: 10,
        }],
      }],
    },
  };
  const out: any = safety.sanitizeContextPack(pack);
  assert.ok(!out.deepContext.sections[0].items[0].content.includes('sk-ABCDEF1234567890ABCDEF1234567890'),
    'deepContext content should be redacted');
  assert.ok(!out.deepContext.sections[0].items[0].contextualContent.includes('sk-ABCDEF1234567890ABCDEF1234567890'),
    'deepContext contextualContent should be redacted');
});
