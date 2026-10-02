import bcrypt from 'bcryptjs';
import { prisma } from '../core/db';

export const TEST_PASSWORD = 'Test-Passw0rd!';

/**
 * Truncates all app tables. Requires a real Postgres reachable via
 * DATABASE_URL (see .env.example / docker-compose.yml) — these are
 * integration tests, not unit tests with a mocked DB.
 */
export async function resetDb(): Promise<void> {
  if (process.env.NODE_ENV !== 'test' || !new URL(process.env.DATABASE_URL!).pathname.endsWith('_test')) {
    throw new Error('Refusing to clear a non-test database');
  }
  await prisma.$transaction([
    prisma.brainEvent.deleteMany(),
    prisma.signalSupport.deleteMany(),
    prisma.analyticalSignal.deleteMany(),
    prisma.analysisRun.deleteMany(),
    prisma.graphSyncState.deleteMany(),
    prisma.derivedRelationship.deleteMany(),
    prisma.resolutionHistory.deleteMany(),
    prisma.resolutionCandidate.deleteMany(),
    prisma.entitySourceLink.deleteMany(),
    prisma.canonicalEntity.deleteMany(),
    prisma.normalizedSourceRecord.deleteMany(),
    prisma.intelligenceTransition.deleteMany(),
    prisma.intelligenceResponse.deleteMany(),
    prisma.intelligenceAuthorization.deleteMany(),
    prisma.intelligenceRequest.deleteMany(),
    prisma.intelligenceGapOrigin.deleteMany(),
    prisma.intelligenceGap.deleteMany(),
    prisma.caseContextAnalysis.deleteMany(),
    prisma.intelligenceSource.deleteMany(),
    prisma.mention.deleteMany(),
    prisma.provenance.deleteMany(),
    prisma.evidenceRecord.deleteMany(),
    prisma.document.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.caseIntelligenceState.deleteMany(),
    prisma.caseAssignment.deleteMany(),
    prisma.case.deleteMany(),
    prisma.user.deleteMany(),
  ]);
}

export async function createTestUser(
  email: string,
  role: 'investigator' | 'supervisor' | 'auditor' | 'admin',
  name = email,
) {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 4); // low cost factor — tests only
  return prisma.user.create({ data: { email, name, role, passwordHash } });
}

/** Builds a real one-page PDF with the given text, for PDF-ingestion tests (pdf-parse needs a genuinely valid PDF, not a hand-rolled stub). */
export async function buildTestPdf(text: string): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;
  const doc = new PDFDocument({ size: 'A4' });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
  doc.text(text);
  doc.end();
  return done;
}
