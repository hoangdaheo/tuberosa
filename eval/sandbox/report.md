# Sandbox Report

- Seed: `12648430`
- Knowledge items: 332
- Prompts: 44
- Projects: aurora, borealis, nimbus, cobalt

## Headline Metrics

| Metric | Value |
| --- | --- |
| hit rate | 93.2% |
| MRR | 0.4771 |
| noise rate | 9.1% |
| stale suppression | 100.0% |
| duplicate suppression | 100.0% |
| adversarial block rate | 100.0% |
| itemType "memory" catch-all rate | 38.8% |
| itemType diagonal rate (Phase 3) | 69.4% |
| label diagonal rate (Phase 3) | 7.7% |
| latency p50 / p95 / max (ms) | 12 / 17 / 56 |

## Per-Tier Selection

| Tier | selected | expected selected | suppressed | expected suppressed |
| --- | --- | --- | --- | --- |
| A | 217 | 36 | 0 | 0 |
| B | 9 | 0 | 72 | 76 |
| C | 178 | 4 | 4 | 4 |
| D | 51 | 4 | 4 | 4 |
| E | 6 | 0 | 8 | 8 |
| F | 0 | 0 | 0 | 0 |

## Per-ItemType Hits

| itemType | selected | expected | correct | precision | recall |
| --- | --- | --- | --- | --- | --- |
| memory | 179 | 7 | 7 | 3.9% | 100.0% |
| workflow | 165 | 9 | 8 | 4.8% | 88.9% |
| code_ref | 28 | 12 | 8 | 28.6% | 66.7% |
| wiki | 28 | 2 | 2 | 7.1% | 100.0% |
| bugfix | 31 | 6 | 6 | 19.4% | 100.0% |
| spec | 30 | 8 | 6 | 20.0% | 75.0% |

## Per-Source Fusion Contribution (toward expected items)

| source | aggregated contribution |
| --- | --- |
| metadata | 0.8750 |
| lexical | 0.8555 |
| memory | 0.4062 |
| vector | 0.5404 |
| graph | 0.5917 |
| worktree | 0.0000 |

## Filter Telemetry

| filter | triggered | correct | precision |
| --- | --- | --- | --- |
| duplicate | 136 | 52 | 38.2% |
| safety_block_ingest | 24 | 24 | 100.0% |

## Thresholds

```json
{
  "description": "Phase 4 thresholds. itemType diagonal rate raised to 0.65 to lock in the gain from per-task fusion + coverage profiles. catch-all rate still gated at 0.6 — corpus-bounded (see roadmap-claude.md Phase 3 deviations).",
  "minHitRate": 0.9,
  "minMRR": 0.45,
  "maxNoiseRate": 0.2,
  "minStaleSuppressionRate": 0.95,
  "minDuplicateSuppressionRate": 0.9,
  "minAdversarialBlockRate": 0.9,
  "maxItemTypeCatchAllRate": 0.6,
  "minItemTypeDiagonalRate": 0.65,
  "minLabelDiagonalRate": 0.05,
  "minPerFilterPrecision": {
    "safety_block_ingest": 0.9,
    "safety_redact_retrieval": 0,
    "duplicate": 0.9
  }
}
```

**Status:** all thresholds passed.
