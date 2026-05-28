import type { TrivialityRule } from '../atoms/triviality-rules.js';

/**
 * Concern F — user-style critic adjustment.
 *
 * Rejects bare-ego claims like "I'm the best" / "I love it" that carry no
 * stylistic signal. The regex is anchored at both ends so longer claims with
 * the same prefix ("I prefer named exports for clarity.") are accepted —
 * verb + object disambiguates a stance from a vent.
 */
const BARE_EGO_RE = /^\s*(?:i\s+(?:am|like|love|hate|feel)|i'm|my)\s+[^.]{0,40}\.?\s*$/i;

export const PERSONAL_PRONOUN_ONLY_RULE: TrivialityRule = {
  name: 'personal_pronoun_only',
  test: (a) => BARE_EGO_RE.test(a.claim),
};
