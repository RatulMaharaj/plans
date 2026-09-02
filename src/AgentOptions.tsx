/**
 * The agent's own settings, drawn from what it says it has.
 *
 * There is no model list in this file, and no list of reasoning levels. The
 * agent advertises `configOptions` when the session opens — a model picker, a
 * thinking level, a permission mode, an agent persona — and this renders one
 * dropdown per entry in the order they arrived.
 *
 * Deliberately *not* switched on `category`. ACP reserves `model`,
 * `thought_level` and `mode`, and the adapter we build against also sends an
 * uncategorised `agent` option — anything that curated by category would have
 * silently dropped it. What an agent offers is the agent's business; the app's
 * business is to show it.
 */
import { track } from "./analytics";
import { api, type ConfigOption } from "./api";
import { Dropdown } from "./Dropdown";

/** Reserved first, in a fixed order, then whatever else the agent sent. */
const ORDER = ["model", "thought_level", "mode"];

/**
 * Effort is a scale, so it is shown as one.
 *
 * The agent sends these in whatever order it likes, but they are not a set of
 * alternatives — they are more and less of the same thing, and a list that
 * jumps around is a list you have to read rather than aim at. The menu opens
 * upward from the composer, so the order runs hardest-first in the markup and
 * reads lowest-to-highest from the bottom, nearest the button, with `default`
 * as the first thing under the cursor.
 *
 * An unrecognised level keeps its place among the others rather than being
 * dropped or pinned: agents may have levels we have not heard of.
 */
const EFFORT = ["max", "xhigh", "high", "medium", "low", "minimal", "none", "default"];

function byEffort(a: { value: string }, b: { value: string }) {
  const ai = EFFORT.indexOf(a.value.toLowerCase());
  const bi = EFFORT.indexOf(b.value.toLowerCase());
  if (ai === -1 || bi === -1) return 0;
  return ai - bi;
}

function ranked(options: ConfigOption[]) {
  return [...options].sort((a, b) => {
    const ai = ORDER.indexOf(a.category ?? "");
    const bi = ORDER.indexOf(b.category ?? "");
    // Unknown categories sort last, keeping their own order among themselves.
    return (ai === -1 ? ORDER.length : ai) - (bi === -1 ? ORDER.length : bi);
  });
}

export function AgentOptions({
  repo,
  chat,
  options,
  busy,
}: {
  repo: string;
  /** The conversation these options belong to — a session is per chat. */
  chat: string;
  options: ConfigOption[] | undefined;
  /** A turn in flight: changing a model mid-answer is not a thing to allow. */
  busy: boolean;
}) {
  // Nothing at all rather than an empty toolbar: a minimal agent that
  // advertises no options should cost no chrome.
  if (!options?.length) return null;

  return (
    <div className="agent-options">
      {ranked(options).map((o) => (
        <Dropdown
          key={o.id}
          className="agent-option"
          ariaLabel={o.name}
          value={o.currentValue}
          disabled={busy}
          onChange={(v) => {
            track("agent_option_changed", { option: o.id });
            void api.agentSetConfig(repo, chat, o.id, v).catch(() => {});
          }}
          choices={(o.category === "thought_level" ? [...o.options].sort(byEffort) : o.options).map(
            (c) => ({ value: c.value, label: c.name, note: c.description }),
          )}
        />
      ))}
    </div>
  );
}
