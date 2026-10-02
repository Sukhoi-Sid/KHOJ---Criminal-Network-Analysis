export const ResolutionEvents = {
  NORMALIZED: 'SourceDataNormalized', STARTED: 'EntityResolutionStarted',
  CANDIDATE: 'ResolutionCandidateCreated', AUTO: 'EntityAutoResolved',
  REVIEW: 'EntityResolutionReviewRequired', ACCEPTED: 'EntityResolutionAccepted',
  REJECTED: 'EntityResolutionRejected', COMPLETED: 'EntityResolutionCompleted',
} as const;
