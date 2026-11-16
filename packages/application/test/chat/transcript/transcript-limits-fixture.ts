import { defaultTranscriptLimits, type TranscriptLimits } from '@moonbase/application/chat';

/**
 * The transcript's retention limits at an eighth of production's, scaled together so they keep
 * their ratios, for tests that fill them; its waits stay.
 */
export const scaledTranscriptLimits: TranscriptLimits = {
  ...defaultTranscriptLimits,
  summaryRecords: defaultTranscriptLimits.summaryRecords / 8,
  summaryBytes: defaultTranscriptLimits.summaryBytes / 8,
  contentBytes: defaultTranscriptLimits.contentBytes / 8,
  findMatches: defaultTranscriptLimits.findMatches / 8,
};
