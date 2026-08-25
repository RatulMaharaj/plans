/**
 * Starting a coding agent on the plan that is open.
 *
 * The app does not embed an agent and does not pick one. It expands a command
 * template from settings and hands the argv to tmux, which owns the process
 * from there. Everything after that — reading the run, answering it, seeing the
 * diff — is machinery the app already had.
 */

/**
 * The two handoffs, named for the lifecycle move each one asks for
 * (skills/plans/SKILL.md): `complete` fleshes a plan out towards `ready`,
 * `implement` builds a `ready` plan and marks it `busy`, then `done`.
 */
export type HandoffKind = "complete" | "implement";

/**
 * What the agent is told when a plan is handed to it to be completed.
 *
 * A handoff, not a command: the plan is the brief, and the agent is being
 * asked to take it further in the voice the folder already speaks.
 */
export const HANDOFF_PROMPT =
  "Take over the plan at {file} and take it further. Keep the house style of " +
  "this folder: argue the design rather than listing steps, cite file:line " +
  "for anything you claim about the code, keep an open questions section, " +
  "and end with a Next checklist. Do not change any file other than the plan.";

/**
 * What the agent is told when a plan is handed to it to be implemented.
 *
 * The plan is the spec now, not the deliverable: the agent claims it in the
 * frontmatter, builds what it describes, and records in the plan what it
 * did differently and why — so the file stays a true account of the work.
 */
export const IMPLEMENT_PROMPT =
  "Implement the plan at {file}. Read it in full first, and set its status to " +
  "busy before you touch anything else. Build exactly what it describes, in " +
  "the style of the surrounding code; where you must diverge, say so in the " +
  "plan rather than silently. Run the relevant tests. When the work is " +
  "finished and verified, set the plan's status to done and end it with a " +
  "short account of what landed and where. Do not commit.";

/**
 * What the agent is told when a passage is handed to it to be rewritten.
 *
 * The quote is the address. A line number is a claim about a file that moves
 * the moment the agent edits above it; text the agent can find with its own
 * eyes does not rot. `{lines}` rides along only when the quote occurs exactly
 * once in the file, and is empty otherwise — a hint that might be wrong is
 * worse than no hint.
 *
 * The "nothing outside" clause is the seatbelt: handing a whole file to an
 * agent with a local instruction invites a helpful global rewrite.
 */
export const REWRITE_PROMPT =
  "In {file}, rewrite only the passage quoted below{lines}. {ask}\n" +
  "Keep the surrounding voice and formatting, change nothing outside the " +
  "quoted text, and do not touch any other file.\n\n" +
  "> {quote}";

/** Past this many lines, a selection is quoted by its ends rather than whole. */
export const QUOTE_MAX_LINES = 50;
/** How many lines of each end survive the elision. */
const QUOTE_EDGE_LINES = 3;

/**
 * The selection, as the body of a markdown blockquote.
 *
 * A long selection truncates rather than switching to some other way of
 * pointing: the two ends still pin the region uniquely, and the marker between
 * them says out loud that the passage runs from the first quoted line to the
 * last. Three pages of quote in a prompt buy nothing.
 */
export function quoteBlock(text: string): string {
  const lines = text.split("\n");
  const kept =
    lines.length <= QUOTE_MAX_LINES
      ? lines
      : [
          ...lines.slice(0, QUOTE_EDGE_LINES),
          "",
          "… the selection continues; it runs from the first quoted line to the last …",
          "",
          ...lines.slice(-QUOTE_EDGE_LINES),
        ];
  // Every line of a blockquote carries the marker; the template writes the first.
  return kept.join("\n> ");
}

/**
 * "around lines N–M", when that is a thing we actually know.
 *
 * Only for a quote that occurs exactly once in the file as it stands. Twice
 * and the number is a guess; not at all — the write surface's serialisation
 * differs from the markdown often enough — and it is a fiction. Either way the
 * answer is silence, because the quote locates itself and a hint that might be
 * wrong is worse than no hint.
 */
export function lineHint(source: string, text: string): string {
  const at = source.indexOf(text);
  if (at < 0 || source.indexOf(text, at + 1) !== -1) return "";
  const start = source.slice(0, at).split("\n").length;
  const end = start + text.split("\n").length - 1;
  return start === end ? `, around line ${start}` : `, around lines ${start}–${end}`;
}

/**
 * Split a command line into an argv, honouring quotes.
 *
 * The template is a string because that is what people type, but tmux is given
 * an explicit argv and never a shell — so the splitting has to happen here,
 * where it can be tested, rather than by handing the line to `sh -c`.
 *
 * This understands quotes and nothing else. No globs, no pipes, no `&&`, no
 * variable expansion: a template that wants those is asking for a shell, and
 * the answer to that is a wrapper script the user writes themselves.
 */
export function splitArgv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started || cur) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += c;
  }
  if (started || cur) out.push(cur);
  return out;
}

/**
 * Expand `{prompt}` and `{file}` in the template, then split.
 *
 * Substitution happens *after* splitting decisions are made about the template
 * itself — a path with a space in it lands in one argv entry because it is
 * substituted into an already-split word, not because it was quoted correctly.
 * That is the whole reason this is not a shell string.
 */
export function agentArgv(template: string, file: string): string[] {
  const prompt = HANDOFF_PROMPT.replace(/\{file\}/g, file);
  const words = splitArgv(template);
  // No template is no command. Appending the prompt to an empty argv would
  // produce something with nothing to exec, which fails far from here.
  if (words.length === 0) return [];
  const argv = words.map((w) =>
    w.replace(/\{prompt\}/g, prompt).replace(/\{file\}/g, file),
  );
  // A template that mentions neither placeholder still has to carry the
  // instruction, or the agent is started with nothing to do.
  if (!/\{prompt\}|\{file\}/.test(template)) argv.push(prompt);
  return argv.filter((w) => w.length > 0);
}

/** The command as a person would type it, for the clipboard and the toast. */
export function agentCommandLine(template: string, file: string): string {
  return agentArgv(template, file)
    .map((w) => (/[\s"']/.test(w) ? `'${w.replace(/'/g, "'\\''")}'` : w))
    .join(" ");
}
