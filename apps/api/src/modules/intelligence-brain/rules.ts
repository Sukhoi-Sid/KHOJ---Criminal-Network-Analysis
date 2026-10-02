// Version all reproducible outputs when changing analytical semantics.
export const BRAIN_RULES = {
  version: 'merged-5-6-v1', maxNodes: 2000, maxEdges: 10000, maxHops: 4, maxResults: 200,
  pagerankDamping: .85, pagerankIterations: 100, pagerankTolerance: 1e-8,
  communityPasses: 30, windowMs: 60 * 60 * 1000, proximityMs: 15 * 60 * 1000,
  shortCommunicationMs: 5 * 60 * 1000, minimumBurst: 3, spikeRatio: 3,
  iqrMultiplier: 1.5, minimumFinancialBaseline: 4, fanThreshold: 3,
  highDegree: 4, bridgeBetweenness: .1, minimumLocationOverlap: 2,
} as const;
