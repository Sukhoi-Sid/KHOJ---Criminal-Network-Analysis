import { eventBus, type DomainEvent } from '../../core/domain-events';
import { prisma } from '../../core/db';
import { DocumentIntelligenceEvents } from '../document-intelligence/events';
import type { ExtractionCompletedPayload } from '../document-intelligence/events';
import { Prisma } from '@prisma/client';
import { ResolutionEvents } from '../entity-resolution/events';
import { BrainEvents } from '../intelligence-brain/events';

// Case platform remains the only owner of the versioned state. Row locking
// prevents document and resolution events from overwriting each other's sections.
async function updateSummary(caseId: string, transform: (summary: Record<string,unknown>) => Record<string,unknown> | null) {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM case_intelligence_states WHERE "caseId" = ${caseId} FOR UPDATE`;
    const state = await tx.caseIntelligenceState.findUnique({ where: { caseId } });
    if (!state) return;
    const summary = transform((state.summary as Record<string,unknown>) ?? {});
    if (!summary) return;
    await tx.caseIntelligenceState.update({ where: { caseId },data: { version: { increment: 1 },summary: summary as Prisma.InputJsonValue } });
  });
}

/**
 * `case-platform` owns `CaseIntelligenceState` (module ownership table,
 * IMPLEMENTATION-BLUEPRINT.md §3) — it's the reader, document-intelligence
 * only ever *publishes* `ExtractionCompleted` on the existing `eventBus`.
 * Reuses the existing in-process event bus; no new pub/sub mechanism.
 *
 * Payload carries *absolute* per-document counts (not deltas), so a
 * reprocessed document overwrites its own entry here instead of double
 * counting — matching the same idempotency guarantee as the mention table
 * itself.
 */
let subscribed = false;

export function registerCaseIntelligenceStateSubscriber(): void {
  if (subscribed) {
    return;
  }
  subscribed = true;

  eventBus.subscribe(BrainEvents.COMPLETED,{
    async handle(event:DomainEvent) {
      await updateSummary(String(event.payload.caseId),summary=>{
        const previous=summary.brain as {sequence?:number;signals?:number}|undefined;
        if((previous?.sequence??-1)>=Number(event.payload.sequence))return null;
        return {...summary,brain:{...previous,...event.payload,signals:event.payload.signals??previous?.signals??null,completedAt:new Date(event.timestamp).toISOString(),derived:true}};
      });
    },
  });

  eventBus.subscribe(ResolutionEvents.COMPLETED, {
    async handle(event: DomainEvent) {
      const payload = event.payload;
      await updateSummary(String(payload.caseId), summary => {
        const previous = summary.entityResolution as { sequence?: number } | undefined;
        if ((previous?.sequence ?? -1) >= Number(payload.sequence)) return null;
        return { ...summary,entityResolution: { ...payload,lastCompletedAt: new Date(event.timestamp).toISOString() } };
      });
    },
  });

  eventBus.subscribe(DocumentIntelligenceEvents.EXTRACTION_COMPLETED, {
    async handle(event: DomainEvent) {
      const payload = event.payload as unknown as ExtractionCompletedPayload;

      await updateSummary(payload.caseId, summary => {
      const documents = (summary.documents as Record<string, unknown>) ?? {};
      return {
            ...summary,
            documents: {
              ...documents,
              [payload.documentId]: {
                mentionsTotal: payload.mentionsTotal,
                mentionCountsByType: payload.mentionCountsByType,
                lastExtractedAt: new Date().toISOString(),
              },
            },
          };
      });
    },
  });
}
