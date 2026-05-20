# Sandbox Report

- Seed: `12648430`
- Knowledge items: 332
- Prompts: 44
- Projects: aurora, borealis, nimbus, cobalt

## Headline Metrics

| Metric | Value |
| --- | --- |
| hit rate | 93.2% |
| MRR | 0.4618 |
| noise rate | 9.1% |
| stale suppression | 100.0% |
| duplicate suppression | 100.0% |
| adversarial block rate | 100.0% |
| itemType "memory" catch-all rate | 38.6% |
| latency p50 / p95 / max (ms) | 7 / 10 / 33 |

## Per-Tier Selection

| Tier | selected | expected selected | suppressed | expected suppressed |
| --- | --- | --- | --- | --- |
| A | 224 | 36 | 0 | 0 |
| B | 8 | 0 | 72 | 76 |
| C | 181 | 4 | 4 | 4 |
| D | 51 | 4 | 4 | 4 |
| E | 5 | 0 | 8 | 8 |
| F | 0 | 0 | 0 | 0 |

## Per-ItemType Hits

| itemType | hits | expected | precision | recall |
| --- | --- | --- | --- | --- |
| memory | 181 | 7 | 2585.7% | 2585.7% |
| workflow | 167 | 9 | 1855.6% | 1855.6% |
| code_ref | 30 | 12 | 250.0% | 250.0% |
| wiki | 25 | 2 | 1250.0% | 1250.0% |
| bugfix | 33 | 6 | 550.0% | 550.0% |
| spec | 33 | 8 | 412.5% | 412.5% |

## Per-Source Fusion Contribution (toward expected items)

| source | aggregated contribution |
| --- | --- |
| metadata | 0.8796 |
| lexical | 0.8397 |
| memory | 0.3955 |
| vector | 0.5215 |
| graph | 0.5823 |
| reference | 0.0000 |

## Filter Telemetry

| filter | triggered | correct | precision |
| --- | --- | --- | --- |
| duplicate | 136 | 52 | 38.2% |
| safety_block_ingest | 24 | 24 | 100.0% |

## Thresholds

```json
{
  "description": "Phase 1 baseline thresholds. These reflect *current observed* behaviour on the synthetic corpus so any regression fails CI. Phase 2+ tightens them as filters improve.",
  "minHitRate": 0.7,
  "minMRR": 0.4,
  "maxNoiseRate": 0.35,
  "minStaleSuppressionRate": 0.95,
  "minDuplicateSuppressionRate": 0,
  "minAdversarialBlockRate": 0.9,
  "maxItemTypeCatchAllRate": 0.6,
  "minPerFilterPrecision": {
    "safety_block_ingest": 0.9,
    "safety_redact_retrieval": 0
  }
}
```

**Status:** all thresholds passed.
