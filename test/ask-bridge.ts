// Remote-answer door tests, run with no Discord and no pi-ask-user. A fake registry stands in
// for the one the fork publishes on `globalThis`, with the semantics that make or break this
// path: prompts are handed out live and mutated in place, `answer()` says false when it did not
// take, and an answered prompt can go back to being answerable. The REST client is a recorder,
// so every embed sent and every embed rewritten is inspectable.
// Run: node --experimental-strip-types test/ask-bridge.ts
import { AskBridge, type PromptAnswer, type PromptInfo } from "../extensions/discord-comms/ask-bridge.ts";
import { mirrorMessage } from "../extensions/discord-comms/ask-mirror.ts";
import { ApprovalBroker } from "../extensions/discord-comms/approvals.ts";
import { createInteractionRouter } from "../extensions/discord-comms/interactions.ts";
import type { Config } from "../extensions/discord-comms/config.ts";
import { CallbackType, EPHEMERAL, type Interaction } from "../extensions/discord-comms/types.ts";

const BRIDGE_KEY = Symbol.for("pi.prompt-bridge.v1");
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

type Listener = (prompt: PromptInfo, event: "open" | "change" | "close") => void;
type Handle = { id: number; info: PromptInfo; update(patch: Partial<PromptInfo>): void; reopen(): void; close(): void };

/** The publisher's half of the contract, per pi-ask-user's bridge.ts. */
function fakeRegistry() {
  const prompts: PromptInfo[] = [];
  const listeners: Listener[] = [];
  const settles = new Map<number, (value: PromptAnswer) => boolean>();
  const taken: { id: number; value: PromptAnswer }[] = [];
  let nextId = 1;

  const emit = (prompt: PromptInfo, event: "open" | "change" | "close") => {
    for (const listener of [...listeners]) listener(prompt, event);
  };

  const api = {
    version: 1 as const,
    get prompts() {
      return prompts;
    },
    listen(listener: Listener) {
      listeners.push(listener);
      return () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
    answer(id: number, value: PromptAnswer) {
      const prompt = prompts.find((entry) => entry.id === id);
      const settle = settles.get(id);
      if (!prompt || !settle || prompt.answered) return false;
      // Marked before settling, as the real bridge does: once a component is tearing itself
      // down, a second answer must not reach it.
      prompt.answered = true;
      const applied = settle(value);
      if (!applied) prompt.answered = false;
      else taken.push({ id, value });
      return applied;
    },
    find(id: number) {
      return prompts.find((entry) => entry.id === id);
    },
  };

  function open(info: Omit<PromptInfo, "id" | "answered">, settle: (value: PromptAnswer) => boolean = () => true): Handle {
    const id = nextId++;
    const prompt: PromptInfo = { ...info, id, answered: false };
    prompts.push(prompt);
    settles.set(id, settle);
    let opened = true;
    emit(prompt, "open");
    return {
      id,
      info: prompt,
      update(patch) {
        if (!opened) return;
        Object.assign(prompt, patch);
        // What the widget does after anything changes, including an answer at the keyboard.
        emit(prompt, "change");
      },
      reopen() {
        if (!opened || !prompt.answered) return;
        prompt.answered = false;
        emit(prompt, "change");
      },
      close() {
        if (!opened) return;
        opened = false;
        prompts.splice(prompts.indexOf(prompt), 1);
        settles.delete(id);
        emit(prompt, "close");
      },
    };
  }

  return {
    api,
    open,
    taken,
    takenOf: (id: number) => taken.filter((entry) => entry.id === id),
    answerAtTheKeyboard: (id: number, value: PromptAnswer, publish: Handle) => {
      const applied = api.answer(id, value);
      if (applied) publish.update({});
      return applied;
    },
  };
}

function fakeRest() {
  const sent: any[] = [];
  const edited: any[][] = [];
  const acked: number[] = [];
  const followups: any[] = [];
  return {
    sent,
    edited,
    acked,
    followups,
    api: {
      send: async (_channel: string, payload: any) => {
        sent.push(payload);
        return { id: `m${sent.length}` };
      },
      edit: async (_channel: string, id: string, payload: any) => {
        edited.push({ id, payload });
        return { id };
      },
      interactionAck: async (_interaction: Interaction, type: number) => {
        acked.push(type);
      },
      interactionFollowup: async (_interaction: Interaction, payload: any) => {
        followups.push(payload);
        return { id: "f1" };
      },
    } as never,
  };
}

const select = {
  source: "pi-ask-user",
  kind: "select" as const,
  question: "Which rollout should we ship?",
  options: [
    { title: "Canary", description: "One percent for a day." },
    { title: "Direct", description: "Everyone at once." },
  ],
  allowMultiple: false,
  allowFreeform: true,
};

const freeformOf = (question: string) => ({ source: "pi-ask-user", kind: "freeform" as const, question, options: [], allowMultiple: false, allowFreeform: true });

/** Only needed to stand the interaction router up: prompt clicks share that router with approvals. */
const cfg = { approvals: "dangerous", raceTerminal: false, approvalTimeoutMs: 5_000, level: "milestones", deliverAs: "followUp" } as Config;

/** A click as the gateway sends it, with the custom_id read back out of a posted embed. */
const click = (custom_id: string, over: Record<string, unknown> = {}): Interaction =>
  ({
    id: "i1",
    token: "t1",
    application_id: "app1",
    type: 3,
    data: { custom_id, component_type: 2 },
    guild_id: "g1",
    channel_id: "chan1",
    member: { user: { id: "owner" } },
    ...over,
  }) as Interaction;

const buttons = (payload: any): string[] => (payload?.components ?? []).flatMap((row: any) => row.components.map((b: any) => b.custom_id));
const labels = (payload: any): string[] => (payload?.components ?? []).flatMap((row: any) => row.components.map((b: any) => b.label));
const enabled = (payload: any): boolean => (payload?.components ?? []).some((row: any) => row.components.some((b: any) => !b.disabled));
const body = (payload: any): string => JSON.stringify(payload?.embeds ?? payload?.content ?? "");
const last = (edited: any[]) => edited[edited.length - 1]!.payload;

const checks: Record<string, boolean> = {};

// --- no registry: today's read-only mirror, and text still reaches the agent ----------------
{
  delete (globalThis as Record<symbol, unknown>)[BRIDGE_KEY];
  const rest = fakeRest();
  const asks = new AskBridge({ rest: rest.api, tag: "abcd", channel: () => "chan1", log: () => {} });
  const mirror = mirrorMessage("ask_user", { question: "Which rollout?", options: [{ title: "Canary" }, { title: "Direct" }] }, "footer");
  checks["no_bridge_does_not_attach"] = asks.attach() === false && asks.bridged === false;
  const fallback = await asks.inbound("!chat hello");
  checks["no_bridge_routes_no_reply_at_all"] =
    (await asks.inbound("1")) === undefined &&
    (await asks.inbound("Canary")) === undefined &&
    (await asks.inbound("!cancel")) === undefined &&
    (await asks.inbound("!skip")) === undefined &&
    (await asks.inbound("!back 2")) === undefined;
  checks["no_bridge_still_delivers_chat_to_the_agent"] = fallback?.kind === "chat" && fallback.text === "hello";
  checks["the_fallback_is_still_todays_mirror"] = body(mirror).includes("Which rollout?") === true && body(mirror).includes("Canary") === true;
  checks["mirror_offers_no_buttons"] = mirror?.components === undefined && JSON.stringify(mirror).includes("custom_id") === false;
}

// --- a prompt opens as an embed carrying question, options, page, deadline ------------------
{
  const registry = fakeRegistry();
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = registry.api;
  const rest = fakeRest();
  const asks = new AskBridge({ rest: rest.api, tag: "abcd", channel: () => "chan1", log: () => {} });
  asks.attach();

  const prompt = registry.open({ ...select, heading: "How should the release go?", page: { index: 2, total: 3 }, context: "Found two candidates.", deadlineAt: Date.now() + 120_000 });
  await tick();
  const sent = rest.sent[0];
  checks["embed_sent_on_open"] = rest.sent.length === 1 && String(sent.embeds[0].title).includes("How should the release go?") === true;
  checks["page_shown_in_the_title"] = String(sent.embeds[0].title).includes("2/3") === true;
  checks["question_context_and_options_in_the_body"] =
    body(sent).includes("Which rollout") === true && body(sent).includes("Found two candidates") === true && body(sent).includes("1. Canary — One percent for a day.") === true;
  checks["one_button_per_option"] = buttons(sent).length === 2 && buttons(sent).every((id) => id.startsWith("ask:abcd:")) === true;
  checks["deadline_is_shown"] = body(sent).includes("2m left") === true;
  checks["button_ids_avoid_the_approval_prefix"] = buttons(sent).every((id) => !id.startsWith("pi:")) === true;

  const outcome = await asks.handle(click(buttons(sent)[1]!));
  checks["click_answers_the_prompt"] = outcome.kind === "answered" && registry.takenOf(prompt.id)[0]?.value.titles?.[0] === "Direct";
  checks["embed_is_edited_with_the_outcome"] =
    rest.edited.length === 1 && body(last(rest.edited)).includes("Answered from Discord") === true && enabled(last(rest.edited)) === false;
  checks["click_on_an_answered_prompt_is_refused"] = (await asks.handle(click(buttons(sent)[0]!))).kind === "refused";
  checks["an_answer_is_never_offered_twice"] = registry.takenOf(prompt.id).length === 1;

  prompt.close();
  await tick();
  checks["closing_after_our_answer_keeps_the_outcome"] = rest.edited.length === 1;
  checks["a_closed_prompt_is_forgotten"] = asks.openCount === 0;
}

// --- closed at the keyboard, or by a timeout: stop looking clickable ------------------------
{
  const registry = fakeRegistry();
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = registry.api;
  const rest = fakeRest();
  const asks = new AskBridge({ rest: rest.api, tag: "abcd", channel: () => "chan1", log: () => {} });
  asks.attach();
  const prompt = registry.open(select);
  await tick();

  prompt.close();
  await tick();
  checks["closed_elsewhere_is_announced"] =
    rest.edited.length === 1 && body(last(rest.edited)).includes("Closed with no answer") === true && enabled(last(rest.edited)) === false;
}

// --- answered away, then offered again by a `!back` ----------------------------------------
{
  const registry = fakeRegistry();
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = registry.api;
  const rest = fakeRest();
  const asks = new AskBridge({ rest: rest.api, tag: "abcd", channel: () => "chan1", log: () => {} });
  asks.attach();
  const prompt = registry.open(select);
  await tick();
  registry.answerAtTheKeyboard(prompt.id, { titles: ["Direct"] }, prompt);
  await tick();
  checks["answered_elsewhere_shows_without_our_claim"] =
    body(last(rest.edited)).includes("Answered away from Discord") === true &&
    body(last(rest.edited)).includes("Answered from Discord") === false &&
    enabled(last(rest.edited)) === false;

  prompt.reopen();
  await tick();
  checks["a_reopened_prompt_is_clickable_again"] = enabled(last(rest.edited)) === true && body(last(rest.edited)).includes("Canary") === true;
  const again = await asks.handle(click(buttons(rest.sent[0]!)[0]!));
  checks["a_reopened_prompt_answers_again"] = again.kind === "answered" && registry.takenOf(prompt.id)[1]?.value.titles?.[0] === "Canary";
}

// --- freeform: no buttons, and the next message is the answer ------------------------------
{
  const registry = fakeRegistry();
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = registry.api;
  const rest = fakeRest();
  const asks = new AskBridge({ rest: rest.api, tag: "abcd", channel: () => "chan1", log: () => {} });
  asks.attach();
  const prompt = registry.open(freeformOf("How often should the report run?"));
  await tick();
  checks["freeform_has_no_buttons"] = buttons(rest.sent[0]).length === 0;
  checks["freeform_text_is_the_answer"] =
    (await asks.inbound("twice a day")).kind === "answered" && registry.takenOf(prompt.id)[0]?.value.text === "twice a day";

  const optionsOnly = registry.open({ ...select, allowFreeform: false });
  await tick();
  checks["a_stray_number_is_refused_not_answered"] = (await asks.inbound("9")).kind === "refused";
  checks["an_options_question_refuses_an_unlisted_title"] = (await asks.inbound("maybe tomorrow")).kind === "refused";
  checks["a_skip_that_would_have_to_choose_is_refused"] = (await asks.inbound("!skip")).kind === "refused";
  checks["a_refusal_leaves_the_prompt_answerable"] = registry.api.prompts.some((entry) => entry.id === optionsOnly.id && entry.answered === false) === true;
  checks["a_number_selects_that_option"] = (await asks.inbound("2")).kind === "answered" && registry.takenOf(optionsOnly.id)[0]?.value.titles?.[0] === "Direct";

  const skipped = registry.open(freeformOf("Anything else?"));
  await tick();
  checks["skip_is_an_empty_answer"] = (await asks.inbound("!skip")).kind === "answered" && registry.takenOf(skipped.id)[0]?.value.text === "";

  const cancelled = registry.open({ ...select, allowFreeform: false });
  await tick();
  checks["cancel_is_escape_not_a_skip"] = (await asks.inbound("!cancel")).kind === "answered" && registry.takenOf(cancelled.id)[0]?.value.cancel === true;
}

// --- the reply grammar, including addressing a question ------------------------------------
{
  const registry = fakeRegistry();
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = registry.api;
  const rest = fakeRest();
  const asks = new AskBridge({ rest: rest.api, tag: "abcd", channel: () => "chan1", log: () => {} });
  asks.attach();
  const pair = () => ({
    first: registry.open({ ...select, question: "Which channel?", page: { index: 1, total: 2 } }),
    second: registry.open({ ...select, question: "Who is notified?", page: { index: 2, total: 2 } }),
  });

  const both = pair();
  await tick();
  checks["both_questions_are_mirrored"] = rest.sent.length === 2 && asks.openCount === 2 && asks.answerableCount === 2;
  const ambiguous = await asks.inbound("Canary");
  checks["an_unaddressed_answer_is_refused_with_a_hint"] =
    ambiguous.kind === "refused" && ambiguous.note?.includes("`2 Canary`") === true && ambiguous.note?.includes("Which channel?") === true;
  checks["a_refused_answer_settled_nothing"] = registry.taken.length === 0;
  checks["an_unaddressed_number_is_refused_too"] = (await asks.inbound("1")).kind === "refused";
  both.first.close();
  both.second.close();

  for (const [label, text] of [["spaced", "2 Canary"], ["colon", "2: Canary"], ["dot", "2. Canary"], ["q form", "q2 Canary"]] as const) {
    const questions = pair();
    await tick();
    const verdict = await asks.inbound(text);
    checks[`an_addressed_answer_${label}`] = verdict?.kind === "answered" && registry.takenOf(questions.second.id).length === 1;
    checks[`an_addressed_answer_${label}_left_the_other_one`] = questions.first.info.answered === false;
    questions.first.close();
    questions.second.close();
    await tick();
  }
  checks["addressing_every_question_answered_them"] = registry.taken.length === 4 && registry.taken.every((entry) => entry.value.titles?.[0] === "Canary") === true;

  const one = pair();
  await tick();
  registry.answerAtTheKeyboard(one.first.id, { titles: ["Canary"] }, one.first);
  await tick();
  const unknown = await asks.inbound("q5 Canary");
  checks["an_unknown_address_is_refused_with_the_hint"] = unknown.kind === "refused" && unknown.note?.includes("`2 Canary`") === true;
  const bare = await asks.inbound("1");
  checks["a_bare_number_is_an_option_not_an_address"] = bare.kind === "answered" && registry.takenOf(one.second.id)[0]?.value.titles?.[0] === "Canary";
  one.first.close();
  one.second.close();
  await tick();
}

// --- multi-select: taps accumulate, Send submits -------------------------------------------
{
  const registry = fakeRegistry();
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = registry.api;
  const rest = fakeRest();
  const asks = new AskBridge({ rest: rest.api, tag: "abcd", channel: () => "chan1", log: () => {} });
  asks.attach();
  const prompt = registry.open({ ...select, question: "Which surfaces matter?", allowMultiple: true, options: [{ title: "Phone" }, { title: "Desktop" }, { title: "Terminal" }] });
  await tick();
  const ids = buttons(rest.sent[0]);
  checks["multi_select_adds_a_send_button"] = ids.length === 4 && labels(rest.sent[0]).at(-1) === "Send";
  checks["send_with_nothing_picked_is_refused"] = (await asks.handle(click(ids[3]!))).kind === "refused" && registry.taken.length === 0;

  const first = await asks.handle(click(ids[0]!));
  await tick();
  checks["a_tap_toggles_the_option"] = first.kind === "toggled" && body(last(rest.edited)).includes("✅ 1. Phone") === true && enabled(last(rest.edited)) === true;
  checks["tapping_settles_nothing_for_the_asker"] = registry.taken.length === 0;
  const second = await asks.handle(click(ids[2]!));
  await tick();
  checks["a_second_tap_adds"] = second.kind === "toggled" && body(last(rest.edited)).includes("Picked: Phone, Terminal") === true;
  const untap = await asks.handle(click(ids[2]!));
  checks["tapping_again_untaps"] = untap.kind === "toggled" && untap.note === "picked Phone";

  const send = await asks.handle(click(ids[3]!));
  checks["send_submits_what_was_tapped"] =
    send.kind === "answered" &&
    JSON.stringify(registry.takenOf(prompt.id)[0]?.value.titles) === JSON.stringify(["Phone"]) &&
    body(last(rest.edited)).includes("Answered from Discord") === true;
}
{
  const registry = fakeRegistry();
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = registry.api;
  const rest = fakeRest();
  const asks = new AskBridge({ rest: rest.api, tag: "abcd", channel: () => "chan1", log: () => {} });
  asks.attach();
  registry.open({ ...select, question: "Which surfaces matter?", allowMultiple: true, options: [{ title: "Phone" }, { title: "Desktop" }, { title: "Terminal" }] });
  await tick();
  checks["a_comma_reply_submits_several"] =
    (await asks.inbound("1,3")).kind === "answered" && JSON.stringify(registry.taken[0]?.value.titles) === JSON.stringify(["Phone", "Terminal"]);
}
{
  const registry = fakeRegistry();
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = registry.api;
  const rest = fakeRest();
  const asks = new AskBridge({ rest: rest.api, tag: "abcd", channel: () => "chan1", log: () => {} });
  asks.attach();
  const many = registry.open({ ...select, options: Array.from({ length: 26 }, (_, i) => ({ title: `opt ${i + 1}` })) });
  await tick();
  checks["beyond_twenty_five_options_there_are_no_buttons"] = buttons(rest.sent[0]).length === 0 && body(rest.sent[0]).includes("Too many options for buttons") === true;
  checks["a_numbered_reply_still_works_without_buttons"] =
    (await asks.inbound("26")).kind === "answered" && registry.takenOf(many.id)[0]?.value.titles?.[0] === "opt 26";
}

// --- an answer the bridge refuses is reported, never swallowed -----------------------------
{
  const registry = fakeRegistry();
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = registry.api;
  const rest = fakeRest();
  const notes: string[] = [];
  const asks = new AskBridge({ rest: rest.api, tag: "abcd", channel: () => "chan1", log: (m, warn) => notes.push(`${warn ? "warn" : "info"}: ${m}`) });
  asks.attach();
  // The component refuses an answer it cannot apply, exactly as the real one does for a title
  // it has never heard of; the next one still works.
  let refuse = true;
  const prompt = registry.open(select, () => (refuse ? ((refuse = false), false) : true));
  await tick();
  const verdict = await asks.handle(click(buttons(rest.sent[0]!)[0]!));
  checks["a_refused_answer_is_reported_to_the_clicker"] = verdict.kind === "refused" && verdict.note?.includes("Nothing was answered") === true;
  checks["a_refused_answer_leaves_the_question_live"] = prompt.info.answered === false && asks.answerableCount === 1;
  checks["a_refused_answer_writes_no_outcome"] = rest.edited.length === 0;
  checks["a_refused_answer_is_logged_as_a_problem"] = notes.some((n) => n.startsWith("warn") && n.includes("Nothing was answered")) === true;

  registry.answerAtTheKeyboard(prompt.id, { titles: ["Canary"] }, prompt);
  await tick();
  checks["the_keyboard_winning_shows_on_the_embed"] = body(last(rest.edited)).includes("Answered away from Discord") === true;
  checks["a_lost_answer_is_not_claimed"] = registry.takenOf(prompt.id).length === 1 && registry.takenOf(prompt.id)[0]?.value.titles?.[0] === "Canary";
  // Commands and text both fall through once nothing can be answered here: with a bridge but
  // nothing answerable, the channel behaves exactly as it did before any of this existed.
  checks["nothing_answerable_routes_nothing"] =
    (await asks.inbound("!cancel")) === undefined && (await asks.inbound("and then?")) === undefined;
  checks["chat_still_reaches_the_agent_when_nothing_is_answerable"] = (await asks.inbound("!chat and then?")).kind === "chat";
}

// --- commands that are not ours stay the channel's -----------------------------------------
{
  const registry = fakeRegistry();
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = registry.api;
  const rest = fakeRest();
  const asks = new AskBridge({ rest: rest.api, tag: "abcd", channel: () => "chan1", log: () => {} });
  asks.attach();
  const prompt = registry.open(select);
  await tick();
  checks["stop_and_status_are_not_answers"] = (await asks.inbound("!stop")) === undefined && (await asks.inbound("!status")) === undefined;
  checks["another_extensions_command_is_not_an_answer"] = (await asks.inbound("!deploy to production")) === undefined;
  checks["none_of_those_answered_anything"] = registry.taken.length === 0 && prompt.info.answered === false;

  const chat = await asks.inbound("!chat ship it now");
  checks["chat_reaches_the_agent_instead"] = chat?.kind === "chat" && chat.text === "ship it now" && prompt.info.answered === false;
  checks["chat_needs_text_to_send"] = (await asks.inbound("!chat")).kind === "refused";
  checks["an_approval_button_is_not_ours"] = (await asks.handle(click("pi:approve:abcd:ff00aa"))).kind === "unknown";
  checks["another_sessions_prompt_button_is_not_ours"] = (await asks.handle(click("ask:eeff:1:0"))).kind === "unknown";
  prompt.close();
  await tick();
  checks["a_click_on_a_closed_prompt_is_not_ours"] = (await asks.handle(click(buttons(rest.sent[0]!)[0]!))).kind === "unknown";
}

// --- the review step: Send, and a Back button per question ---------------------------------
{
  const registry = fakeRegistry();
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = registry.api;
  const rest = fakeRest();
  const asks = new AskBridge({ rest: rest.api, tag: "abcd", channel: () => "chan1", log: () => {} });
  asks.attach();
  // The questions stay published behind the review, which is where a Back button's number comes
  // from: the review itself publishes no count.
  const questions = [
    registry.open({ ...select, question: "Which channel?", heading: "How should the release go?", page: { index: 1, total: 2 } }),
    registry.open({ ...select, question: "Who is notified?", heading: "How should the release go?", page: { index: 2, total: 2 } }),
  ];
  for (const question of questions) registry.answerAtTheKeyboard(question.id, { titles: ["Canary"] }, question);
  const summary = "1. Which channel?\n   Canary\n2. Who is notified?\n   Nobody";
  const review = registry.open(
    { source: "pi-ask-user", kind: "review", question: "How should the release go?", context: summary, options: [], allowMultiple: false, allowFreeform: false },
    (value) => !(value.back !== undefined && value.back > 2),
  );
  await tick();
  checks["a_review_lists_every_question_with_its_answer"] =
    body(rest.sent[2]).includes("1. Which channel?") === true && body(rest.sent[2]).includes("Nobody") === true;
  checks["a_review_offers_send_and_one_back_per_question"] =
    labels(rest.sent[2]).join(",") === "Send,Back 1,Back 2" && buttons(rest.sent[2])[2]?.endsWith(":back:2") === true;

  checks["text_at_a_review_is_refused"] = (await asks.inbound("looks good")).kind === "refused";
  checks["going_back_to_no_such_question_is_refused"] = (await asks.inbound("!back 9")).kind === "refused" && review.info.answered === false;
  checks["the_text_form_goes_back"] = (await asks.inbound("!back 1")).kind === "answered" && registry.takenOf(review.id)[0]?.value.back === 1;
  review.info.answered = false;
  review.update({});
  await tick();
  const tapped = await asks.handle(click(buttons(rest.sent[2])[2]!));
  checks["a_back_button_needs_no_typed_argument"] =
    tapped.kind === "answered" && JSON.stringify(registry.takenOf(review.id).map((entry) => entry.value.back)) === JSON.stringify([1, 2]);
  checks["a_second_send_is_refused"] = (await asks.handle(click(buttons(rest.sent[2])[0]!))).kind === "refused";
  checks["the_review_embed_keeps_the_outcome"] = body(last(rest.edited)).includes("Answered from Discord") === true;

  // A review longer than Discord's own ceiling gives up the how-to-reply lines before it gives
  // up any of the answer list, and says so when even that will not fit.
  const roomy = registry.open({
    source: "pi-ask-user",
    kind: "review",
    question: "How should the release go?",
    context: `1. Which channel?\n   ${"a".repeat(1200)}\n2. Who is notified?\n   ${"b".repeat(1200)}`,
    options: [],
    allowMultiple: false,
    allowFreeform: false,
  });
  await tick();
  const room = rest.sent[3];
  checks["a_long_review_keeps_every_answer"] = body(room).includes("a".repeat(1200)) === true && body(room).includes("b".repeat(1200)) === true;
  checks["a_review_that_fits_keeps_its_hints"] = body(room).includes("`Send` submits everything") === true;
  checks["a_review_that_fits_says_nothing_about_a_cut"] = String(room.embeds[0].footer.text).includes("cut short") === false;
  checks["a_fitting_review_names_the_back_buttons_it_shows"] =
    body(room).includes("`Back 1` to `Back 2` re-answers that question") === true;

  const tooBig = registry.open({
    source: "pi-ask-user",
    kind: "review",
    question: "How should the release go?",
    context: `1. Which channel?\n   ${"a".repeat(2200)}\n2. Who is notified?\n   ${"b".repeat(2200)}`,
    options: [],
    allowMultiple: false,
    allowFreeform: false,
  });
  await tick();
  const cut = rest.sent[4];
  checks["a_review_cut_by_discord_says_so"] =
    String(cut.embeds[0].footer.text).includes("cut short by Discord") === true && body(cut).includes("1. Which channel?") === true;
  checks["a_review_gives_up_its_hints_before_its_answers"] = body(cut).includes("`Send` submits everything") === false;
  void roomy;
  void tooBig;
}

// --- through the interaction router: prompt clicks share the channel with approval clicks ---
{
  const registry = fakeRegistry();
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = registry.api;
  const rest = fakeRest();
  const asks = new AskBridge({ rest: rest.api, tag: "abcd", channel: () => "chan1", log: () => {} });
  asks.attach();
  const broker = new ApprovalBroker(rest.api, cfg, "abcd", () => "chan1", () => {});
  const route = createInteractionRouter({ rest: rest.api, broker, prompts: asks, userId: "owner", log: () => {} });

  const prompt = registry.open(select);
  await tick();
  const optionId = buttons(rest.sent[0]!)[0]!;

  const stranger = await route(click(optionId, { member: { user: { id: "someone-else" } } }));
  checks["a_strangers_prompt_click_answers_nothing"] = stranger.code === "wrong-user" && prompt.info.answered === false && rest.followups[0]?.flags === EPHEMERAL;

  const answered = await route(click(optionId));
  checks["a_prompt_click_is_acked_then_answers"] =
    answered.code === "answered" && rest.acked[1] === CallbackType.DeferredUpdateMessage && registry.takenOf(prompt.id).length === 1;
  checks["an_answer_needs_no_followup_message"] = rest.followups.length === 1;

  const stale = await route(click(optionId));
  checks["a_second_click_on_the_same_button_is_refused_out_loud"] = stale.code === "refused" && rest.followups[1]?.content.includes("already answered") === true;

  const approval = await route(click("pi:approve:abcd:ff00aa"));
  checks["an_approval_click_is_still_not_a_prompt_click"] = approval.code === "stale" && approval.note?.includes("pi:approve") === true;
}

// --- per-run replies: prompts sharing a heading are one ask, and numbers count inside it ----
{
  const registry = fakeRegistry();
  (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = registry.api;
  const rest = fakeRest();
  const asks = new AskBridge({ rest: rest.api, tag: "abcd", channel: () => "chan1", log: () => {} });
  asks.attach();
  const run = (heading: string, total: number) => ({
    first: registry.open({ ...select, question: "Which channel?", heading, page: { index: 1, total } }),
    second: registry.open({ ...select, question: "Who is notified?", heading, page: { index: 2, total } }),
  });

  const one = run("Release A", 2);
  await tick();
  const hint = await asks.inbound("Canary");
  checks["an_unaddressed_answer_names_the_run_it_could_not_choose"] =
    hint.kind === "refused" && hint.note?.includes("Release A") === true && hint.note?.includes("1 Which channel?") === true;
  checks["a_numbered_reply_answers_that_runs_question"] = (await asks.inbound("2 Direct")).kind === "answered" && registry.takenOf(one.second.id).length === 1;
  checks["which_leaves_one_question_of_the_run_open"] = one.second.info.answered === true && one.first.info.answered === false;

  // And the question still open can be answered without naming it: an answered prompt of the
  // same run does not force addressing.
  checks["one_left_answerable_of_the_run_needs_no_address"] = (await asks.inbound("Canary")).kind === "answered" && registry.takenOf(one.first.id).length === 1;
  one.first.close();
  one.second.close();
  await tick();

  const a = run("Release A", 2);
  const b = run("Release B", 2);
  await tick();
  const both = await asks.inbound("2 Canary");
  checks["a_number_two_runs_both_have_is_refused"] =
    both.kind === "refused" &&
    both.note?.includes("question 2") === true &&
    registry.takenOf(a.first.id).length === 0 &&
    registry.takenOf(a.second.id).length === 0 &&
    registry.takenOf(b.first.id).length === 0 &&
    registry.takenOf(b.second.id).length === 0;

  // Once only one of the two asks still has a question to answer, that question is the target:
  // an answered prompt belonging to a different run must not hold the reply up.
  registry.answerAtTheKeyboard(b.first.id, { titles: ["Canary"] }, b.first);
  registry.answerAtTheKeyboard(b.second.id, { titles: ["Canary"] }, b.second);
  await tick();
  checks["an_unaddressed_answer_stays_refused_within_the_remaining_run"] =
    (await asks.inbound("Canary")).kind === "refused";
  const single = await asks.inbound("2 Canary");
  checks["addressing_a_number_only_one_run_still_owes_answers_it"] =
    single.kind === "answered" && registry.taken.some((entry) => entry.id === a.second.id) === true;

  // A review offers to go back to the questions of its own run, not to every numbered question
  // in the process.
  const other = registry.open({ ...select, question: "How long is the window?", heading: "Release B", page: { index: 3, total: 3 } });
  const review = registry.open({ source: "pi-ask-user", kind: "review", question: "Release A", context: "1. Which channel?\n   Canary", options: [], allowMultiple: false, allowFreeform: false });
  await tick();
  checks["a_review_offers_to_go_back_inside_its_own_run_only"] = labels(rest.sent.at(-1)).join(",") === "Send,Back 1,Back 2";
  void other;
  void a;
  void b;
  void one;
}

for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
const passed = Object.values(checks).every(Boolean);
console.log(passed ? "ASK BRIDGE OK" : "ASK BRIDGE FAILED");
process.exit(passed ? 0 : 1);
