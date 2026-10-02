-- CreateEnum
CREATE TYPE "NormalizedSourceKind" AS ENUM ('MENTION', 'RETURNED_INTELLIGENCE', 'CASE_METADATA');

-- CreateEnum
CREATE TYPE "ResolutionStatus" AS ENUM ('UNRESOLVED', 'REVIEW_REQUIRED', 'AUTO_RESOLVED', 'ACCEPTED', 'DISTINCT', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'entity_integrate';
ALTER TYPE "AuditAction" ADD VALUE 'entity_read';
ALTER TYPE "AuditAction" ADD VALUE 'entity_review';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditResourceType" ADD VALUE 'canonical_entity';
ALTER TYPE "AuditResourceType" ADD VALUE 'resolution_candidate';

-- CreateTable
CREATE TABLE "normalized_source_records" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "entityType" "MentionType" NOT NULL,
    "rawValue" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "validIdentifier" BOOLEAN NOT NULL DEFAULT false,
    "sourceKind" "NormalizedSourceKind" NOT NULL,
    "sourceId" TEXT,
    "department" TEXT,
    "documentId" TEXT,
    "evidenceRecordId" TEXT,
    "mentionId" TEXT,
    "responseId" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reliabilityTier" "ReliabilityTier" NOT NULL,
    "attributes" JSONB NOT NULL,
    "identifiers" JSONB NOT NULL,
    "sourceLocation" JSONB NOT NULL,
    "sourceTimestamp" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "normalized_source_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_entities" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "entityType" "MentionType" NOT NULL,
    "membershipKey" TEXT NOT NULL,
    "displayLabel" TEXT NOT NULL,
    "resolutionStatus" "ResolutionStatus" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canonical_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_source_links" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_source_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resolution_candidates" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "leftId" TEXT NOT NULL,
    "rightId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "signals" JSONB NOT NULL,
    "conflicts" JSONB NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "status" "ResolutionStatus" NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resolution_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resolution_history" (
    "id" TEXT NOT NULL,
    "sequence" SERIAL NOT NULL,
    "caseId" TEXT NOT NULL,
    "candidateId" TEXT,
    "actorId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "eventType" TEXT NOT NULL,
    "fromStatus" "ResolutionStatus",
    "toStatus" "ResolutionStatus",
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resolution_history_pkey" PRIMARY KEY ("id")
);

-- Domain invariants also apply to direct database writes.
ALTER TABLE "normalized_source_records" ADD CONSTRAINT "normalized_confidence_range" CHECK ("confidence" >= 0 AND "confidence" <= 1),
 ADD CONSTRAINT "normalized_entity_type" CHECK ("entityType" <> 'date');
ALTER TABLE "canonical_entities" ADD CONSTRAINT "canonical_confidence_range" CHECK ("confidence" >= 0 AND "confidence" <= 1),
 ADD CONSTRAINT "canonical_entity_type" CHECK ("entityType" <> 'date');
ALTER TABLE "resolution_candidates" ADD CONSTRAINT "candidate_score_range" CHECK ("score" >= 0 AND "score" <= 1),
 ADD CONSTRAINT "candidate_distinct_endpoints" CHECK ("leftId" < "rightId"),
 ADD CONSTRAINT "candidate_revision_positive" CHECK ("revision" > 0);

-- CreateIndex
CREATE INDEX "normalized_source_records_caseId_active_entityType_normaliz_idx" ON "normalized_source_records"("caseId", "active", "entityType", "normalizedValue");

-- CreateIndex
CREATE UNIQUE INDEX "normalized_source_records_caseId_sourceKey_key" ON "normalized_source_records"("caseId", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "normalized_source_records_id_caseId_key" ON "normalized_source_records"("id", "caseId");

-- CreateIndex
CREATE INDEX "canonical_entities_caseId_active_entityType_idx" ON "canonical_entities"("caseId", "active", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_entities_caseId_membershipKey_key" ON "canonical_entities"("caseId", "membershipKey");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_entities_id_caseId_key" ON "canonical_entities"("id", "caseId");

-- CreateIndex
CREATE INDEX "entity_source_links_caseId_recordId_idx" ON "entity_source_links"("caseId", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "entity_source_links_entityId_recordId_key" ON "entity_source_links"("entityId", "recordId");

-- CreateIndex
CREATE INDEX "resolution_candidates_caseId_active_status_idx" ON "resolution_candidates"("caseId", "active", "status");

-- CreateIndex
CREATE UNIQUE INDEX "resolution_candidates_caseId_leftId_rightId_key" ON "resolution_candidates"("caseId", "leftId", "rightId");

-- CreateIndex
CREATE UNIQUE INDEX "resolution_candidates_id_caseId_key" ON "resolution_candidates"("id", "caseId");

-- CreateIndex
CREATE UNIQUE INDEX "resolution_history_sequence_key" ON "resolution_history"("sequence");

-- CreateIndex
CREATE INDEX "resolution_history_caseId_sequence_idx" ON "resolution_history"("caseId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "resolution_history_caseId_idempotencyKey_key" ON "resolution_history"("caseId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "normalized_source_records" ADD CONSTRAINT "normalized_source_records_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "normalized_source_records" ADD CONSTRAINT "normalized_source_records_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "normalized_source_records" ADD CONSTRAINT "normalized_source_records_evidenceRecordId_fkey" FOREIGN KEY ("evidenceRecordId") REFERENCES "evidence_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "normalized_source_records" ADD CONSTRAINT "normalized_source_records_mentionId_fkey" FOREIGN KEY ("mentionId") REFERENCES "mentions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "normalized_source_records" ADD CONSTRAINT "normalized_source_records_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "intelligence_responses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_entities" ADD CONSTRAINT "canonical_entities_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_source_links" ADD CONSTRAINT "entity_source_links_entityId_caseId_fkey" FOREIGN KEY ("entityId", "caseId") REFERENCES "canonical_entities"("id", "caseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_source_links" ADD CONSTRAINT "entity_source_links_recordId_caseId_fkey" FOREIGN KEY ("recordId", "caseId") REFERENCES "normalized_source_records"("id", "caseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolution_candidates" ADD CONSTRAINT "resolution_candidates_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolution_candidates" ADD CONSTRAINT "resolution_candidates_leftId_caseId_fkey" FOREIGN KEY ("leftId", "caseId") REFERENCES "normalized_source_records"("id", "caseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolution_candidates" ADD CONSTRAINT "resolution_candidates_rightId_caseId_fkey" FOREIGN KEY ("rightId", "caseId") REFERENCES "normalized_source_records"("id", "caseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolution_history" ADD CONSTRAINT "resolution_history_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolution_history" ADD CONSTRAINT "resolution_history_candidateId_caseId_fkey" FOREIGN KEY ("candidateId", "caseId") REFERENCES "resolution_candidates"("id", "caseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resolution_history" ADD CONSTRAINT "resolution_history_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
