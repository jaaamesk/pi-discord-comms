import type { DiscordRest } from "./rest.ts";
import {
  ButtonStyle,
  COLORS,
  EMBED_DESCRIPTION_LIMIT,
  buildEmbed,
  clip,
  disabledRows,
  type ActionRow,
  type Button,
  type Embed,
  type Interaction,
  type MessagePayload,
} from "./types.ts";

// The answering half of the `ask_user` door. pi-ask-user renders a question as a
// `ctx.ui.custom()` component holding keyboard focus, and only that component can resolve the
// promise; the forked copy publishes every prompt it shows on a registry in `globalThis`,
// along with the settle path its own Enter key runs. This module renders those prompts as
// embeds and turns a click or a reply into that same call, so the terminal and Discord are two
// surfaces on one question and whoever gets there first wins.
//
// It never ends a prompt the asker has not ended: no answering on a timer, no cancelling
// because the gateway dropped, no guessing which question an ambiguous reply was meant for.
//
// The registry is reached by symbol and its shape restated below, so neither extension imports
// the other and this package keeps its zero-dependency promise. With the published (unforked)
// pi-ask-user nothing is published, `attach()` returns false, and the read-only copy in
// ask-mirror.ts stays the whole story.

const BRIDGE_KEY = "pi.prompt-bridge.v1";
/** Prompt buttons carry this rather than the approvals' `pi:` prefix, so both brokers share one channel. */
const BUTTON_PREFIX = "ask";

export type PromptKind = "select" | "freeform" | "review";

/** What a listener may hand back. Which fields mean anything depends on `kind`. */
export type PromptAnswer = { titles?: string[]; text?: string; submit?: boolean; back?: number; cancel?: boolean };

export type PromptOption = { title: string; description?: string };

/** What the asking side publishes. Plain data, so that a prompt could in principle cross a process. */
export type PromptInfo = {
  id: number;
  source: string;
  kind: PromptKind;
  question: string;
  context?: string;
  heading?: string;
  /** 1-based, and the number a reply uses to address this question. Only set for one question of a multi-question call. */
  page?: { index: number; total: number };
  options: PromptOption[];
  allowMultiple: boolean;
  allowFreeform: boolean;
  /** Epoch ms, from the caller's `timeout`. Honoured by the asker, shown here. */
  deadlineAt?: number;
  /** True between an accepted answer and the prompt closing. A prompt can go back to false. */
  answered: boolean;
};

type PromptEvent = "open" | "change" | "close";

/** The parts of the contract this side calls. `find` is unused: prompts are tracked by id here. */
type PromptBridge = {
  version: number;
  readonly prompts: PromptInfo[];
  listen(listener: (prompt: PromptInfo, event: PromptEvent) => void): () => void;
  answer(id: number, value: PromptAnswer): boolean;
};

/** The asking extension may have loaded after this one, or never, so this is never cached at startup. */
export function promptBridge(): PromptBridge | undefined {
  const held = (globalThis as unknown as Record<symbol, Partial<PromptBridge> | undefined>)[Symbol.for(BRIDGE_KEY)];
  if (!held || held.version !== 1) return undefined;
  if (typeof held.listen !== "function" || typeof held.answer !== "function" || !Array.isArray(held.prompts)) return undefined;
  return held as PromptBridge;
}

/** One shape for everything a click or a reply can end up as, so the callers stay boring. */
export type Verdict =
  | { kind: "answered"; note: string }
  | { kind: "toggled"; note: string }
  | { kind: "refused"; note: string }
  | { kind: "chat"; text: string }
  | { kind: "unknown" };

/** Only text can be redirected to the agent, so a click never comes back as `chat`. */
export type ClickVerdict = Exclude<Verdict, { kind: "chat" }>;

/** Replies that only make sense about a prompt. `!stop` and `!status` stay the channel's own. */
const ASK_COMMANDS = new Set(["!chat", "!cancel", "!skip", "!back"]);

const ALREADY = "That question is already answered, so nothing changed. Check the terminal, or go back to it from the review step.";
const NOT_TAKEN = "Nothing was answered: the question had already been answered on the other surface, or it cannot take that answer.";

type Tracked = {
  /** The Discord message carrying this prompt's embed, once it has been sent. */
  message?: string;
  rows: ActionRow[];
  snapshot: PromptInfo;
  /** Multi-select taps not yet submitted. Discord has no modifier keys, so this state lives here. */
  pending: string[];
  /** The answer we sent, claimed before it is offered: the embed that closes out has to say who answered. */
  ours?: boolean;
  label?: string;
  /** Set once the embed shows an outcome, so a later event cannot replace it with something vaguer. */
  outcome?: Embed;
  /** Writes to this prompt's message run one at a time, in event order. */
  writing?: Promise<void>;
};

/**
 * Prompts published by any extension that adopted the contract, rendered as embeds and
 * answerable by button or reply. Nothing here owns a prompt: it renders what it is told and
 * reports what happened, including when the answer went to the other surface first.
 */
export class AskBridge {
  private readonly rest: DiscordRest;
  private readonly tag: string;
  private readonly channel: () => string | undefined;
  private readonly log: (message: string, warning?: boolean) => void;
  private readonly footer: () => string;
  private readonly tracked = new Map<number, Tracked>();
  private bridge: PromptBridge | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(deps: {
    rest: DiscordRest;
    tag: string;
    channel: () => string | undefined;
    log: (message: string, warning?: boolean) => void;
    footer?: () => string;
  }) {
    this.rest = deps.rest;
    this.tag = deps.tag;
    this.channel = deps.channel;
    this.log = deps.log;
    this.footer = deps.footer ?? (() => deps.tag);
  }

  /**
   * Start listening if an asking extension is publishing. Cheap, and re-checked on every ask,
   * because extensions reload independently: pi-ask-user can be installed, reloaded, or
   * removed without this one restarting.
   */
  attach(): boolean {
    const bridge = promptBridge();
    if (!bridge) return false;
    if (this.bridge === bridge && this.unsubscribe) return true;
    this.unsubscribe?.();
    this.bridge = bridge;
    this.unsubscribe = bridge.listen(this.onEvent);
    // A prompt already on screen when we got here still needs an embed of its own.
    for (const prompt of bridge.prompts) this.onEvent(prompt, "open");
    return true;
  }

  /** Stop listening. Posted embeds keep their last state: the gateway is going away with us. */
  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.bridge = undefined;
    this.tracked.clear();
  }

  get bridged(): boolean {
    return this.unsubscribe !== undefined;
  }

  get openCount(): number {
    return this.bridge?.prompts.length ?? 0;
  }

  get answerableCount(): number {
    return this.open.filter((prompt) => !prompt.answered).length;
  }

  private get open(): PromptInfo[] {
    return this.bridge?.prompts ?? [];
  }

  private onEvent = (prompt: PromptInfo, event: PromptEvent): void => {
    // The asker emits from inside its own handlers, so an exception thrown here would surface
    // in the component that is asking. Every failure becomes a log line instead.
    void this.track(prompt, event).catch((err: Error) => this.log(`could not update a prompt embed — ${err.message}`, true));
  };

  private async track(prompt: PromptInfo, event: PromptEvent): Promise<void> {
    // The bridge hands out the live object and mutates it in place, so what gets rendered has
    // to be a copy: otherwise a later change silently rewrites what we think we displayed.
    const data = snapshot(prompt);
    let entry = this.tracked.get(prompt.id);
    if (!entry) {
      // Closed before we had an embed for it (or we were not listening yet): nothing to rewrite.
      if (event === "close") return;
      entry = { rows: [], pending: [], snapshot: data };
      this.tracked.set(prompt.id, entry);
    }
    if (event === "close") {
      this.tracked.delete(prompt.id);
      if (!entry.outcome) await this.writeOutcome(entry);
      return;
    }
    entry.snapshot = data;
    if (data.answered) {
      if (!entry.outcome) await this.writeOutcome(entry);
      return;
    }
    // Answered, then offered again: a batch the user went back to. The embed has to become
    // clickable once more, or a live question reads as spent.
    entry.outcome = undefined;
    entry.pending = [];
    await this.render(entry);
  }

  /** Route a button click on one of our prompt buttons. `unknown` means it is not ours. */
  async handle(interaction: Interaction): Promise<ClickVerdict> {
    const [app, tag, rawId, ...rest] = (interaction.data?.custom_id ?? "").split(":");
    if (app !== BUTTON_PREFIX || tag !== this.tag) return { kind: "unknown" };
    const entry = this.tracked.get(Number(rawId));
    // Gone from the map means closed, and the router's stale text is the right answer for that.
    if (!entry) return { kind: "unknown" };
    if (entry.outcome || entry.snapshot.answered) return { kind: "refused", note: ALREADY };

    const prompt = entry.snapshot;
    const choice = rest.join(":");
    if (choice === "send") return this.send(entry);
    if (choice.startsWith("back:")) {
      const number = Number(choice.slice("back:".length));
      if (!Number.isInteger(number) || number < 1) return { kind: "unknown" };
      return this.submit(prompt.id, { back: number }, `back to question ${number}`);
    }
    const index = Number(choice);
    const option = Number.isInteger(index) && index >= 0 ? prompt.options[index] : undefined;
    if (!option) return { kind: "refused", note: "Its options changed since this embed was posted. Read it again, then reply with a number." };
    if (!prompt.allowMultiple) return this.submit(prompt.id, { titles: [option.title] }, `“${option.title}”`);

    entry.pending = entry.pending.includes(option.title)
      ? entry.pending.filter((title) => title !== option.title)
      : [...entry.pending, option.title];
    await this.render(entry);
    const note = entry.pending.length ? `picked ${entry.pending.join(", ")}` : "nothing picked yet";
    this.log(`ask_user selection: ${note}`);
    return { kind: "toggled", note };
  }

  /** The Send button: submit the review step, or the options tapped so far. */
  private async send(entry: Tracked): Promise<ClickVerdict> {
    const prompt = entry.snapshot;
    if (prompt.kind === "review") return this.submit(prompt.id, { submit: true }, "the review, as it stands");
    if (!entry.pending.length) return { kind: "refused", note: "Tap at least one option first, then Send. Or reply with the numbers, like `1,3`." };
    const titles = entry.pending;
    return this.submit(prompt.id, { titles }, titles.map((title) => `“${title}”`).join(" + "));
  }

  /**
   * Channel text, considered before it becomes a chat message. Undefined means this is nothing
   * to answer and the agent should receive it. The grammar is written up in PLAN.md §11.
   */
  async inbound(text: string): Promise<Verdict | undefined> {
    const command = text.match(/^\s*(\S+)/)?.[1]?.toLowerCase() ?? "";
    const argument = text.trim().slice(command.length).trim();
    const asked = ASK_COMMANDS.has(command);
    // The way out of the answer path, so it is answered before any of it: `!chat <text>` is never
    // an answer, and it goes to the agent as text instead of running the grammar a second time.
    if (command === "!chat") {
      return argument ? { kind: "chat", text: argument } : { kind: "refused", note: "!chat <text> sends to the agent instead of answering." };
    }
    if (!this.attach()) return undefined;
    // Nothing to settle, so nothing of ours. That includes a prompt that is answered but still
    // open: it is unanswerable here, and must not swallow a reply either.
    if (!this.answerableCount) return undefined;
    if (command.startsWith("!") && !asked) return undefined;

    let back: number | undefined;
    let address = text;
    if (command === "!back") {
      const found = argument.match(/^(\d+)\b\s*([\s\S]*)$/);
      if (!found) return { kind: "refused", note: "!back <n> re-answers question n. For example: !back 2" };
      back = Number(found[1]);
      address = found[2] ?? "";
    }
    const target = this.target(address);
    if (!target.prompt) return { kind: "refused", note: target.note ?? "That answer could not be routed to a question." };
    const prompt = target.prompt;

    if (back !== undefined) {
      if (prompt.kind !== "review") return { kind: "refused", note: "Only the review step can go back to a question. Send submits it." };
      return this.submit(prompt.id, { back }, `back to question ${back}`);
    }
    if (command === "!cancel") return this.submit(prompt.id, { cancel: true }, "cancelled, the same as Escape at the keyboard");
    if (command === "!skip") return this.skip(prompt);
    return this.answerWith(prompt, target.body ?? "");
  }

  /**
   * Which question a reply belongs to, and what is left of it once an address is stripped.
   * Prompts of one ask call are one run, and a reply is aimed at a run: with a single run
   * waiting, an unaddressed answer may be taken at face value; with several of its questions
   * open, the number it shows is what addresses one.
   */
  private target(text: string): { prompt?: PromptInfo; body?: string; note?: string } {
    const open = this.open;
    const answerable = open.filter((prompt) => !prompt.answered);
    if (!answerable.length) return { note: "Those questions are already answered, so nothing changed. Check the terminal." };
    const numbers = open.map((prompt) => prompt.page?.index).filter((n): n is number => n !== undefined);
    const address = splitAddress(text, numbers);
    if (address.number !== undefined) {
      // Numbers count within a run, so the same number in two asks in flight is two questions.
      const found = answerable.filter((prompt) => prompt.page?.index === address.number);
      if (found.length > 1) {
        return { note: `Two asks in flight both have a question ${address.number}, so that address fits both. Answer at the keyboard, or use !chat <text> to talk to the agent instead.` };
      }
      if (!found.length) {
        return open.some((prompt) => prompt.page?.index === address.number)
          ? { note: `Question ${address.number} is already answered, so nothing changed. Go back to it from the review step to change it.` }
          : { note: addressHint(open) };
      }
      return { prompt: found[0], body: address.body.trim() };
    }
    // One run waiting with one question in it: nothing to guess, so take the answer. Two runs,
    // or one run with several of its questions still open, and the reply would say which one
    // only by accident.
    if (answerable.length === 1) return { prompt: answerable[0], body: text.trim() };
    return { note: addressHint(open) };
  }

  private async skip(prompt: PromptInfo): Promise<ClickVerdict> {
    if (prompt.kind === "review") return { kind: "refused", note: "The review step cannot be skipped: Send submits it, and !back <n> re-answers a question." };
    if (!freeform(prompt) && !prompt.allowFreeform) {
      return { kind: "refused", note: `This question only takes one of its options${prompt.allowMultiple ? " (tap, then Send)" : ""}, so it cannot be skipped. !cancel is the way out.` };
    }
    // An empty text answer is what the widget itself records when Enter is pressed on an empty
    // editor, which is how its own user skips a question.
    return this.submit(prompt.id, { text: "" }, "skipped, with an empty answer");
  }

  /** A text reply that reached a particular question: work out which answer it is. */
  private async answerWith(prompt: PromptInfo, body: string): Promise<ClickVerdict> {
    if (prompt.kind === "review") return { kind: "refused", note: "The review step takes Send, !back <n>, or !cancel. Text typed at it is not an answer." };
    if (!body) return { kind: "refused", note: freeform(prompt) ? "Type your answer, or !skip to skip it." : "Reply with the number of an option, or !cancel." };
    if (freeform(prompt)) return this.submit(prompt.id, { text: body }, `“${clip(body, 120)}”`);

    const parts = body.split(",").map((part) => part.trim()).filter(Boolean);
    const picked = parts.map((part) => choose(prompt.options, part));
    if (picked.every((title): title is string => title !== undefined)) {
      if (picked.length === 1) return this.submit(prompt.id, { titles: [picked[0]] }, `“${picked[0]}”`);
      if (!prompt.allowMultiple) return { kind: "refused", note: "This question takes one answer, not several. Reply with a single number or title." };
      return this.submit(prompt.id, { titles: [...new Set(picked)] }, picked.map((title) => `“${title}”`).join(" + "));
    }
    // A number nobody offered is a misread rather than a freeform answer, even where freeform is
    // allowed. Silently answering "9" would be worse than asking again.
    if (/^\d+$/.test(body)) return { kind: "refused", note: `There is no option ${body} here. Reply with a number from 1 to ${prompt.options.length}.` };
    if (prompt.allowFreeform) return this.submit(prompt.id, { text: body }, `“${clip(body, 120)}”`);
    const choices = prompt.options.map((option, i) => `${i + 1} ${option.title}`).join(" · ");
    return { kind: "refused", note: `Reply with a number (1-${prompt.options.length}) or one of these titles: ${clip(choices, 400)}. To talk to the agent instead, use !chat <text>.` };
  }

  /**
   * Offer an answer to the asker and rewrite the embed with what it says happened. Only a true
   * from `answer()` is ever reported as answered.
   */
  private async submit(id: number, value: PromptAnswer, label: string): Promise<ClickVerdict> {
    const entry = this.tracked.get(id);
    const bridge = this.bridge;
    if (!bridge || !entry) return { kind: "refused", note: "That question is no longer here, so nothing was answered." };
    if (entry.outcome || entry.snapshot.answered) return { kind: "refused", note: ALREADY };

    // Claimed before it is offered: settling runs the asker's own teardown, which can reach
    // `close` synchronously, and the embed it leaves behind has to say who answered.
    entry.ours = true;
    entry.label = label;
    let taken = false;
    try {
      taken = bridge.answer(id, value);
    } catch (err) {
      entry.ours = false;
      entry.label = undefined;
      return this.refused(`the prompt bridge threw — ${(err as Error).message}`);
    }
    if (!taken) {
      entry.ours = false;
      entry.label = undefined;
      return this.refused(NOT_TAKEN);
    }
    // A close that happened during `answer` already wrote the outcome, using this label.
    if (!entry.outcome) await this.writeOutcome(entry);
    this.log(`answered a prompt from Discord: ${label}`);
    return { kind: "answered", note: label };
  }

  private refused(why: string): ClickVerdict {
    this.log(why, true);
    return { kind: "refused", note: why };
  }

  private async render(entry: Tracked): Promise<void> {
    entry.rows = optionRows(this.tag, entry.snapshot, entry.pending, this.open);
    // `[]` rather than omitting the key: a prompt that switches to its editor (options gone)
    // must have the buttons it no longer has removed, not left holding them.
    await this.write(entry, { embeds: [promptEmbed(entry.snapshot, entry.pending, this.footer(), this.open)], components: entry.rows.length ? entry.rows : [] });
  }

  private async writeOutcome(entry: Tracked): Promise<void> {
    entry.outcome = outcomeEmbed(entry, this.footer());
    await this.write(entry, { embeds: [entry.outcome], components: disabledRows(entry.rows) });
  }

  private async write(entry: Tracked, payload: MessagePayload): Promise<void> {
    const channel = this.channel();
    if (!channel) return;
    // One write in flight per prompt, in the order the events arrived: the asker can emit a
    // change or a close before an open has finished sending, and that must not post a second
    // embed for one question or let an older render land after a newer one.
    const queued = (entry.writing ?? Promise.resolve()).then(async () => {
      try {
        if (entry.message) await this.rest.edit(channel, entry.message, payload);
        else entry.message = (await this.rest.send(channel, payload)).id;
      } catch (err) {
        // A prompt we cannot render is still a question in the terminal: worth saying, but not
        // worth failing the ask over, and the next event for it retries the send.
        this.log(`could not post a prompt embed — ${(err as Error).message}`, true);
      }
    });
    entry.writing = queued;
    await queued;
  }
}

/** The bridge hands out the live object and mutates it in place, so a rendered prompt is our copy. */
const snapshot = (prompt: PromptInfo): PromptInfo => ({
  ...prompt,
  options: prompt.options.map((option) => ({ ...option })),
  ...(prompt.page ? { page: { ...prompt.page } } : {}),
});

/** A select whose widget moved to its editor publishes no options: the next message is the answer. */
const freeform = (prompt: PromptInfo): boolean => prompt.kind === "freeform" || (prompt.kind === "select" && prompt.options.length === 0);

/** An option number (1-based) or an exact, case-insensitive title. */
const choose = (options: PromptOption[], part: string): string | undefined => {
  if (/^\d+$/.test(part)) return options[Number(part) - 1]?.title;
  return options.find((option) => option.title.toLowerCase() === part.toLowerCase())?.title;
};

/**
 * `q2 <answer>`, `2 <answer>`, `2: <answer>`, `2. <answer>`. A bare number is never an address:
 * on its own it is an option choice. The `q` form is honoured even when no such question is
 * open, so a typo gets the addressing hint instead of answering something else.
 */
function splitAddress(text: string, numbers: number[]): { number?: number; body: string } {
  const explicit = text.match(/^\s*q\s*(\d+)\b[.:]?\s*([\s\S]*)$/i);
  if (explicit) return { number: Number(explicit[1]), body: explicit[2] ?? "" };
  const punctuated = text.match(/^\s*(\d+)\s*[:.]\s*([\s\S]*)$/);
  if (punctuated && numbers.includes(Number(punctuated[1]))) return { number: Number(punctuated[1]), body: punctuated[2] ?? "" };
  const spaced = text.match(/^\s*(\d+)\s+([^ ].*)$/);
  if (spaced && numbers.includes(Number(spaced[1]))) return { number: Number(spaced[1]), body: spaced[2] ?? "" };
  return { body: text };
}

/**
 * One ask call's prompts are one run, and a reply is aimed at a run: question numbers count
 * inside a run, never across the process. The heading is the key when there is one; a batch
 * asked without a heading is still countable from each question's "N of total", and a prompt
 * with neither is a run of one, with no number to address it by.
 */
const runOf = (prompt: PromptInfo): string => prompt.heading ?? (prompt.page ? `of ${prompt.page.total}` : prompt.question);

const runs = (prompts: PromptInfo[]): PromptInfo[][] => {
  const byRun = new Map<string, PromptInfo[]>();
  for (const prompt of prompts) byRun.set(runOf(prompt), [...(byRun.get(runOf(prompt)) ?? []), prompt]);
  return [...byRun.values()];
};

/**
 * More than one question is waiting: name them, grouped by the ask they belong to, because a `2`
 * means question 2 of *one* ask and a different question 2 of another. Two runs waiting cannot be
 * told apart by any number the contract publishes, so that case says so instead of hinting.
 */
const addressHint = (open: PromptInfo[]): string => {
  const listed = runs(open)
    .map((run) => {
      const heading = run.find((prompt) => prompt.heading)?.heading;
      const questions = run.map((prompt) => `${prompt.page?.index ?? "·"} ${clip(prompt.question.replace(/\s+/g, " "), 60)}${prompt.answered ? " (answered)" : ""}`).join(" · ");
      return `· ${heading ? `${clip(heading.replace(/\s+/g, " "), 50)}: ` : ""}${questions}`;
    })
    .join("\n");
  const how = runs(open.filter((prompt) => !prompt.answered)).length > 1
    ? "They come from different ask calls, so no number tells me which one you mean: answer that one at the keyboard, or use !chat <text> for the agent."
    : "Put the question's number in front of your answer, for example `2 Canary`.";
  return `More than one question is waiting, and an unaddressed answer would be a guess. ${how}\n${listed}`;
};

const remaining = (at: number): string => {
  const ms = at - Date.now();
  if (ms <= 0) return "closing now";
  const minutes = Math.round(ms / 60_000);
  return minutes >= 1 ? `${minutes}m left` : `${Math.max(1, Math.round(ms / 1000))}s left`;
};

const optionLines = (options: PromptOption[], pending: string[]): string =>
  options
    .map((option, i) => `${pending.includes(option.title) ? "✅ " : ""}${i + 1}. ${clip(option.title, 200)}${option.description ? ` — ${clip(option.description, 300)}` : ""}`)
    .join("\n");

/** How to answer, printed in the embed: the grammar is only usable if a phone can find it. */
const hints = (prompt: PromptInfo, pending: string[], open: PromptInfo[]): string[] => {
  const numbers = questionNumbers(prompt, open);
  const back = numbers.length === 1 ? `\`Back ${numbers[0]}\`` : numbers.length ? `\`Back ${numbers[0]}\` to \`Back ${numbers[numbers.length - 1]}\`` : "`!back <n>`";
  const lines: string[] = [];
  if (prompt.kind === "review")
    lines.push(`\`Send\` submits everything · ${numbers.length ? `${back} re-answers that question` : `${back} re-answers a question`} · \`!cancel\` cancels the ask`);
  else if (freeform(prompt)) lines.push("Your next message is the answer · `!skip` skips it · `!chat <text>` talks to the agent instead");
  else if (prompt.allowMultiple)
    lines.push(pending.length ? `Picked: ${pending.join(", ")} · ` + "`Send` submits · or reply with the numbers, like `1,3`" : "Tap options to pick several, then `Send` · or reply with the numbers, like `1,3`");
  else if (prompt.allowFreeform) lines.push("Reply with a number or with your own answer · `!cancel` cancels");
  else lines.push("Reply with a number · `!cancel` cancels");
  if (prompt.options.length > 25) lines.push("Too many options for buttons: reply with a number.");
  if (prompt.page) lines.push(`To answer this one from here: \`${prompt.page.index} <your answer>\``);
  if (prompt.deadlineAt !== undefined) lines.push(`⏱ ${remaining(prompt.deadlineAt)}`);
  return lines;
};

const promptEmbed = (prompt: PromptInfo, pending: string[], footer: string, open: PromptInfo[]): Embed => {
  const heading = prompt.heading ?? prompt.question;
  const title = prompt.page ? `${heading} · ${prompt.page.index}/${prompt.page.total}` : heading;
  const parts = [prompt.question !== heading ? prompt.question : "", prompt.context ?? "", prompt.options.length ? optionLines(prompt.options, pending) : ""];
  const withHints = [...parts, hints(prompt, pending, open).join("\n")].filter((part) => part.trim()).join("\n\n");
  // A review's answer list is never paginated or trimmed to make room for the how-to-reply
  // lines: they are the part a regular user can work out, and the part that must not be cut is
  // the list of what is about to be sent.
  const body = withHints.length <= EMBED_DESCRIPTION_LIMIT ? withHints : parts.filter((part) => part.trim()).join("\n\n");
  // Discord's own ceiling is the only thing that can still cut the list, and if it does the
  // embed has to admit it rather than read as the whole review.
  const cut = body.length > EMBED_DESCRIPTION_LIMIT ? " · cut short by Discord, the terminal has all of it" : "";
  return buildEmbed(`${footer}${cut}`, `🗣 ${clip(title, 250)}`, body, COLORS.warning);
};

const outcomeEmbed = (entry: Tracked, footer: string): Embed => {
  const prompt = entry.snapshot;
  const title = entry.ours ? "✅ Answered from Discord" : prompt.answered ? "✅ Answered away from Discord" : "⏹ Closed with no answer";
  const why = entry.ours
    ? `Answered: ${clip(entry.label ?? "an answer", 1000)}.`
    : prompt.answered
      ? "It was answered away from Discord, and this embed cannot see where the answer came from. Nothing here changed it."
      : "It ended without an answer: Escape, a timeout, or the run moved on. Nothing was answered.";
  return buildEmbed(footer, title, `${clip(prompt.question, 300)}\n\n${why}`, entry.ours || prompt.answered ? COLORS.success : COLORS.info);
};

const button = (tag: string, id: number, choice: string, label: string, style: Button["style"]): Button => ({
  type: 2,
  style,
  label: clip(label, 90),
  custom_id: `${BUTTON_PREFIX}:${tag}:${id}:${choice}`,
});

/**
 * A review step publishes no count, but the questions it is reviewing stay open behind it, each
 * carrying its number, and those numbers are exactly what `!back <n>` takes. So they become
 * buttons: one tap, no typed argument. Four at most, because Discord gives one row of five and
 * Send lives in it. The questions are the ones of this review's own run; a review asked without a
 * heading has no key to match by, so it pairs with whatever numbered questions are open when
 * nothing else could own them.
 */
const questionNumbers = (review: PromptInfo, open: PromptInfo[]): number[] => {
  const paged = open.filter((prompt) => prompt.id !== review.id && prompt.page);
  const siblings = paged.filter((prompt) => runOf(prompt) === runOf(review));
  const mine = siblings.length || open.filter((prompt) => prompt.kind === "review").length > 1 ? siblings : paged;
  return [...new Set(mine.map((prompt) => prompt.page!.index))]
    .sort((a, b) => a - b)
    .slice(0, 4);
};

/**
 * One button per option, 5 per row and 5 rows at most, plus Send for a multi-select or the
 * review step. Past what Discord allows the buttons are dropped entirely rather than cut off:
 * a partial option list is worse than none, and the embed explains replying either way.
 */
const optionRows = (tag: string, prompt: PromptInfo, pending: string[], open: PromptInfo[]): ActionRow[] => {
  if (prompt.kind === "review") {
    const back = questionNumbers(prompt, open).map((number) => button(tag, prompt.id, `back:${number}`, `Back ${number}`, ButtonStyle.Secondary));
    return [{ type: 1, components: [button(tag, prompt.id, "send", "Send", ButtonStyle.Success), ...back] }];
  }
  if (freeform(prompt)) return [];
  const rows: ActionRow[] = [];
  prompt.options.forEach((option, i) => {
    if (!rows.length || rows[rows.length - 1]!.components.length === 5) rows.push({ type: 1, components: [] });
    const picked = pending.includes(option.title);
    rows[rows.length - 1]!.components.push(
      button(tag, prompt.id, String(i), `${picked ? "✅ " : ""}${option.title.trim() || `option ${i + 1}`}`, picked ? ButtonStyle.Success : ButtonStyle.Primary),
    );
  });
  if (prompt.allowMultiple) rows.push({ type: 1, components: [button(tag, prompt.id, "send", "Send", ButtonStyle.Success)] });
  return rows.length > 5 ? [] : rows;
};
