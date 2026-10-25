// Interaction routing tests: a real-shaped INTERACTION_CREATE must settle a blocked tool call.
// These exist because the shipped code compared `interaction.type` against 2, which is a slash
// command; a button click is 3, so every click was dropped before it was ever acknowledged.
// Run: node --experimental-strip-types test/interactions.ts
import { ApprovalBroker } from "../extensions/discord-comms/approvals.ts";
import { createInteractionRouter } from "../extensions/discord-comms/interactions.ts";
import type { Config } from "../extensions/discord-comms/config.ts";
import { CallbackType, EPHEMERAL, InteractionType, type Interaction } from "../extensions/discord-comms/types.ts";

const cfg = { approvals: "dangerous", raceTerminal: false, approvalTimeoutMs: 5_000, level: "milestones", deliverAs: "followUp" } as Config;

function harness(opts: { ackFails?: boolean } = {}) {
  const sent: any[] = [];
  const edited: any[] = [];
  const acked: any[] = [];
  const followups: any[] = [];
  const notes: string[] = [];
  const rest = {
    send: async (_c: string, payload: any) => {
      sent.push(payload);
      return { id: "m1" };
    },
    edit: async (_c: string, id: string, payload: any) => {
      edited.push({ id, payload });
      return { id };
    },
    interactionAck: async (i: Interaction, type: number) => {
      if (opts.ackFails) throw new Error("HTTP 400 Unknown Interaction Response Type");
      acked.push({ id: i.id, type });
    },
    interactionFollowup: async (i: Interaction, payload: any) => {
      followups.push({ id: i.id, payload });
      return { id: "f1" };
    },
  } as never;
  const broker = new ApprovalBroker(rest, cfg, "abcd", () => "chan1", (m: string, warn?: boolean) => notes.push(`${warn ? "warn" : "info"}: ${m}`));
  const route = createInteractionRouter({ rest, broker, userId: "owner", log: (m: string, warn?: boolean) => notes.push(`${warn ? "warn" : "info"}: ${m}`) });
  // A gateway click as Discord actually sends it: type 3, identity under member.user in a guild.
  const click = (custom_id: string, over: Partial<Interaction> = {}): Interaction =>
    ({
      id: `i-${custom_id}`,
      token: "secret-token",
      application_id: "app1",
      type: InteractionType.MessageComponent,
      data: { custom_id, component_type: 2 },
      guild_id: "guild1",
      channel: { id: "chan1", type: 0 },
      channel_id: "chan1",
      member: { user: { id: "owner" } },
      message: { id: "m1" },
      ...over,
    }) as Interaction;

  return { sent, edited, acked, followups, notes, broker, route, click };
}

const results: Record<string, boolean> = {};

// --- the wire numbers are the bug, so pin them -----------------------------------------------
results["wire_values_message_component_3"] = InteractionType.MessageComponent === 3 && InteractionType.ApplicationCommand === 2;
results["wire_values_deferred_update_6"] = CallbackType.DeferredUpdateMessage === 6 && EPHEMERAL === 64;

// --- a button click settles the blocked tool call --------------------------------------------
{
  const h = harness();
  const pending = h.broker.request({ hasUI: false, ui: {} } as never, "bash", { command: "rm -rf build" }, "force/recursive delete");
  await new Promise((r) => setTimeout(r, 10));
  const ids: string[] = h.sent[0].components[0].components.map((b: any) => b.custom_id);
  const approveId = ids.find((id) => id.startsWith("pi:approve:"))!;

  const outcome = await h.route(h.click(approveId));
  const settled = await pending;

  results["click_resolves_request"] = outcome.code === "decision" && outcome.decision === "allow";
  results["click_source_is_discord"] = settled.decision === "allow" && settled.source === "discord";
  results["click_acked_deferred_update"] = h.acked.length === 1 && h.acked[0].type === CallbackType.DeferredUpdateMessage;
  results["embed_updated_with_outcome"] =
    h.edited.length === 1 && JSON.stringify(h.edited[0].payload.embeds).includes("Allowed once") && JSON.stringify(h.edited[0].payload.components).includes("disabled");
  results["decision_needs_no_followup"] = h.followups.length === 0;

  // The same custom_id clicked twice must not answer a request that no longer exists.
  const again = await h.route(h.click(approveId));
  results["second_click_is_stale"] = again.code === "stale" && h.followups[0]?.payload.content.includes("already answered") === true;
  results["stale_click_still_acked"] = h.acked.length === 2;
}

// --- a slash command is not a click ----------------------------------------------------------
{
  const h = harness();
  const ignored = await h.route(h.click("pi:approve:abcd:zz", { type: InteractionType.ApplicationCommand, data: { name: "discord" } } as never));
  results["application_command_ignored"] = ignored.code === "not-a-click" && h.acked.length === 0 && h.followups.length === 0;
}

// --- clicks that must be refused -------------------------------------------------------------
{
  const h = harness();
  const pending = h.broker.request({ hasUI: false, ui: {} } as never, "write", { path: "/home/dev/.ssh/id_ed25519" }, "sensitive file");
  await new Promise((r) => setTimeout(r, 10));
  const denyId: string = h.sent[0].components[0].components.map((b: any) => b.custom_id).find((id: string) => id.startsWith("pi:deny:"));

  const stranger = await h.route(h.click(denyId, { member: { user: { id: "someone-else" } } } as never));
  results["foreign_user_refused"] = stranger.code === "wrong-user" && stranger.note?.includes("someone-else") === true;
  results["foreign_refuse_is_ephemeral"] = h.followups[0]?.payload.flags === EPHEMERAL;

  const anonymous = await h.route(h.click(denyId, { member: undefined, user: undefined } as never));
  results["anonymous_click_refused"] = anonymous.code === "wrong-user" && h.followups.length === 1;

  const mine = await h.route(h.click(denyId));
  const settled = await pending;
  results["owner_can_still_deny"] = mine.code === "decision" && settled.decision === "deny";
}

// --- DM clicks get no ephemeral flag (invalid there) -----------------------------------------
{
  const h = harness();
  const pending = h.broker.request({ hasUI: false, ui: {} } as never, "bash", { command: "npm publish" }, "publishing to a public registry");
  await new Promise((r) => setTimeout(r, 10));
  const detailId: string = h.sent[0].components[0].components.map((b: any) => b.custom_id).find((id: string) => id.startsWith("pi:detail:"));
  const detail = await h.route(h.click(detailId, { guild_id: undefined, channel: { id: "chan1", type: 1 }, member: undefined, user: { id: "owner" } } as never));
  results["detail_shows_full_input"] = detail.code === "detail" && h.followups[0]?.payload.content.includes("npm publish") === true;
  results["dm_followup_not_ephemeral"] = h.followups[0]?.payload.flags === undefined;
  results["detail_leaves_request_pending"] = h.broker.pendingCount === 1;
  await pending;
}

// --- a refused ack must not cost the decision, and must be reported --------------------------
{
  const h = harness({ ackFails: true });
  const pending = h.broker.request({ hasUI: false, ui: {} } as never, "bash", { command: "sudo reboot" }, "privilege escalation");
  await new Promise((r) => setTimeout(r, 10));
  const alwaysId: string = h.sent[0].components[0].components.map((b: any) => b.custom_id).find((id: string) => id.startsWith("pi:always:"));
  const outcome = await h.route(h.click(alwaysId));
  const settled = await pending;
  results["ack_failure_still_decides"] = outcome.code === "decision" && settled.decision === "always" && h.broker.allowingEverything === true;
  results["ack_failure_reported"] = h.notes.some((n) => n.startsWith("warn") && n.includes("could not acknowledge")) === true;
}

for (const [name, ok] of Object.entries(results)) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
const passed = Object.values(results).every(Boolean);
console.log(passed ? "INTERACTIONS OK" : "INTERACTIONS FAILED");
process.exit(passed ? 0 : 1);
