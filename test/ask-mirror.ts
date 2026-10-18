// Question mirror tests: what an ask-style tool is about to show, rendered for Discord.
// Run: node --experimental-strip-types test/ask-mirror.ts
import { questionMirror } from "../extensions/discord-comms/ask-mirror.ts";

const checks: Record<string, boolean> = {};

const single = questionMirror("ask_user", {
  question: "Which channel should this land in?",
  context: "Found two candidates while wiring the bridge.",
  options: [
    { title: "#pi", description: "already exists" },
    { title: "#pi-dev", description: "new, cleaner history" },
  ],
  allowFreeform: true,
});
checks["single_question"] = single?.fields.some((f) => f.name === "question" && f.value.includes("Which channel")) === true;
checks["single_options_rendered"] =
  single?.fields.some((f) => f.name === "options" && f.value.includes("1. #pi — already exists") && f.value.includes("2. #pi-dev")) === true;
checks["context_preserved"] = single?.description.includes("two candidates") === true;
checks["freeform_noted"] = single?.fields.some((f) => f.value.includes("type your own")) === true;

const batch = questionMirror("ask_user", {
  questions: [
    { question: "Pick a model", options: [{ title: "sonnet" }, { title: "opus" }] },
    { question: "Approve force push?", allowMultiple: true, options: ["yes", "no"] },
  ],
});
checks["batch_two_fields"] = batch?.fields.length === 2;
checks["batch_keeps_both"] =
  batch?.fields[0].value.includes("Pick a model") === true && batch?.fields[1].value.includes("force push") === true;
checks["batch_string_options_and_multi"] =
  batch?.fields[1].value.includes("1. yes") === true && batch?.fields[1].value.includes("pick several") === true;

checks["ignores_unrelated_tools"] =
  questionMirror("bash", { command: "echo ask_user" }) === undefined && questionMirror("edit", { path: "questions.md" }) === undefined;
checks["ignores_empty_ask"] = questionMirror("ask_user", { context: "no question here" }) === undefined;
checks["handles_no_options"] = questionMirror("ask_user", { question: "Proceed?" })?.fields.length === 2; // question + answer note
checks["freeform_off_noted"] =
  questionMirror("ask_user", { question: "Pick one", options: ["a"], allowFreeform: false })?.fields.every((f) => !f.value.includes("type your own")) === true;
checks["long_input_clipped"] =
  (questionMirror("ask_user", { question: "q".repeat(3000), options: [{ title: "a".repeat(2000) }] })?.fields[0].value.length ?? 0) <= 1024;

for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
const passed = Object.values(checks).every(Boolean);
console.log(passed ? "ASK MIRROR OK" : "ASK MIRROR FAILED");
process.exit(passed ? 0 : 1);
