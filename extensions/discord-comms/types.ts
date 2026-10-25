// The handful of Discord payload shapes this extension touches. Kept inline so the
// package has no runtime or dev dependency on discord-api-types.

export type EmbedField = { name: string; value: string; inline?: boolean };

export type Embed = {
  title?: string;
  description?: string;
  color?: number;
  fields?: EmbedField[];
  footer?: { text: string };
  timestamp?: string;
};

export const ButtonStyle = { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 } as const;

// Numbers are the wire values, fixed by Discord; see
// https://docs.discord.com/developers/interactions/receiving-and-responding
// A button click is a MESSAGE_COMPONENT (3). APPLICATION_COMMAND (2) is a slash command,
// which this extension does not use, so mixing the two up silently drops every click.
export const InteractionType = {
  Ping: 1,
  ApplicationCommand: 2,
  MessageComponent: 3,
  Autocomplete: 4,
  ModalSubmit: 5,
} as const;

export const CallbackType = {
  /** Acknowledge without responding; nothing is shown. */
  Pong: 1,
  ChannelMessageWithSource: 4,
  DeferredChannelMessageWithSource: 5,
  /** For components: acknowledge now, edit the original message later. No loading state. */
  DeferredUpdateMessage: 6,
  UpdateMessage: 7,
} as const;

/** Message flag 1 << 6: visible only to the clicking user. Invalid in DMs. */
export const EPHEMERAL = 64;

export type Button = {
  type: 2;
  style: (typeof ButtonStyle)[keyof typeof ButtonStyle];
  label: string;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
};

export type ActionRow = { type: 1; components: Button[] };

/**
 * The same rows with every button greyed out, for an embed rewritten after its answer
 * landed: an embed that still looks clickable is read as still answering.
 */
export const disabledRows = (rows: ActionRow[]): ActionRow[] =>
  rows.map((row) => ({ ...row, components: row.components.map((b) => ({ ...b, disabled: true })) }));

export type MessagePayload = {
  content?: string;
  embeds?: Embed[];
  components?: ActionRow[];
  /** 64 = ephemeral (visible only to the clicking user); not valid in DMs. */
  flags?: number;
};

export type DiscordMessage = {
  id: string;
  channel_id: string;
  channel_type?: number;
  author: { id: string; bot?: boolean };
  content?: string;
};

export type Interaction = {
  id: string;
  token: string;
  application_id: string;
  type: number;
  data?: { custom_id?: string; component_type?: number };
  guild_id?: string;
  channel?: { id?: string; type?: number };
  channel_id?: string;
  message?: { id: string };
  /** Present when the click happened in a guild; `user` when it happened in a DM. */
  member?: { user?: { id: string } };
  user?: { id: string };
};

/** Discord limits: 2000 chars of content, 4096 per embed description, 1024 per field value. */
export const EMBED_DESCRIPTION_LIMIT = 4096;

export const clip = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;

/**
 * The embed shape every ping from this extension uses, so each one carries the same footer
 * and a clipped body. `footer` names the session that sent it: two Pi windows can post into
 * the same channel days apart, and an old embed is otherwise untraceable.
 */
export const buildEmbed = (
  footer: string,
  title: string,
  description: string,
  color: number,
  fields?: EmbedField[],
): Embed => ({
  title,
  description: clip(description || "—", EMBED_DESCRIPTION_LIMIT),
  color,
  fields,
  footer: { text: footer },
  timestamp: new Date().toISOString(),
});

export const fence = (s: string, max = 1024): string => clip(`\`\`\`text\n${s}\n\`\`\``, max);

export const COLORS = { info: 0x5865f2, success: 0x57f287, warning: 0xfee75c, danger: 0xed4245 } as const;
