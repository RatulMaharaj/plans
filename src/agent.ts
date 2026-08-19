/**
 * Starting a coding agent on the plan that is open.
 *
 * The app does not embed an agent and does not pick one. It expands a command
 * template from settings and hands the argv to tmux, which owns the process
 * from there. Everything after that — reading the run, answering it, seeing the
 * diff — is machinery the app already had.
 */

/** The instruction, kept here rather than in a string literal at the call site. */
export const FLESH_OUT_PROMPT =
  "Flesh out the plan at {file}. Keep the house style of this folder: " +
  "argue the design rather than listing steps, cite file:line for anything " +
  "you claim about the code, keep an open questions section, and end with a " +
  "Next checklist. Do not change any file other than the plan.";

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
  const prompt = FLESH_OUT_PROMPT.replace(/\{file\}/g, file);
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
