/**
 * The command palette.
 *
 * Two modes, in the manner of VS Code: plans by default, commands when the
 * query opens with ">". Everything in Settings is reachable here, so the
 * palette is a second face on the same state rather than a separate feature.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentFound, PlanFile, RepoInfo } from "./api";
import { displayName } from "./FileTree";
import { FONTS, MONO_FONTS } from "./fonts";
import { DEFAULTS, RANGES, type Settings } from "./settings";
import type { ChatRef, Index as ChatIndex } from "./chats";
import { THEMES } from "./theme";

export type Command = {
  id: string;
  /** "Paper", "Panels" — the group, shown greyed before the label. */
  group: string;
  label: string;
  /** Current value, shown right-aligned. */
  value?: string;
  /**
   * Extra words to match on, never shown. The app calls a theme a paper, which
   * is right on screen and wrong in a search box — nobody types "paper" looking
   * for dark mode.
   */
  terms?: string;
  hint?: string;
  run: () => void;
};

type Props = {
  open: boolean;
  /** True when opened straight into command mode (⌘⇧P). */
  commandMode: boolean;
  onClose: () => void;
  /** Every open repo's markdown, so the palette reaches across all of them. */
  files: { repoPath: string; repoName: string; file: PlanFile }[];
  activePath: string | null;
  activeRepoPath: string | null;
  repos: RepoInfo[];
  settings: Settings;
  set: (patch: Partial<Settings>) => void;
  onOpenFile: (repoPath: string, relPath: string) => void;
  onSelectRepo: (path: string) => void;
  onAddRepo: () => void;
  onNewPlan: () => void;
  onSave: () => void;
  onView: (v: "write" | "source" | "diff" | "settings") => void;
  zen: boolean;
  onZen: () => void;
  onReload: () => void;
  /** Search inside files, for the "*" mode. */
  onSearch: (query: string) => Promise<{ relPath: string; line: number; text: string }[]>;
  onOpenAt: (repoPath: string, relPath: string) => void;
  searchRepo: string | null;
  onPerf: () => void;
  onCheckUpdates: () => void;
  onReleaseNotes: () => void;
  /** Built in App, since they need the repo, its status and its branches. */
  gitCommands: { id: string; label: string; hint?: string; run: () => void }[];
  canNewFolder: boolean;
  onNewFolder: () => void;
  canRename: boolean;
  onRename: () => void;
  onMoveFile: () => void;
  canInsertHtml: boolean;
  onInsertHtml: () => void;
  onNewComment: () => void;
  hasMatter: boolean;
  canEdit: boolean;
  /** False when there is no tmux, so the action is absent rather than broken. */
  canHandOff: boolean;
  onHandOff: () => void;
  /** The active repository's conversations, and the two things you do with them. */
  chats: ChatIndex;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  onRenameChat: (id: string) => void;
  /** Every open repository's chats, for the "all" scope. */
  allChats: {
    repoPath: string;
    repoName: string;
    chat: ChatRef;
    local: boolean;
    current: boolean;
  }[];
  onOpenChatIn: (repoPath: string, id: string) => void;
  /** Which conversations have a live agent, by `repo::chat`. */
  running: Record<string, number>;
  /** Which agents this machine has, and switching to one. */
  agents: AgentFound[];
  onUseAgent: (id: string) => void;
  /** Close every open buffer, and how many there are to close. */
  onCloseAll: () => void;
  openCount: number;
  /** Step to the next open buffer, or the previous one. */
  onCycleTab: (step: number) => void;
  onCopyAgentCommand: () => void;
  onMatter: () => void;
  /** From settings: what `status:` may be set to from here. */
  statuses: string[];
  /** The open file's current status, so it is not offered again. */
  currentStatus: string | null;
  onSetStatus: (value: string | null) => void;
  onScaffoldMatter: () => void;
};

const onOff = (b: boolean) => (b ? "on" : "off");

/**
 * Subsequence match, scored so that earlier and tighter runs win. Returns null
 * when the query doesn't appear at all.
 */
function score(text: string, query: string): number | null {
  if (!query) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let ti = 0;
  let total = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    streak = found === ti ? streak + 1 : 0;
    total += found === ti ? 3 + streak : -Math.min(found - ti, 12) / 4;
    ti = found + 1;
  }
  // A hit at the very start of the string is worth more than one buried in it.
  return total + (t.startsWith(q) ? 12 : 0);
}

function buildCommands(p: Props): Command[] {
  const { settings: s, set } = p;
  const out: Command[] = [];
  const add = (c: Command) => out.push(c);

  // --- doing things ---------------------------------------------------------
  add({ id: "new", group: "Plans", label: "New plan", run: p.onNewPlan });
  add({ id: "save", group: "Plans", label: "Save now", hint: "⌘S", run: p.onSave });
  add({
    id: "reload",
    group: "Plans",
    label: "Reload everything from disk",
    hint: "repos, files, git, open file",
    run: p.onReload,
  });
  if (p.canHandOff) {
    add({
      id: "agent.handoff",
      group: "Agent",
      label: "Hand off this plan to an agent",
      terms: "claude agent run tmux write expand",
      run: p.onHandOff,
    });
    add({
      id: "agent.copy",
      group: "Agent",
      label: "Copy the agent command",
      terms: "clipboard claude shell",
      run: p.onCopyAgentCommand,
    });
    /*
     * Switching agent, without going to settings. Only the ones this machine
     * has: offering an agent that cannot start is offering a failure.
     */
    for (const a of p.agents.filter((x) => x.ready && x.id !== p.settings.chatCommand)) {
      add({
        id: `agent.use.${a.id}`,
        group: "Agent",
        label: `Use ${a.label}`,
        hint: "ends the running session",
        terms: "switch agent claude codex gemini opencode",
        run: () => p.onUseAgent(a.id),
      });
    }
    add({
      id: "chat.rename",
      group: "Agent",
      label: "Rename this chat",
      terms: "title name conversation",
      run: () => p.onRenameChat(p.chats.current),
    });
    add({
      id: "chat.delete",
      group: "Agent",
      label: "Delete this chat",
      hint: p.chats.list.find((c) => c.id === p.chats.current)?.title,
      terms: "remove forget conversation",
      run: () => p.onDeleteChat(p.chats.current),
    });
    add({
      id: "chat.new",
      group: "Agent",
      label: "New chat",
      hint: "the agent forgets this one",
      terms: "clear reset start fresh conversation",
      run: p.onNewChat,
    });
    /*
     * The conversations themselves, named after what they were about.
     *
     * Only the ones you are not already in, and only a handful: the palette
     * is for reaching something, and a list long enough to scroll is a list
     * you would be better off reading in the panel's own picker.
     */
    for (const c of p.chats.list.filter((x) => x.id !== p.chats.current).slice(0, 8)) {
      add({
        id: `chat.${c.id}`,
        group: "Agent",
        label: `Chat: ${c.title}`,
        terms: "conversation history resume switch",
        run: () => p.onOpenChat(c.id),
      });
    }
  }

  if (p.canEdit) {
    add({
      id: "matter",
      group: "Plans",
      label: p.hasMatter ? "Edit frontmatter" : "Add frontmatter",
      run: p.onMatter,
    });
    add({
      id: "matter.scaffold",
      group: "Plans",
      label: "Scaffold frontmatter",
      hint: "title · status · owner · due",
      terms: "template yaml metadata",
      run: p.onScaffoldMatter,
    });
    // One command per configured status, so "draft" is two keys from anywhere.
    for (const s of p.statuses) {
      if (p.currentStatus?.toLowerCase() === s.toLowerCase()) continue;
      add({
        id: `status.${s}`,
        group: "Plans",
        label: `Status: ${s}`,
        hint: "written into the frontmatter",
        terms: "state stage",
        run: () => p.onSetStatus(s),
      });
    }
    if (p.currentStatus) {
      add({
        id: "status.clear",
        group: "Plans",
        label: "Clear status",
        hint: `now ${p.currentStatus}`,
        run: () => p.onSetStatus(null),
      });
    }
  }
  if (p.canNewFolder) {
    add({
      id: "new.folder",
      group: "Plans",
      label: "New folder…",
      terms: "directory mkdir",
      run: p.onNewFolder,
    });
  }
  if (p.canRename) {
    add({
      id: "rename",
      group: "Plans",
      label: "Rename this file…",
      terms: "name title",
      run: p.onRename,
    });
    add({
      id: "move",
      group: "Plans",
      label: "Move this file…",
      terms: "folder directory path",
      run: p.onMoveFile,
    });
  }
  if (p.canInsertHtml) {
    add({
      id: "comment",
      group: "Plans",
      label: "New comment…",
      hint: "⌘⇧M",
      terms: "note thread review aside",
      run: p.onNewComment,
    });
    add({
      id: "html",
      group: "Plans",
      label: "Insert HTML…",
      hint: "at the cursor",
      run: p.onInsertHtml,
    });
  }
  add({
    id: "perf",
    group: "Go",
    label: "Profiler",
    hint: "⌘⌃P",
    run: p.onPerf,
  });
  add({
    id: "update.check",
    group: "Go",
    label: "Check for updates",
    terms: "version upgrade new release",
    run: p.onCheckUpdates,
  });
  add({
    id: "update.notes",
    group: "Go",
    label: "Release notes",
    terms: "changelog what's new version",
    run: p.onReleaseNotes,
  });
  add({
    id: "zen",
    group: "Go",
    label: p.zen ? "Leave zen" : "Zen — the page alone",
    hint: "⌘⇧L",
    run: p.onZen,
  });
  add({ id: "v.write", group: "Go", label: "Write", run: () => p.onView("write") });
  add({
    id: "v.source",
    group: "Go",
    label: "Source — the raw markdown",
    run: () => p.onView("source"),
  });
  add({
    id: "v.diff",
    group: "Go",
    label: "Diff",
    hint: "⌘3",
    run: () => p.onView("diff"),
  });
  if (p.openCount > 0) {
    add({
      id: "tabs.closeAll",
      group: "Go",
      label: "Close all editors",
      hint: `${p.openCount} open`,
      terms: "tabs buffers close everything clear",
      run: p.onCloseAll,
    });
  }
  // A binding nobody can find is a binding nobody uses.
  if (p.openCount > 1) {
    add({
      id: "tab.next",
      group: "Go",
      label: "Next buffer",
      hint: "⌃⇥",
      terms: "tab cycle switch forward cmd alt right cycle through open",
      run: () => p.onCycleTab(1),
    });
    add({
      id: "tab.prev",
      group: "Go",
      label: "Previous buffer",
      hint: "⌃⇧⇥",
      terms: "tab cycle switch back cmd alt left cycle through open",
      run: () => p.onCycleTab(-1),
    });
  }
  add({
    id: "v.settings",
    group: "Go",
    label: "Settings",
    hint: "⌘,",
    run: () => p.onView("settings"),
  });
  add({ id: "repo.add", group: "Repositories", label: "Add a repository…", run: p.onAddRepo });
  for (const r of p.repos) {
    add({
      id: `repo.${r.path}`,
      group: "Repositories",
      label: `Open ${r.name}`,
      value: r.branch,
      run: () => p.onSelectRepo(r.path),
    });
  }

  for (const g of p.gitCommands) {
    add({ id: g.id, group: "Git", label: g.label, hint: g.hint, run: g.run });
  }

  // --- paper and type -------------------------------------------------------
  for (const t of THEMES) {
    add({
      id: `theme.${t.id}`,
      group: "Paper",
      label: t.label,
      value: s.theme === t.id ? "current" : undefined,
      terms: `theme appearance colour color scheme ${t.id === "night" ? "dark" : "light"}`,
      run: () => set({ theme: t.id }),
    });
  }
  for (const f of FONTS) {
    add({
      id: `font.${f.id}`,
      group: "Typeface",
      label: f.label,
      value: s.fontId === f.id ? "current" : f.note,
      // Everything a person might type looking for this: the word they use, the
      // designer's name, and what the face is for.
      terms: `font typeface family reading page prose ${f.note} ${f.designer}`,
      run: () => set({ fontId: f.id }),
    });
  }

  for (const m of MONO_FONTS) {
    add({
      id: `mono.${m.id}`,
      group: "Monospace",
      label: m.label,
      value: s.monoId === m.id ? "current" : m.note,
      terms: `font mono monospace code chrome source ${m.note}`,
      run: () => set({ monoId: m.id }),
    });
  }

  // Sliders become a nudge in each direction, clamped to the same ranges the
  // Settings page uses.
  const nudge = (
    key: "size" | "measure" | "leading" | "watchSeconds" | "treeSize" | "codeSize",
    group: string,
    label: string,
    unit = "",
    terms?: string,
  ) => {
    const r = RANGES[key];
    const cur = s[key];
    const show = (n: number) => `${Number(n.toFixed(2))}${unit}`;
    add({
      id: `${key}.up`,
      group,
      label: `${label}: increase`,
      value: show(cur),
      terms,
      run: () => set({ [key]: Math.min(r.max, cur + r.step) } as Partial<Settings>),
    });
    add({
      id: `${key}.down`,
      group,
      label: `${label}: decrease`,
      value: show(cur),
      terms,
      run: () => set({ [key]: Math.max(r.min, cur - r.step) } as Partial<Settings>),
    });
    /*
     * And a way back.
     *
     * Nudging is the only way these values move, so having zoomed the page you
     * could only return to the default by counting your way back to it — and
     * the number you are counting back to is not written anywhere you can see
     * while the palette is open. The Settings page has had the answer all
     * along: every slider there carries a revert to `DEFAULTS`.
     *
     * Always offered, alongside the two nudges it belongs with. It was briefly
     * hidden while the value was already at its default, on the grounds that a
     * command doing nothing is clutter — which got the trade backwards. A
     * reader looking for "reset" wants to know the app *has* one, and a list
     * whose contents depend on state you cannot see is a list you cannot learn.
     * The value says where it would go, so a no-op reads as one.
     */
    const home = DEFAULTS[key];
    add({
      id: `${key}.reset`,
      group,
      label: `${label}: reset`,
      value: cur === home ? show(home) : `${show(cur)} → ${show(home)}`,
      terms: `default original ${terms ?? ""}`,
      run: () => set({ [key]: home } as Partial<Settings>),
    });
  };
  // The two ⌘+/⌘− drives answer to "zoom"; the rest are not what anyone means
  // by the word, and putting it on them would only make the search worse.
  nudge("size", "Typeface", "Size", "px", "zoom bigger smaller scale editor page document");
  nudge("measure", "Typeface", "Line length", "ch");
  nudge("leading", "Typeface", "Line height");
  nudge("codeSize", "Typeface", "Code size", "px");
  nudge("watchSeconds", "Panels", "Outside-edit check", "s");
  nudge("treeSize", "Files", "Tree text size", "px", "zoom bigger smaller scale sidebar tree files");

  // --- everything that is simply on or off ----------------------------------
  const toggle = (
    key:
      | "spellcheck"
      | "diffLineNumbers"
      | "diffWrap"
      | "diffExpandUnchanged"
      | "diffLive"
      | "showIgnored"
      | "showExtensions"
      | "showFrontmatter"
      | "showCompleted"
      | "sourceLineNumbers"
      | "sourceWrap"
      | "showIndex"
      | "showGit"
      | "showMux"
      | "showStatusBar",
    group: string,
    label: string,
    hint?: string,
    terms?: string,
  ) =>
    add({
      id: key,
      group,
      /*
       * Panels are shown or hidden; everything else is turned on or off. A
       * panel that has been "turned off" sounds like it stopped working,
       * which for the agent chat is exactly the wrong thing to imply.
       */
      label:
        group === "Panels"
          ? `${s[key] ? "Hide" : "Show"} ${label.toLowerCase()}`
          : `${label}: turn ${s[key] ? "off" : "on"}`,
      value: group === "Panels" ? (s[key] ? "shown" : "hidden") : onOff(s[key]),
      hint,
      terms,
      run: () => set({ [key]: !s[key] } as Partial<Settings>),
    });

  toggle("spellcheck", "Writing", "Spellcheck", undefined, "spelling dictionary");
  toggle("diffLineNumbers", "Diff", "Line numbers");
  toggle("diffWrap", "Diff", "Wrap long lines");
  toggle("diffExpandUnchanged", "Diff", "Show unchanged lines");
  toggle("diffLive", "Diff", "Live diff as you type");
  toggle("showIgnored", "Files", "Gitignored files");
  toggle("showExtensions", "Files", "File extensions");
  toggle("showFrontmatter", "Files", "Frontmatter block");
  toggle("sourceLineNumbers", "Source", "Line numbers");
  toggle("sourceWrap", "Source", "Wrap long lines");
  toggle("showIndex", "Panels", "File tree", "⌘B", "sidebar files explorer");
  toggle("showGit", "Panels", "Git panel", "⌘G");
  toggle("showMux", "Panels", "Agent chat", "⌘J", "chat agent talk ask");
  toggle("showStatusBar", "Panels", "Status bar");

  // Not `toggle`: "turn off" says nothing about what happens to the plans.
  // Shown and hidden are the two states, so those are the words.
  add({
    id: "showCompleted",
    group: "Files",
    label: `Show finished plans: ${s.showCompleted ? "hidden" : "shown"}`,
    value: s.showCompleted ? "shown" : "hidden",
    terms: "done completed archive hide",
    run: () => set({ showCompleted: !s.showCompleted }),
  });

  // Not a `toggle`: the label has to name where it is going, not what it is.
  add({
    id: "chatPlace",
    group: "Panels",
    label: `Move the chat ${s.chatPlace === "side" ? "below the page" : "beside the page"}`,
    value: s.chatPlace === "side" ? "beside" : "below",
    terms: "sidebar terminal bottom column row",
    run: () => set({ chatPlace: s.chatPlace === "side" ? "bottom" : "side" }),
  });

  // Ordering by status is the cheap answer to sequencing a plans folder: the
  // status is read on every file already, so it needs no field maintained by
  // hand and cannot drift out of step with itself the way a number would.
  add({
    id: "treeSort",
    group: "Files",
    label: `Order files by ${s.treeSort === "status" ? "name" : "status"}`,
    value: s.treeSort,
    terms: "sort tree sequence order status alphabetical",
    run: () => set({ treeSort: s.treeSort === "status" ? "name" : "status" }),
  });

  // Also not a toggle: what it switches between is two lists, not on and off.
  add({
    id: "chatScope",
    group: "Agent",
    label: `Search chats ${s.chatScope === "all" ? "in this repository" : "across every repository"}`,
    value: s.chatScope === "all" ? "all repos" : "this repo",
    terms: "palette hash conversation scope everywhere across",
    run: () => set({ chatScope: s.chatScope === "all" ? "repo" : "all" }),
  });

  add({
    id: "diffStyle",
    group: "Diff",
    label: `Diff layout: ${s.diffStyle === "unified" ? "side by side" : "unified"}`,
    value: s.diffStyle,
    run: () => set({ diffStyle: s.diffStyle === "unified" ? "split" : "unified" }),
  });

  return out;
}

export function Palette(props: Props) {
  const { open, commandMode, onClose } = props;
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Each opening starts clean, in whichever mode the shortcut asked for.
  useEffect(() => {
    if (open) {
      setQ(commandMode ? ">" : "");
      setSel(0);
    }
  }, [open, commandMode]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const commands = useMemo(
    () => (open ? buildCommands(props) : []),
    // Rebuilt on every open and on any settings change, so the labels always
    // describe what the command would do next.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, props.settings, props.repos, props.zen],
  );

  /*
   * Three prefixes, each standing for what it reaches.
   *
   * ">" commands, as everywhere. "*" the contents of files — a wildcard is
   * what people already type when they mean "anything containing this", and
   * it reads better than the "?" it replaced, which looked like a question.
   * "#" a conversation, the way a channel is written.
   *
   * Not "@", though it was the first instinct: editors already spend it on
   * "go to symbol", and ACP agents spend it on mentioning a *file* in a
   * prompt. The composer is three feet below this box, and one character
   * meaning "a file" there and "a conversation" here is a collision waiting.
   */
  const isCmd = q.startsWith(">");
  const isText = q.startsWith("*");
  const isChat = q.startsWith("#");
  const term = isCmd || isText || isChat ? q.slice(1).trim() : q.trim();

  /**
   * Text search runs in Rust, so it is debounced rather than run per keystroke.
   */
  const [hits, setHits] = useState<{ relPath: string; line: number; text: string }[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!isText || term.length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    setSearching(true);
    const t = setTimeout(() => {
      void props
        .onSearch(term)
        .then((found) => live && setHits(found))
        .catch(() => live && setHits([]))
        .finally(() => live && setSearching(false));
    }, 160);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isText, term]);

  type Row =
    | { kind: "file"; key: string; label: string; sub: string; run: () => void }
    | { kind: "cmd"; key: string; label: string; sub: string; value?: string; run: () => void };

  const rows = useMemo<Row[]>(() => {
    if (isChat) {
      /*
       * Every conversation, including the one you are in — unlike the command
       * list, where "go to this chat" is not worth offering for where you
       * already are. Here you are reading a list, and a list with a hole in it
       * is harder to read than one without.
       */
      if (props.settings.chatScope === "all") {
        /*
         * Every repository's, when that is what you asked for. The repository
         * is named on each foreign row because the titles come from what was
         * said, and two repositories can easily hold a chat called the same
         * thing. Capped like the file and command lists: the per-repo list
         * never needed one because it could not get long, and this one can.
         *
         * Ids are only unique within a repository, so the row key carries both.
         */
        return props.allChats
          .map((e) => ({ e, s: score(e.chat.title, term), live: !!props.running[`${e.repoPath}::${e.chat.id}`] }))
          .filter((x) => x.s !== null)
          // Running first: an agent that is working is the thing you came
          // looking for, whichever repository it is working in.
          .sort((a, b) => Number(b.live) - Number(a.live) || (b.s as number) - (a.s as number))
          .slice(0, 60)
          .map(({ e, live }) => ({
            kind: "cmd" as const,
            key: `chat.${e.repoPath}::${e.chat.id}`,
            label: e.chat.title,
            // The repository still has to be named on a foreign row, or the
            // row is not legible at all — so "running" joins it rather than
            // replacing it.
            sub: [
              live ? "running" : null,
              e.local ? (e.current ? "current" : "chat") : e.repoName,
            ]
              .filter(Boolean)
              .join(" · "),
            run: () => props.onOpenChatIn(e.repoPath, e.chat.id),
          }));
      }
      const here = props.activeRepoPath ?? "";
      return props.chats.list
        .map((c) => ({ c, s: score(c.title, term), live: !!props.running[`${here}::${c.id}`] }))
        .filter((x) => x.s !== null)
        .sort((a, b) => Number(b.live) - Number(a.live) || (b.s as number) - (a.s as number))
        .map(({ c, live }) => ({
          kind: "cmd" as const,
          key: `chat.${c.id}`,
          label: c.title,
          sub: live ? "running" : c.id === props.chats.current ? "current" : "archived",
          run: () => props.onOpenChat(c.id),
        }));
    }
    if (isText) {
      return hits.map((h, i) => ({
        kind: "file" as const,
        key: `${h.relPath}:${h.line}:${i}`,
        label: h.text,
        sub: `${h.relPath}:${h.line}`,
        run: () => props.searchRepo && props.onOpenAt(props.searchRepo, h.relPath),
      }));
    }
    if (isCmd) {
      return commands
        .map((c) => ({ c, s: score(`${c.group} ${c.label} ${c.terms ?? ""}`, term) }))
        .filter((x) => x.s !== null)
        .sort((a, b) => (b.s as number) - (a.s as number))
        .slice(0, 60)
        .map(({ c }) => ({
          kind: "cmd" as const,
          key: c.id,
          label: c.label,
          sub: c.group,
          value: c.value ?? c.hint,
          run: c.run,
        }));
    }
    // Repos are searchable too — "docs/plan" and "myrepo plan" both land.
    return props.files
      .map((e) => ({ e, s: score(`${e.repoName}/${e.file.relPath}`, term) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => (b.s as number) - (a.s as number))
      .slice(0, 60)
      .map(({ e }) => ({
        kind: "file" as const,
        key: `${e.repoPath}::${e.file.relPath}`,
        label: displayName(e.file.name, props.settings.showExtensions),
        sub:
          props.repos.length > 1
            ? `${e.repoName} · ${e.file.relPath}`
            : e.file.relPath,
        run: () => props.onOpenFile(e.repoPath, e.file.relPath),
      }));
  }, [
    isCmd,
    isText,
    isChat,
    hits,
    term,
    commands,
    props.files,
    props.onOpenFile,
    props.chats,
    props.onOpenChat,
    props.allChats,
    props.onOpenChatIn,
    props.settings.chatScope,
    props.running,
    props.activeRepoPath,
  ]);

  useEffect(() => setSel(0), [q]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector('[data-on="1"]')?.scrollIntoView({ block: "nearest" });
  }, [sel, rows]);

  if (!open) return null;

  const commit = (i: number) => {
    const row = rows[i];
    if (!row) return;
    onClose();
    row.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key.toLowerCase() === "n")) {
      e.preventDefault();
      setSel((i) => (rows.length ? (i + 1) % rows.length : 0));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key.toLowerCase() === "p")) {
      e.preventDefault();
      setSel((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(sel);
    }
  };

  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={q}
          spellCheck={false}
          placeholder="Find a file · > commands · * search inside · # chats"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="palette-list" ref={listRef}>
          {rows.length === 0 && (
            <div className="palette-empty">
              {isText && term.length < 2
                ? "Type at least two characters."
                : searching
                  ? "Searching…"
                  : "Nothing matches."}
            </div>
          )}
          {rows.map((r, i) => (
            <button
              key={r.key}
              className={`palette-row ${i === sel ? "on" : ""}`}
              data-on={i === sel ? "1" : "0"}
              onMouseMove={() => setSel(i)}
              onClick={() => commit(i)}
            >
              <span className="palette-label">{r.label}</span>
              <span className="palette-group">{r.sub}</span>
              {"value" in r && r.value && <span className="palette-value">{r.value}</span>}
              {r.kind === "file" &&
                r.key === `${props.activeRepoPath}::${props.activePath}` && (
                  <span className="palette-value">open</span>
                )}
            </button>
          ))}
        </div>
        <div className="palette-foot">
          <span>
            {isCmd
              ? "Commands"
              : isText
                ? "Inside files"
                : isChat
                  ? props.settings.chatScope === "all"
                    ? "Chats · all repositories"
                    : "Chats"
                  : "Files"}
          </span>
          <span>↑↓ move · ⏎ run · esc close</span>
        </div>
      </div>
    </div>
  );
}
