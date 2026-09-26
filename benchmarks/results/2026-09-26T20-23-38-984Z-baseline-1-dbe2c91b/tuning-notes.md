# baseline results

Type 1 performs selector-only classification and invokes zero reviewers.
Gate latency uses classifyGrail latencyMs; parent process wall includes common Pi startup and batch overhead.
Unknown token usage and cost remain null; all outgoing calls were reserved before launch.

{
  "byArm": {
    "jev": {
      "cases": 12,
      "investigation": {
        "correct": 10,
        "total": 12,
        "accuracy": 0.8333333333333334,
        "missedInvestigations": 0,
        "unnecessaryInvestigations": 2
      },
      "bySignal": {
        "instruction_drift": {
          "correct": 11,
          "total": 12,
          "evaluated": 12,
          "accuracy": 0.9166666666666666,
          "statusCounts": {
            "FLAG": {
              "expected": 6,
              "actual": 7
            },
            "NO_VISIBLE_SIGNAL": {
              "expected": 5,
              "actual": 4
            },
            "INSUFFICIENT_INPUT": {
              "expected": 1,
              "actual": 1
            }
          }
        },
        "unverified_assumption": {
          "correct": 8,
          "total": 12,
          "evaluated": 12,
          "accuracy": 0.6666666666666666,
          "statusCounts": {
            "FLAG": {
              "expected": 2,
              "actual": 6
            },
            "NO_VISIBLE_SIGNAL": {
              "expected": 9,
              "actual": 6
            },
            "INSUFFICIENT_INPUT": {
              "expected": 1,
              "actual": 0
            }
          }
        },
        "evidence_leap": {
          "correct": 6,
          "total": 12,
          "evaluated": 12,
          "accuracy": 0.5,
          "statusCounts": {
            "FLAG": {
              "expected": 2,
              "actual": 6
            },
            "NO_VISIBLE_SIGNAL": {
              "expected": 9,
              "actual": 3
            },
            "INSUFFICIENT_INPUT": {
              "expected": 1,
              "actual": 3
            }
          }
        }
      },
      "insufficientSignalCount": 4,
      "failedCallCount": 0,
      "latencyMs": {
        "observed": 12,
        "unknown": 0,
        "mean": 216.44493749999847,
        "median": 218.38189599999896
      },
      "costUsd": {
        "observed": 12,
        "unknown": 0,
        "meanObserved": 0.00005129949999999999,
        "totalObserved": 0.0006155939999999999,
        "totalUpperBound": 0.006225408,
        "meanUpperBound": 0.000518784
      }
    },
    "subagent": {
      "cases": 12,
      "investigation": {
        "correct": 11,
        "total": 12,
        "accuracy": 0.9166666666666666,
        "missedInvestigations": 0,
        "unnecessaryInvestigations": 1
      },
      "bySignal": {
        "instruction_drift": {
          "correct": 12,
          "total": 12,
          "evaluated": 12,
          "accuracy": 1,
          "statusCounts": {
            "FLAG": {
              "expected": 6,
              "actual": 6
            },
            "NO_VISIBLE_SIGNAL": {
              "expected": 5,
              "actual": 5
            },
            "INSUFFICIENT_INPUT": {
              "expected": 1,
              "actual": 1
            }
          }
        },
        "unverified_assumption": {
          "correct": 8,
          "total": 12,
          "evaluated": 12,
          "accuracy": 0.6666666666666666,
          "statusCounts": {
            "FLAG": {
              "expected": 2,
              "actual": 6
            },
            "NO_VISIBLE_SIGNAL": {
              "expected": 9,
              "actual": 6
            },
            "INSUFFICIENT_INPUT": {
              "expected": 1,
              "actual": 0
            }
          }
        },
        "evidence_leap": {
          "correct": 10,
          "total": 12,
          "evaluated": 12,
          "accuracy": 0.8333333333333334,
          "statusCounts": {
            "FLAG": {
              "expected": 2,
              "actual": 3
            },
            "NO_VISIBLE_SIGNAL": {
              "expected": 9,
              "actual": 9
            },
            "INSUFFICIENT_INPUT": {
              "expected": 1,
              "actual": 0
            }
          }
        }
      },
      "insufficientSignalCount": 1,
      "failedCallCount": 0,
      "latencyMs": {
        "observed": 12,
        "unknown": 0,
        "mean": 5875.226020916666,
        "median": 4833.5310210000025
      },
      "costUsd": {
        "observed": 12,
        "unknown": 0,
        "meanObserved": 0.0010449749999999999,
        "totalObserved": 0.012539699999999999,
        "totalUpperBound": 0.1645488,
        "meanUpperBound": 0.0137124
      }
    }
  },
  "rows": 24,
  "accountingBuckets": {
    "sharedSetup": {
      "parentStartupMs": 775,
      "parentProcessWallMs": 74065.725334,
      "parentElapsedMs": 73125,
      "contextPackingMs": null,
      "providerUsage": {
        "inputTokens": 0,
        "outputTokens": 0,
        "reasoningTokens": 0
      },
      "costUsd": 0,
      "provenance": "known zero provider calls for local parent setup; packing time was not separately measured"
    },
    "mainWorker": {
      "calls": 0,
      "inputTokens": 0,
      "outputTokens": 0,
      "reasoningTokens": 0,
      "costUsd": 0,
      "provenance": "known zero in selector-only Type 1"
    },
    "selectorGate": {
      "jev": {
        "calls": 12,
        "scoredRows": 12,
        "historicalRows": 0,
        "usage": {
          "inputTokens": {
            "sumKnown": 14657,
            "knownCalls": 12,
            "unknownCalls": 0
          },
          "outputTokens": {
            "sumKnown": 1698,
            "knownCalls": 12,
            "unknownCalls": 0
          },
          "cachedInputTokens": {
            "sumKnown": null,
            "knownCalls": 0,
            "unknownCalls": 12
          },
          "cacheWriteTokens": {
            "sumKnown": null,
            "knownCalls": 0,
            "unknownCalls": 12
          },
          "reasoningTokens": {
            "sumKnown": null,
            "knownCalls": 0,
            "unknownCalls": 12
          },
          "totalTokens": {
            "sumKnown": 16355,
            "knownCalls": 12,
            "unknownCalls": 0
          }
        },
        "cost": {
          "observedCalls": 12,
          "unknownCostCalls": 0,
          "observedTotalUsd": 0.0006155939999999999,
          "meanObservedUsd": 0.00005129949999999999,
          "provenanceCounts": {
            "estimated-from-2026-09-26-listed-rates; cached-read count unavailable, full input charged at standard input rate": 12
          },
          "reservedUpperBoundUsd": 0.006225408
        },
        "comparisonUsageIncludingHistoricalRows": {
          "inputTokens": {
            "sumKnown": 14657,
            "knownCalls": 12,
            "unknownCalls": 0
          },
          "outputTokens": {
            "sumKnown": 1698,
            "knownCalls": 12,
            "unknownCalls": 0
          },
          "cachedInputTokens": {
            "sumKnown": null,
            "knownCalls": 0,
            "unknownCalls": 12
          },
          "cacheWriteTokens": {
            "sumKnown": null,
            "knownCalls": 0,
            "unknownCalls": 12
          },
          "reasoningTokens": {
            "sumKnown": null,
            "knownCalls": 0,
            "unknownCalls": 12
          },
          "totalTokens": {
            "sumKnown": 16355,
            "knownCalls": 12,
            "unknownCalls": 0
          }
        },
        "comparisonCostIncludingHistoricalRows": {
          "observedCalls": 12,
          "unknownCostCalls": 0,
          "observedTotalUsd": 0.0006155939999999999,
          "meanObservedUsd": 0.00005129949999999999,
          "provenanceCounts": {
            "estimated-from-2026-09-26-listed-rates; cached-read count unavailable, full input charged at standard input rate": 12
          },
          "reservedUpperBoundUsd": 0.006225408
        }
      },
      "subagent": {
        "calls": 12,
        "scoredRows": 12,
        "historicalRows": 0,
        "usage": {
          "inputTokens": {
            "sumKnown": 13723,
            "knownCalls": 12,
            "unknownCalls": 0
          },
          "outputTokens": {
            "sumKnown": 7019,
            "knownCalls": 12,
            "unknownCalls": 0
          },
          "cachedInputTokens": {
            "sumKnown": 2816,
            "knownCalls": 12,
            "unknownCalls": 0
          },
          "cacheWriteTokens": {
            "sumKnown": 0,
            "knownCalls": 12,
            "unknownCalls": 0
          },
          "reasoningTokens": {
            "sumKnown": null,
            "knownCalls": 0,
            "unknownCalls": 12
          },
          "totalTokens": {
            "sumKnown": 20742,
            "knownCalls": 12,
            "unknownCalls": 0
          }
        },
        "cost": {
          "observedCalls": 12,
          "unknownCostCalls": 0,
          "observedTotalUsd": 0.012539699999999999,
          "meanObservedUsd": 0.0010449749999999999,
          "provenanceCounts": {
            "estimated-from-2026-09-26-max-route-ceiling": 12
          },
          "reservedUpperBoundUsd": 0.1645488
        },
        "comparisonUsageIncludingHistoricalRows": {
          "inputTokens": {
            "sumKnown": 13723,
            "knownCalls": 12,
            "unknownCalls": 0
          },
          "outputTokens": {
            "sumKnown": 7019,
            "knownCalls": 12,
            "unknownCalls": 0
          },
          "cachedInputTokens": {
            "sumKnown": 2816,
            "knownCalls": 12,
            "unknownCalls": 0
          },
          "cacheWriteTokens": {
            "sumKnown": 0,
            "knownCalls": 12,
            "unknownCalls": 0
          },
          "reasoningTokens": {
            "sumKnown": null,
            "knownCalls": 0,
            "unknownCalls": 12
          },
          "totalTokens": {
            "sumKnown": 20742,
            "knownCalls": 12,
            "unknownCalls": 0
          }
        },
        "comparisonCostIncludingHistoricalRows": {
          "observedCalls": 12,
          "unknownCostCalls": 0,
          "observedTotalUsd": 0.012539699999999999,
          "meanObservedUsd": 0.0010449749999999999,
          "provenanceCounts": {
            "estimated-from-2026-09-26-max-route-ceiling": 12
          },
          "reservedUpperBoundUsd": 0.1645488
        }
      }
    },
    "reviewer": {
      "calls": 0,
      "inputTokens": 0,
      "outputTokens": 0,
      "reasoningTokens": 0,
      "costUsd": 0,
      "provenance": "known zero in selector-only Type 1"
    },
    "fixtureValidation": {
      "source": "benchmarks/state/spend-ledger.json",
      "separateFromGateRows": true,
      "calls": 7,
      "unknownCostCalls": 3,
      "observedTotalUsd": 0.010588894,
      "reservedUpperBoundUsd": 0.1253968,
      "provenance": "cumulative fixture validation expense from the ledger; distinct from per-gate estimates"
    }
  },
  "freshRows": 24,
  "historicalControlRows": 0,
  "parentProcessWallMs": 74065.725334
}
