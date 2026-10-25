import type { ApprovalBroker, Decision } from "./approvals.ts";
import type { DiscordRest } from "./rest.ts";
import { CallbackType, EPHEMERAL, InteractionType, clip, type Interaction } from "./types.ts";

// One INTERACTION_CREATE frame is untrusted input from Discord: it can be a click on another
// session's buttons, from a user this extension does not listen to, or on a request that was
// answered at the keyboard a second ago. Every branch answers the clicker in visible text,
// because a silent return is indistinguishable from a dead bridge.

export type RouteCode = "decision" | "detail" | "stale" | "wrong-user" | "not-a-click";

export type RouteResult = { code: RouteCode; decision?: Decision; note?: string };

export type Router = (interaction: Interaction) => Promise<RouteResult>;

/** The button labels a clicker sees when their click matched nothing live. */
const STALE = "That request is already answered — check the terminal or the embed.";
const NOT_YOURS = "pi-discord-comms only listens to its configured user.";

export function createInteractionRouter(deps: {
  rest: DiscordRest;
  broker: ApprovalBroker;
  userId: string;
  log: (message: string, warning?: boolean) => void;
}): Router {
  return async (interaction) => {
    // MESSAGE_COMPONENT is 3. Accepting anything else here answers slash commands, autocompletes
    // and modals this extension never asked for, and accepting 2 answers nothing at all.
    if (interaction.type !== InteractionType.MessageComponent) {
      return { code: "not-a-click", note: `interaction type ${interaction.type}` };
    }

    // Discord fails the click unless the interaction is answered within 3 s. A deferred update
    // answers it without a loading state; the embed itself is edited when the decision lands.
    try {
      await deps.rest.interactionAck(interaction, CallbackType.DeferredUpdateMessage);
    } catch (err) {
      // Keep going: settling the blocked tool call matters more than the ack.
      deps.log(`could not acknowledge the click — ${(err as Error).message}`, true);
    }

    // `member.user` in a guild, `user` in a DM. No identity means no authorisation check, so refuse.
    const who = interaction.member?.user?.id ?? interaction.user?.id;
    const say = async (content: string) => {
      // flags 64 is invalid in DMs, where the interaction carries no guild_id.
      const payload = { content: clip(content, 2000), ...(interaction.guild_id ? { flags: EPHEMERAL } : {}) };
      try {
        await deps.rest.interactionFollowup(interaction, payload);
      } catch (err) {
        deps.log(`could not reply to the click — ${(err as Error).message}`, true);
      }
    };

    if (!who) return { code: "wrong-user", note: "no user id on the interaction" };
    if (who !== deps.userId) {
      await say(NOT_YOURS);
      return { code: "wrong-user", note: `${who} is not the configured user` };
    }

    const outcome = deps.broker.handle(interaction);
    if (outcome.kind === "detail") {
      await say(deps.broker.detailFor(interaction) ?? STALE);
      return { code: "detail" };
    }
    if (outcome.kind === "unknown") {
      await say(STALE);
      return { code: "stale", note: `custom_id ${interaction.data?.custom_id ?? "(none)"}` };
    }
    return { code: "decision", decision: outcome.decision };
  };
}
