import { eq, lte } from 'drizzle-orm';
import { db } from './index';
import { expiringMessages } from './schema';

export type ExpiringMessage = typeof expiringMessages.$inferSelect;

export function saveExpiringMessage(message: ExpiringMessage) {
  db.insert(expiringMessages).values(message).run();
}

export function getDueExpiringMessages(now: Date, limit = 100) {
  return db
    .select()
    .from(expiringMessages)
    .where(lte(expiringMessages.expiresAt, now))
    .orderBy(expiringMessages.expiresAt)
    .limit(limit)
    .all();
}

export function removeExpiringMessage(messageId: string) {
  db.delete(expiringMessages)
    .where(eq(expiringMessages.messageId, messageId))
    .run();
}
