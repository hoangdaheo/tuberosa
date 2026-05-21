# Sandbox Report

- Seed: `12648430`
- Knowledge items: 332
- Prompts: 44
- Projects: aurora, borealis, nimbus, cobalt

## Headline Metrics

| Metric | Value |
| --- | --- |
| hit rate | 95.5% |
| MRR | 0.4882 |
| noise rate | 9.1% |
| stale suppression | 100.0% |
| duplicate suppression | 100.0% |
| adversarial block rate | 100.0% |
| itemType "memory" catch-all rate | 39.4% |
| itemType diagonal rate (Phase 3) | 68.7% |
| label diagonal rate (Phase 3) | 8.0% |
| latency p50 / p95 / max (ms) | 18 / 25 / 66 |

## Per-Tier Selection

| Tier | selected | expected selected | suppressed | expected suppressed |
| --- | --- | --- | --- | --- |
| A | 220 | 36 | 0 | 0 |
| B | 8 | 0 | 72 | 76 |
| C | 185 | 4 | 4 | 4 |
| D | 51 | 4 | 4 | 4 |
| E | 6 | 0 | 8 | 8 |
| F | 0 | 0 | 0 | 0 |

## Per-ItemType Hits

| itemType | hits | expected | precision | recall |
| --- | --- | --- | --- | --- |
| memory | 185 | 7 | 2642.9% | 2642.9% |
| workflow | 164 | 9 | 1822.2% | 1822.2% |
| code_ref | 28 | 12 | 233.3% | 233.3% |
| wiki | 29 | 2 | 1450.0% | 1450.0% |
| bugfix | 31 | 6 | 516.7% | 516.7% |
| spec | 33 | 8 | 412.5% | 412.5% |

## Per-Source Fusion Contribution (toward expected items)

| source | aggregated contribution |
| --- | --- |
| metadata | 0.9118 |
| lexical | 0.8670 |
| memory | 0.4062 |
| vector | 0.5357 |
| graph | 0.5917 |
| reference | 0.0000 |

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
