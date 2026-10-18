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

export type Button = {
  type: 2;
  style: (typeof ButtonStyle)[keyof typeof ButtonStyle];
  label: string;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
};

export type ActionRow = { type: 1; components: Button[] };

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
  data?: { custom_id?: string };
  channel?: { id: string };
  message?: { id: string };
  member?: { user?: { id: string } };
  user?: { id: string };
};

/** Discord limits: 2000 chars of content, 4096 per embed description, 1024 per field value. */
export const clip = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;

export const fence = (s: string, max = 1024): string => clip(`\`\`\`text\n${s}\n\`\`\``, max);

export const COLORS = { info: 0x5865f2, success: 0x57f287, warning: 0xfee75c, danger: 0xed4245 } as const;
