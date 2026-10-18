import { clip } from "./types.ts";

// Another extension owns the ask_user prompt, so we can read the question it is about to
// ask but cannot answer it. This renders that question faithfully for Discord.

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
