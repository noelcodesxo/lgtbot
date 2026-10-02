import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { db } from '../db/index';
import { expiringMessages } from '../db/schema';
import {
  getDueExpiringMessages,
  removeExpiringMessage,
  saveExpiringMessage,
} from '../db/expiring-messages';
import {
  deleteDueMessages,
  getExpiration,
  sendAndSchedule,
} from '../expiring-messages';
import { logger } from '../logger';

const now = new Date('2026-10-02T12:00:00Z');

describe('expiring messages', () => {
  beforeEach(() => db.delete(expiringMessages).run());

  test('only supports the three advertised durations', () => {
    expect(getExpiration('hour', now)?.getTime()).toBe(
      now.getTime() + 60 * 60 * 1000
    );
    expect(getExpiration('day', now)?.getTime()).toBe(
      now.getTime() + 24 * 60 * 60 * 1000
    );
    expect(getExpiration('week', now)?.getTime()).toBe(
      now.getTime() + 7 * 24 * 60 * 60 * 1000
    );
    expect(getExpiration('month', now)).toBeNull();
  });

  test('schedules only after a successful post and leaves content out of storage', async () => {
    const result = await sendAndSchedule({
      send: async () => 'message-1',
      save: (messageId) =>
        saveExpiringMessage({
          messageId,
          guildId: 'guild-1',
          channelId: 'channel-1',
          authorId: 'user-1',
          expiresAt: now,
        }),
      compensate: async () => {
        throw new Error('should not be called');
      },
    });
    expect(result).toEqual({ status: 'scheduled', messageId: 'message-1' });
    expect(getDueExpiringMessages(now)).toEqual([
      {
        messageId: 'message-1',
        guildId: 'guild-1',
        channelId: 'channel-1',
        authorId: 'user-1',
        expiresAt: now,
      },
    ]);
  });

  test('reports an untracked post if both save and compensating delete fail', async () => {
    let attemptedDelete = false;
    const result = await sendAndSchedule({
      send: async () => 'message-2',
      save: () => {
        throw new Error('database unavailable');
      },
      compensate: async () => {
        attemptedDelete = true;
        throw new Error('Discord unavailable');
      },
    });
    expect(result).toEqual({ status: 'untracked', messageId: 'message-2' });
    expect(attemptedDelete).toBe(true);
  });

  test('removes a posted message when scheduling fails', async () => {
    const deleted: string[] = [];
    const result = await sendAndSchedule({
      send: async () => 'message-2',
      save: () => {
        throw new Error('database unavailable');
      },
      compensate: async (messageId) => {
        deleted.push(messageId);
      },
    });
    expect(result).toEqual({ status: 'save_failed' });
    expect(deleted).toEqual(['message-2']);
  });

  test('removes a due row only after deletion succeeds and retries failures', async () => {
    saveExpiringMessage({
      messageId: 'message-3',
      guildId: 'guild-1',
      channelId: 'channel-1',
      authorId: 'user-1',
      expiresAt: now,
    });
    const later = new Date(now.getTime() + 1000);
    saveExpiringMessage({
      messageId: 'message-4',
      guildId: 'guild-1',
      channelId: 'channel-1',
      authorId: 'user-1',
      expiresAt: later,
    });

    await deleteDueMessages({
      now,
      deleteMessage: async () => {
        throw new Error('temporary Discord error');
      },
    });
    expect(getDueExpiringMessages(now)).toHaveLength(1);

    const deleted: string[] = [];
    await deleteDueMessages({
      now,
      deleteMessage: async (message) => {
        deleted.push(message.messageId);
      },
    });
    expect(deleted).toEqual(['message-3']);
    expect(getDueExpiringMessages(now)).toHaveLength(0);
    expect(getDueExpiringMessages(later)).toHaveLength(1);
    removeExpiringMessage('message-4');
  });

  test('reaches newer due rows after 100 persistent failures, then wraps to retry', async () => {
    for (let index = 0; index < 150; index++) {
      saveExpiringMessage({
        messageId: `message-${String(index).padStart(3, '0')}`,
        guildId: 'guild-1',
        channelId: 'channel-1',
        authorId: 'user-1',
        expiresAt: now,
      });
    }

    const attempted: string[] = [];
    const log = spyOn(logger, 'error').mockImplementation(() => logger);
    try {
      const deleteMessage = async (message: { messageId: string }) => {
        attempted.push(message.messageId);
        if (message.messageId < 'message-100') {
          throw new Error('persistent permission failure');
        }
      };
      const firstCursor = await deleteDueMessages({ now, deleteMessage });
      expect(attempted).toHaveLength(100);
      expect(firstCursor?.messageId).toBe('message-099');

      const secondCursor = await deleteDueMessages({
        now,
        after: firstCursor,
        deleteMessage,
      });
      expect(attempted.slice(100)).toHaveLength(50);
      expect(attempted.at(-1)).toBe('message-149');
      expect(secondCursor?.messageId).toBe('message-149');
      expect(getDueExpiringMessages(now)).toHaveLength(100);

      await deleteDueMessages({
        now,
        after: secondCursor,
        deleteMessage: async (message) => {
          attempted.push(message.messageId);
        },
      });
      expect(attempted.slice(150)).toHaveLength(100);
      expect(getDueExpiringMessages(now)).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });
});
