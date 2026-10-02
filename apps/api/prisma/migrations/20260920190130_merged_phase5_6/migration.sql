-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'graph_sync';
ALTER TYPE "AuditAction" ADD VALUE 'brain_analyze';
ALTER TYPE "AuditAction" ADD VALUE 'brain_read';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditResourceType" ADD VALUE 'case_graph';
ALTER TYPE "AuditResourceType" ADD VALUE 'analytical_signal';

-- CreateTable
CREATE TABLE "derived_relationships" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "stableKey" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'DIRECTED',
    "findingKind" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "strength" DOUBLE PRECISION NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "sourceSystem" TEXT NOT NULL,
    "sourceRecordIds" JSONB NOT NULL,
    "evidenceRefs" JSONB NOT NULL,
    "extractionMethod" TEXT NOT NULL,
    "algorithmVersion" TEXT NOT NULL,
    "attributes" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "derived_relationships_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "derived_relationships" ADD CONSTRAINT "relationship_confidence_range" CHECK ("confidence" BETWEEN 0 AND 1 AND "strength" BETWEEN 0 AND 1),
 ADD CONSTRAINT "relationship_fact_kind" CHECK ("findingKind" IN ('FACT','INFERENCE')),
 ADD CONSTRAINT "relationship_direction" CHECK ("direction" = 'DIRECTED'),
 ADD CONSTRAINT "relationship_provenance" CHECK (jsonb_array_length("evidenceRefs") > 0 AND jsonb_array_length("sourceRecordIds") > 0);

-- CreateTable
CREATE TABLE "graph_sync_states" (
    "caseId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sourceDigest" TEXT,
    "graphDigest" TEXT,
    "syncedAt" TIMESTAMP(3),
    "error" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "graph_sync_states_pkey" PRIMARY KEY ("caseId")
);

-- CreateTable
CREATE TABLE "analysis_runs" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "inputDigest" TEXT NOT NULL,
    "algorithmVersion" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "summary" JSONB NOT NULL,
    "error" TEXT,

    CONSTRAINT "analysis_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytical_signals" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "stableKey" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "findingKind" TEXT NOT NULL DEFAULT 'SIGNAL',
    "entityIds" JSONB NOT NULL,
    "strength" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "timeFrom" TIMESTAMP(3),
    "timeTo" TIMESTAMP(3),
    "rule" TEXT NOT NULL,
    "algorithmVersion" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "reason" JSONB NOT NULL,
    "evidenceRefs" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNREVIEWED',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytical_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_supports" (
    "caseId" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "relationshipId" TEXT NOT NULL,

    CONSTRAINT "signal_supports_pkey" PRIMARY KEY ("signalId","relationshipId")
);

-- CreateTable
CREATE TABLE "brain_events" (
    "id" TEXT NOT NULL,
    "sequence" SERIAL NOT NULL,
    "caseId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brain_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "derived_relationships_caseId_active_type_occurredAt_idx" ON "derived_relationships"("caseId", "active", "type", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "derived_relationships_caseId_stableKey_key" ON "derived_relationships"("caseId", "stableKey");

-- CreateIndex
CREATE UNIQUE INDEX "derived_relationships_id_caseId_key" ON "derived_relationships"("id", "caseId");

-- CreateIndex
CREATE INDEX "analysis_runs_caseId_type_startedAt_idx" ON "analysis_runs"("caseId", "type", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "analysis_runs_id_caseId_key" ON "analysis_runs"("id", "caseId");

-- CreateIndex
CREATE INDEX "analytical_signals_caseId_active_type_idx" ON "analytical_signals"("caseId", "active", "type");

-- CreateIndex
CREATE UNIQUE INDEX "analytical_signals_caseId_stableKey_key" ON "analytical_signals"("caseId", "stableKey");

-- CreateIndex
CREATE UNIQUE INDEX "analytical_signals_id_caseId_key" ON "analytical_signals"("id", "caseId");

-- CreateIndex
CREATE UNIQUE INDEX "brain_events_sequence_key" ON "brain_events"("sequence");

-- CreateIndex
CREATE INDEX "brain_events_caseId_sequence_idx" ON "brain_events"("caseId", "sequence");

-- AddForeignKey
ALTER TABLE "derived_relationships" ADD CONSTRAINT "derived_relationships_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "derived_relationships" ADD CONSTRAINT "derived_relationships_sourceId_caseId_fkey" FOREIGN KEY ("sourceId", "caseId") REFERENCES "canonical_entities"("id", "caseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "derived_relationships" ADD CONSTRAINT "derived_relationships_targetId_caseId_fkey" FOREIGN KEY ("targetId", "caseId") REFERENCES "canonical_entities"("id", "caseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graph_sync_states" ADD CONSTRAINT "graph_sync_states_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytical_signals" ADD CONSTRAINT "analytical_signals_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytical_signals" ADD CONSTRAINT "analytical_signals_runId_caseId_fkey" FOREIGN KEY ("runId", "caseId") REFERENCES "analysis_runs"("id", "caseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_supports" ADD CONSTRAINT "signal_supports_signalId_caseId_fkey" FOREIGN KEY ("signalId", "caseId") REFERENCES "analytical_signals"("id", "caseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_supports" ADD CONSTRAINT "signal_supports_relationshipId_caseId_fkey" FOREIGN KEY ("relationshipId", "caseId") REFERENCES "derived_relationships"("id", "caseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_events" ADD CONSTRAINT "brain_events_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
