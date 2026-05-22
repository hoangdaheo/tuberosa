import test from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { KnowledgeSafetyService, SECRET_PATTERN_NAMES } from '../src/security/knowledge-safety.js';

test('Phase 9: SECRET_PATTERN_NAMES exposes the five canonical pattern names', () => {
  // Order is the iteration order applied by redactSecretPatterns. Hard-code it
  // here so that re-ordering for ranking reasons is a deliberate change, not
  // an accidental drift.
  equal(SECRET_PATTERN_NAMES.length, 5);
  equal(SECRET_PATTERN_NAMES[0], 'pem_private_key');
  equal(SECRET_PATTERN_NAMES[4], 'credential_assignment');
});

test('Phase 9: real credentials still redact (load-bearing recall guarantee)', () => {
  const safety = new KnowledgeSafetyService();
  const cases: Array<[string, string, string]> = [
    ['pem', '-----BEGIN OPENSSH PRIVATE KEY-----\nabcd1234\n-----END OPENSSH PRIVATE KEY-----', 'pem_private_key'],
    ['openai', 'token sk-Bd0NfMzQpR3tY7vX2hL5cKgWa9bP4Eq8sJ6uT1mZ end', 'openai_api_key'],
    ['github', 'GITHUB_TOKEN=ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'github_token'],
    ['aws', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', 'aws_access_key'],
    ['credential', 'token=super-secret-token-value-12345', 'credential_assignment'],
  ];
  for (const [label, text, expected] of cases) {
    const result = safety.scanForSecrets(text);
    ok(result.redactionCount > 0, `${label}: expected at least one redaction, got ${result.redactionCount}`);
    ok(
      result.firedPatterns.includes(expected),
      `${label}: expected ${expected} to fire (fired=[${result.firedPatterns.join(', ')}])`,
    );
  }
});

test('Phase 9: TypeScript type annotations are no longer redacted as credentials', () => {
  const safety = new KnowledgeSafetyService();
  const result = safety.scanForSecrets(
    'function login(password: AccessTokenServiceCredential, apiKey: ServiceAuthCredentialProvider) {}',
  );
  equal(result.redactionCount, 0);
  equal(result.firedPatterns.length, 0);
});

test('Phase 9: env-example placeholders (<your-key>, ${VAR}, xxxx, your_*_here) are skipped', () => {
  const safety = new KnowledgeSafetyService();
  const cases = [
    'API_KEY=your_api_key_here_replace_me',
    'API_KEY=<your-openai-api-key>',
    'password=${DB_PASSWORD}',
    'token=xxxxxxxxxxxxxxxxxxxxxxxx',
  ];
  for (const text of cases) {
    const result = safety.scanForSecrets(text);
    equal(result.redactionCount, 0, `expected no redaction for placeholder: ${text}`);
  }
});

test('Phase 9: line-comment / JSDoc credential mentions are skipped', () => {
  const safety = new KnowledgeSafetyService();
  const cases = [
    '// TODO: pass api_key = realValueHereXYZ from config to the auth provider',
    ' * @param apiKey: ServiceAuthCredentialProvider the credential provider',
  ];
  for (const text of cases) {
    const result = safety.scanForSecrets(text);
    equal(result.redactionCount, 0, `expected no redaction for comment context: ${text}`);
  }
});

test('Phase 9: JSON-style "password": "value" assignments are redacted', () => {
  const safety = new KnowledgeSafetyService();
  const result = safety.scanForSecrets('{"username":"svc","password":"k2P9xQ5mL7nB3vT8wY1aC4dE"}');
  ok(result.redactionCount > 0);
  ok(result.firedPatterns.includes('credential_assignment'));
});
