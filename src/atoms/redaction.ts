import type { KnowledgeSafetyService } from '../security/knowledge-safety.js';
import type { Evidence, KnowledgeAtomInput, Verification } from '../types/atoms.js';

function redactEvidence(evidence: Evidence, safety: KnowledgeSafetyService): Evidence {
  switch (evidence.kind) {
    case 'commit':
      return evidence.message === undefined
        ? evidence
        : { ...evidence, message: safety.redactSecrets(evidence.message) };
    case 'url':
      return { ...evidence, uri: safety.redactSecrets(evidence.uri) };
    default:
      // file / test / prior_session carry only structural fields.
      return evidence;
  }
}

function redactVerification(
  verification: Verification,
  safety: KnowledgeSafetyService,
): Verification {
  const redacted: Verification = { ...verification };
  if (verification.command !== undefined) {
    redacted.command = safety.redactSecrets(verification.command);
  }
  if (verification.assertion !== undefined) {
    redacted.assertion = safety.redactSecrets(verification.assertion);
  }
  return redacted;
}

/**
 * Returns a copy of an atom input with free-text fields run through secret
 * redaction before storage. Atoms originate from LLM extraction of session
 * prompts/summaries which may contain secrets, mirroring how upsertKnowledge
 * sanitizes normal knowledge.
 */
export function redactAtomInput(
  input: KnowledgeAtomInput,
  safety: KnowledgeSafetyService,
): KnowledgeAtomInput {
  return {
    ...input,
    claim: safety.redactSecrets(input.claim),
    evidence: input.evidence.map((item) => redactEvidence(item, safety)),
    verification: input.verification
      ? redactVerification(input.verification, safety)
      : input.verification,
    pitfalls: input.pitfalls?.map((pitfall) => safety.redactSecrets(pitfall)),
  };
}
