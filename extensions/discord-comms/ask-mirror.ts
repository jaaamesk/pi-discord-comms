import { COLORS, buildEmbed, clip, type MessagePayload } from "./types.ts";

// Another extension owns the ask_user prompt, so we can read the question it is about to
// ask but cannot answer it. This renders that question faithfully for Discord: no buttons,
// because nothing outside the asking extension can settle its promise. When pi-ask-user
// publishes the prompt instead (see ask-bridge.ts), the live embed replaces this copy.

export type QuestionMirror = {
  description: string;
  fields: { name: string; value: string; inline?: boolean }[];
};

type Option = { title?: string; description?: string } | string;

const optionLines = (options: unknown): string => {
  if (!Array.isArray(options)) return "";
  return options
    .map((option, i) => {
      if (typeof option === "string") return `${i + 1}. ${option}`;
      const title = typeof option?.title === "string" ? option.title : "(unlabelled option)";
      const desc = typeof option?.description === "string" && option.description.trim() ? ` — ${option.description.trim()}` : "";
      return `${i + 1}. ${title}${desc}`;
    })
    .join("\n");
};

const modeNote = (entry: Record<string, unknown>): string => {
  const notes: string[] = [];
  if (entry.allowMultiple === true) notes.push("pick several");
  if (entry.allowFreeform !== false) notes.push("or type your own answer");
  return notes.join(" · ");
};

/** The question an ask-style tool is about to show, or undefined if this call asks nothing. */
export function questionMirror(toolName: string, input: Record<string, unknown>): QuestionMirror | undefined {
  if (!/(ask|question)/i.test(toolName)) return undefined;

  const batch = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : [];
  const single = typeof input.question === "string" && input.question.trim() ? input.question.trim() : "";
  if (!batch.length && !single) return undefined;

  const fields: QuestionMirror["fields"] = [];

  if (single) {
    fields.push({ name: "question", value: clip(single, 1024) });
    const options = optionLines(input.options);
    if (options) fields.push({ name: "options", value: clip(options, 1024) });
    const note = modeNote(input);
    if (note) fields.push({ name: "answer", value: note });
  }

  batch.forEach((entry, index) => {
    const question = typeof entry?.question === "string" ? entry.question.trim() : "";
    if (!question) return;
    const options = optionLines(entry.options);
    const note = modeNote(entry);
    const body = [question, options, note ? `(${note})` : ""].filter(Boolean).join("\n");
    fields.push({ name: `question ${index + 1}`, value: clip(body, 1024) });
  });

  const context = typeof input.context === "string" ? input.context.trim() : "";
  return { description: context, fields };
}

/**
 * The read-only copy of an ask call, ready to send. This is what remains when nothing can
 * answer the question remotely, which is why it offers no components: a button that cannot
 * be settled is worse than a button never offered.
 */
export function mirrorMessage(toolName: string, input: Record<string, unknown>, footer: string): MessagePayload | undefined {
  const mirror = questionMirror(toolName, input);
  if (!mirror) return undefined;
  const answer = "Answer in the terminal — prompts owned by other extensions cannot be answered from Discord yet.";
  const description = [mirror.description, answer].filter(Boolean).join("\n\n");
  return {
    embeds: [buildEmbed(footer, `🗣 Waiting on your answer · ${toolName}`, description, COLORS.warning, mirror.fields)],
  };
}
