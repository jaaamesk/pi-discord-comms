import type { Interaction, MessagePayload } from "./types.ts";

const API = "https://discord.com/api/v10";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal Discord REST client: serialized calls plus 429 handling. Discord allows
 * roughly 5 messages per 5 s per channel, and Pi's event volume is trivially inside
 * that once one status message is edited in place instead of sending per tool call, so
 * a single-file queue is enough and keeps ordering deterministic.
 */
export class DiscordRest {
  private tail: Promise<unknown> = Promise.resolve();
  private blockedUntil = 0;
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  call<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const run = async (): Promise<T> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const wait = this.blockedUntil - Date.now();
        if (wait > 0) {
          // Never let a rate limit hold up a blocking approval for minutes.
          if (wait > 15_000) throw new Error(`discord rate limited for ${Math.ceil(wait / 1000)}s`);
          await sleep(wait);
        }
        const res = await fetch(`${API}${path}`, {
          method,
          headers: { authorization: `Bot ${this.token}`, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (res.status === 429) {
          const j: { retry_after?: number } = await res.json().catch(() => ({}));
          this.blockedUntil = Date.now() + (Number(j?.retry_after) || 1) * 1000;
          continue;
        }
        if (!res.ok) throw new Error(`discord ${method} ${path} -> HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
        return (res.status === 204 ? undefined : await res.json()) as T;
      }
      throw new Error(`discord ${method} ${path} still rate limited`);
    };
    this.tail = this.tail.then(run, run);
    return this.tail as Promise<T>;
  }

  send = (channelId: string, payload: MessagePayload) =>
    this.call<{ id: string }>("POST", `/channels/${channelId}/messages`, payload);
  edit = (channelId: string, messageId: string, payload: Partial<MessagePayload>) =>
    this.call<{ id: string }>("PATCH", `/channels/${channelId}/messages/${messageId}`, payload);
  react = (channelId: string, messageId: string, emoji: string) =>
    this.call<void>("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  openDm = (userId: string) =>
    this.call<{ id: string }>("POST", "/users/@me/channels", { recipient_id: userId });
  appId = () => this.call<{ id: string }>("GET", "/oauth2/applications/@current");

  // Interactions must be answered within 3 s. A type 6 response acknowledges the click
  // without content; the visible message is then edited for up to 15 minutes.
  interactionAck = (interaction: Interaction) =>
    this.call<void>("POST", `/interactions/${interaction.id}/${interaction.token}/callback`, { type: 6 });
  interactionEdit = (interaction: Interaction, payload: Partial<MessagePayload>) =>
    this.call<{ id: string }>("PATCH", `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, payload);
  interactionFollowup = (interaction: Interaction, payload: MessagePayload) =>
    this.call<{ id: string }>("POST", `/webhooks/${interaction.application_id}/${interaction.token}`, payload);
}
