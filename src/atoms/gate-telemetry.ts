import type { KnowledgeStore, AtomGateEventInput, AtomGateEvent } from '../storage/store.js';

/**
 * Best-effort recorder for atom write-gate decisions (Concern D). Each gate stage
 * emits one row so acceptance/rejection rates are observable. A failed telemetry
 * write must never fail the gate decision itself, so all errors are swallowed and
 * logged to stderr (MCP stdout must stay JSON-RPC clean).
 */
export class GateTelemetry {
  constructor(
    private readonly store: Pick<KnowledgeStore, 'recordAtomGateEvent' | 'listAtomGateEvents'>,
  ) {}

  async record(input: AtomGateEventInput): Promise<AtomGateEvent | undefined> {
    try {
      return await this.store.recordAtomGateEvent(input);
    } catch (error) {
      process.stderr.write(
        `[atom-gate-telemetry] suppressed write error: ${(error as Error).message}\n`,
      );
      return undefined;
    }
  }
}
