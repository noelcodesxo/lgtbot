import { setInterval } from 'node:timers';
import {
  ChatInputCommandInteraction,
  Client,
  DiscordAPIError,
  PermissionFlagsBits,
  Routes,
  SlashCommandSubcommandBuilder,
} from 'discord.js';
import {
  getDueExpiringMessages,
  removeExpiringMessage,
  saveExpiringMessage,
  type ExpiringMessage,
} from './db/expiring-messages';
import { logger } from './logger';

export const durations = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
} as const;

export function getExpiration(duration: string, now = new Date()): Date | null {
  const milliseconds = durations[duration as keyof typeof durations];
  return milliseconds ? new Date(now.getTime() + milliseconds) : null;
}

export function getExpiringMessageCommand() {
  return new SlashCommandSubcommandBuilder()
    .setName('send')
    .setDescription('Post a message that the bot deletes later')
    .addStringOption((option) =>
      option
        .setName('duration')
        .setDescription('When to delete the message')
        .setRequired(true)
        .addChoices(
          { name: 'After 1 hour', value: 'hour' },
          { name: 'After 1 day', value: 'day' },
          { name: 'After 1 week', value: 'week' }
        )
    )
    .addStringOption((option) =>
      option
        .setName('message')
        .setDescription('Your message (up to 1700 characters)')
        .setRequired(true)
        .setMaxLength(1700)
    );
}

type SendResult =
  | { status: 'scheduled'; messageId: string }
  | { status: 'send_failed' }
  | { status: 'save_failed' }
  | { status: 'untracked'; messageId: string };

export async function sendAndSchedule({
  send,
  save,
  compensate,
}: {
  send: () => Promise<string>;
  save: (messageId: string) => void;
  compensate: (messageId: string) => Promise<void>;
}): Promise<SendResult> {
  let messageId: string;
  try {
    messageId = await send();
  } catch {
    return { status: 'send_failed' };
  }

  try {
    save(messageId);
    return { status: 'scheduled', messageId };
  } catch {
    try {
      await compensate(messageId);
      return { status: 'save_failed' };
    } catch {
      return { status: 'untracked', messageId };
    }
  }
}

export async function handleExpiringMessageCommand(
  interaction: ChatInputCommandInteraction
) {
  if (!interaction.inGuild() || !interaction.guild || !interaction.channel) {
    await interaction.reply({
      content: 'This command only works in a server text channel.',
      ephemeral: true,
    });
    return;
  }

  const channel = interaction.channel;
  const me = interaction.guild.members.me;
  const permissions = me && channel.permissionsFor(me);
  if (
    !channel.isTextBased() ||
    !channel.isSendable() ||
    !permissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
    ])
  ) {
    await interaction.reply({
      content: 'I need permission to view and send messages in this channel.',
      ephemeral: true,
    });
    return;
  }

  const duration = interaction.options.getString('duration', true);
  const message = interaction.options.getString('message', true);
  const expiresAt = getExpiration(duration);
  if (!expiresAt || !message.trim() || message.length > 1700) {
    await interaction.reply({
      content:
        'Choose 1 hour, 1 day, or 1 week and enter a message of up to 1700 characters.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const guildId = interaction.guildId!;
  const channelId = channel.id;
  const result = await sendAndSchedule({
    send: async () => {
      const sent = await channel.send({
        content: `**From <@${interaction.user.id}> · deletes <t:${Math.floor(expiresAt.getTime() / 1000)}:R>**\n${message}`,
        allowedMentions: { parse: [] },
      });
      return sent.id;
    },
    save: (messageId) =>
      saveExpiringMessage({
        messageId,
        guildId,
        channelId,
        authorId: interaction.user.id,
        expiresAt,
      }),
    compensate: (messageId) =>
      interaction.client.rest.delete(
        Routes.channelMessage(channelId, messageId)
      ) as Promise<void>,
  });

  if (result.status === 'scheduled') {
    await interaction.editReply(
      `Posted your message. I’ll delete it <t:${Math.floor(expiresAt.getTime() / 1000)}:R>. Others may still see notifications or save a copy.`
    );
  } else if (result.status === 'untracked') {
    logger.error(
      { guildId, channelId, messageId: result.messageId },
      'URGENT: expiring message was posted but could not be tracked or removed'
    );
    await interaction.editReply(
      `Your message was posted, but automatic deletion was NOT scheduled. Please delete it manually now: https://discord.com/channels/${guildId}/${channelId}/${result.messageId}`
    );
  } else {
    logger.error(
      { guildId, channelId, status: result.status },
      'Could not schedule expiring message'
    );
    await interaction.editReply(
      result.status === 'send_failed'
        ? 'I could not confirm that your message was posted. Check this channel, and delete it manually if it appears.'
        : 'I could not schedule deletion, so I removed the posted message. Please try again later.'
    );
  }
}

function isMissingMessage(error: unknown) {
  return (
    error instanceof DiscordAPIError &&
    (error.code === 10008 || error.code === 10003)
  );
}

export async function deleteDueMessages({
  due = getDueExpiringMessages,
  remove = removeExpiringMessage,
  deleteMessage,
  now = new Date(),
}: {
  due?: (now: Date) => ExpiringMessage[];
  remove?: (messageId: string) => void;
  deleteMessage: (message: ExpiringMessage) => Promise<void>;
  now?: Date;
}) {
  for (const message of due(now)) {
    try {
      await deleteMessage(message);
      remove(message.messageId);
    } catch (error) {
      if (isMissingMessage(error)) {
        remove(message.messageId);
      } else {
        logger.error(
          { error, channelId: message.channelId, messageId: message.messageId },
          'Could not delete expiring message; will retry'
        );
      }
    }
  }
}

export function startExpiringMessageWorker(client: Client) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await deleteDueMessages({
        deleteMessage: async (message) => {
          await client.rest.delete(
            Routes.channelMessage(message.channelId, message.messageId)
          );
        },
      });
    } catch (error) {
      logger.error({ error }, 'Expiring message worker failed; will retry');
    } finally {
      running = false;
    }
  };
  void run();
  setInterval(() => void run(), 60 * 1000);
}
