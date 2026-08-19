/**
 * The command handed to tmux.
 *
 * Pure functions on the boundary between the app and a process, which is
 * exactly where a mistake is expensive: a badly split argv runs the wrong
 * thing. No browser needed to answer any of this.
 */
import { test, expect } from "@playwright/test";
import { agentArgv, agentCommandLine, splitArgv, HANDOFF_PROMPT } from "../src/agent";
import { isBusyPane } from "../src/pane";

test.describe("splitting a command template", () => {
  test("splits on whitespace", () => {
    expect(splitArgv("claude --print")).toEqual(["claude", "--print"]);
  });

  test("keeps a quoted run together", () => {
    expect(splitArgv(`claude --model "big model"`)).toEqual([
      "claude",
      "--model",
      "big model",
    ]);
  });

  test("handles single quotes and adjacent text", () => {
    expect(splitArgv(`a 'b c'd`)).toEqual(["a", "b cd"]);
  });

  test("an empty quoted argument survives", () => {
    // "" is a real argument — dropping it would shift every flag after it.
    expect(splitArgv(`claude ""`)).toEqual(["claude", ""]);
  });

  test("collapses runs of whitespace rather than making empty words", () => {
    expect(splitArgv("  claude   --print  ")).toEqual(["claude", "--print"]);
  });
});

test.describe("building the agent command", () => {
  const FILE = "plans/some-plan.md";

  test("substitutes the prompt into the template", () => {
    const argv = agentArgv("claude {prompt}", FILE);
    expect(argv[0]).toBe("claude");
    expect(argv).toHaveLength(2);
    expect(argv[1]).toContain(FILE);
  });

  test("the prompt mentions the file it is about", () => {
    expect(agentArgv("claude {prompt}", FILE)[1]).toBe(
      HANDOFF_PROMPT.replace("{file}", FILE),
    );
  });

  /**
   * The reason substitution happens after splitting: a path with a space in it
   * must stay one argument without the template having quoted it.
   */
  test("a path with spaces stays a single argument", () => {
    const argv = agentArgv("claude {file}", "plans/some plan.md");
    expect(argv).toEqual(["claude", "plans/some plan.md"]);
  });

  test("a template with neither placeholder still carries the instruction", () => {
    const argv = agentArgv("opencode", FILE);
    expect(argv[0]).toBe("opencode");
    expect(argv[1]).toContain(FILE);
  });

  test("{file} can appear on its own as a flag value", () => {
    expect(agentArgv("codex --file {file} run", FILE)).toEqual([
      "codex",
      "--file",
      FILE,
      "run",
    ]);
  });

  test("an empty template yields nothing to run", () => {
    expect(agentArgv("   ", FILE)).toEqual([]);
  });

  test("the copied line quotes what a shell would need quoted", () => {
    const line = agentCommandLine("claude {file}", "plans/some plan.md");
    expect(line).toBe("claude 'plans/some plan.md'");
  });
});

test.describe("which panes look busy", () => {
  const pane = (command: string, dead = false) => ({
    id: "%1",
    target: "plans:1",
    command,
    dead,
    width: 80,
    height: 24,
    path: "/repo",
  });

  test("a shell is not busy", () => {
    expect(isBusyPane(pane("zsh"))).toBe(false);
  });

  test("anything else is", () => {
    expect(isBusyPane(pane("node"))).toBe(true);
  });

  test("a dead pane is not busy whatever it was running", () => {
    expect(isBusyPane(pane("node", true))).toBe(false);
  });

  test("nothing selected is not busy", () => {
    expect(isBusyPane(undefined)).toBe(false);
  });
});
