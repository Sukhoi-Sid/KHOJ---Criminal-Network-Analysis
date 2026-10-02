import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
export const hashJson = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const toJson = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
