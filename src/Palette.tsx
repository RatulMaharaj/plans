/**
 * The command palette.
 *
 * Two modes, in the manner of VS Code: plans by default, commands when the
 * query opens with ">". Everything in Settings is reachable here, so the
 * palette is a second face on the same state rather than a separate feature.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentFound, PlanFile, RepoInfo } from "./api";
import type { HandoffKind } from "./agent";
import { displayName } from "./FileTree";
import { FONTS, MONO_FONTS } from "./fonts";
import { DEFAULTS, RANGES, type Settings } from "./settings";
import type { ChatRef, Index as ChatIndex } from "./chats";
import { THEMES } from "./theme";
import { renderKeys, type KeymapEntry } from "./keys";
import { score } from "./score";
import { commandName, track } from "./analytics";
import type { Template } from "./templates";

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
  /**
   * The templates a new file can be made from, in order. One command each —
   * the first also carries the `new` id, so ⌘N and its hint go on belonging to
   * whatever is first.
   */
  templates: Template[];
  onNewFromTemplate: (t: Template) => void;
  onSave: () => void;
  onView: (v: "write" | "source" | "diff" | "settings") => void;
  /** Hand settings.json to the system's JSON editor. */
  onOpenSettingsFile: () => void;
  zen: boolean;
  onZen: () => void;
  onReload: () => void;
  /** Search inside files, for the "*" mode. */
  onSearch: (query: string) => Promise<{ relPath: string; line: number; text: string }[]>;
  /** Open a hit with the find bar seeded: the query, and the line it was on. */
  onOpenAt: (repoPath: string, relPath: string, line: number, query: string) => void;
  /** ⌘F, as a command — a binding nobody can find is a binding nobody uses. */
  onFind: () => void;
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
  onHandOff: (kind: HandoffKind) => void;
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
  /** The open buffer's workspace, when it is one: share links are per room. */
  canShare: boolean;
  /** Whether this plan already has a page, which is what "copy" means. */
  sharedPage: boolean;
  onShare: () => void;
  onCopyPageLink: () => void;
  onMatter: () => void;
  /**
   * The bundled skills, openable like any other file. Empty when no
   * repository is active. App resolves where each skill's installed copy
   * actually lives — per-skill file or fenced section — when it is asked for.
   */
  skillFiles: { name: string; label: string }[];
  onOpenSkill: (name: string) => void;
  /** From settings: what `status:` may be set to from here. */
  statuses: string[];
  /** The open file's current status, so it is not offered again. */
  currentStatus: string | null;
  onSetStatus: (value: string | null) => void;
  /** The routing keys on the open file, so the current value is not offered. */
  routing: { model: string | null; effort: string | null };
  /**
   * What may be offered for each routing key: the live session's advertised
   * options (ACP `model` / `thought_level`), or empty when no agent is
   * advertising — in which case no commands appear and the keys are set by
   * hand. The vocabulary is the agent's, never this app's.
   */
  routingChoices: { model: string[]; effort: string[] };
  onSetRouting: (key: "model" | "effort", value: string | null) => void;
  onScaffoldMatter: () => void;
  /**
   * The merged keymap. Where a command's id has a binding, its hint is
   * rendered from it rather than typed by hand — so the palette cannot lie
   * about a key the reader has rebound.
   */
  keymap: KeymapEntry[];
  onShortcuts: () => void;
  /** Whether the second pane is open, and the things you do to it. */
  splitOpen: boolean;
  onSplit: () => void;
  onSplitDir: () => void;
  onSwapPanes: () => void;
  /** Set the focused pane's view alone, leaving the other where it is. */
  onPaneView: (v: "write" | "source" | "diff") => void;
  /** Show the open document in both panes at once. */
  canSplitSame: boolean;
  onSplitSame: () => void;
};

const onOff = (b: boolean) => (b ? "on" : "off");

function buildCommands(p: Props): Command[] {
  const { settings: s, set } = p;
  const out: Command[] = [];
  const add = (c: Command) => out.push(c);

  // --- doing things ---------------------------------------------------------
  /*
   * One command per template, built from the folder the same way the per-skill
   * "Open the … skill" commands are. The first keeps the `new` id so ⌘N still
   * has a command to name and a hint to render; the rest are addressed by the
   * file they came from, since two templates may well be called the same thing.
   */
  p.templates.forEach((t, i) => {
    add({
      id: i === 0 ? "new" : `new.${t.file}`,
      group: "Plans",
      label: `New: ${t.name}`,
      hint: t.fileName,
      terms: "new file template create",
      run: () => p.onNewFromTemplate(t),
    });
  });
  add({ id: "save", group: "Plans", label: "Save now", run: p.onSave });
  if (p.canEdit) {
    add({
      id: "find",
      group: "Plans",
      label: "Find in this file",
      terms: "search inside document within page",
      run: p.onFind,
    });
  }
  add({
    id: "reload",
    group: "Plans",
    label: "Reload everything from disk",
    hint: "repos, files, git, open file",
    run: p.onReload,
  });
  if (p.canHandOff) {
    add({
      id: "agent.handoff.complete",
      group: "Agent",
      label: "Hand off to agent: complete this plan",
      hint: "flesh it out towards ready",
      terms: "claude agent run write expand draft flesh out",
      run: () => p.onHandOff("complete"),
    });
    add({
      id: "agent.handoff.implement",
      group: "Agent",
      label: "Hand off to agent: implement this plan",
      hint: "build it, busy then done",
      terms: "claude agent run build code ready busy",
      run: () => p.onHandOff("implement"),
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

  /*
   * Sharing, on any plan: a page addresses a document, and since
   * plans/public-plan-pages.md a file on disk can have one too. It needs a
   * server to publish to, which is what `canShare` is.
   */
  if (p.canShare) {
    add({
      id: "plan.share.copy",
      group: "Plans",
      label: p.sharedPage ? "Copy public link" : "Share and copy link",
      hint: "read-only, for anyone with the address",
      terms: "publish url public send read only browser share",
      run: () => p.onCopyPageLink(),
    });
    add({
      id: "plan.share",
      group: "Plans",
      label: p.sharedPage ? "Sharing…" : "Share…",
      hint: p.sharedPage ? "the address, or stop sharing" : "a page anyone can open",
      terms: "unshare stop revoke publish public page",
      run: () => p.onShare(),
    });
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
    // Same shape for the routing keys: "opus" is two keys from anywhere —
    // offering only what the live agent advertised, so the palette never
    // writes a value the dispatching agent would not recognise.
    const routing: ["model" | "effort", string[]][] = [
      ["model", p.routingChoices.model],
      ["effort", p.routingChoices.effort],
    ];
    for (const [key, values] of routing) {
      if (!values.length) continue;
      const current = p.routing[key]?.toLowerCase() ?? null;
      for (const v of values) {
        if (current === v.toLowerCase()) continue;
        add({
          id: `${key}.${v}`,
          group: "Plans",
          label: `${key === "model" ? "Model" : "Effort"}: ${v}`,
          hint: "routes the dispatched run",
          terms: "route dispatch worker frontmatter model effort brain think",
          run: () => p.onSetRouting(key, v),
        });
      }
      if (p.routing[key]) {
        add({
          id: `${key}.clear`,
          group: "Plans",
          label: `Clear ${key}`,
          hint: `now ${p.routing[key]} — dispatcher default applies`,
          run: () => p.onSetRouting(key, null),
        });
      }
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
  /*
   * The installed skills are ordinary repo-relative markdown, so "manage" is a
   * command to open each, not a management screen. The hint carries the one
   * honest caveat: the app rewrites these copies on update, so edits belong
   * around the fence or upstream, not in them.
   */
  for (const k of p.skillFiles) {
    add({
      id: `skill.open.${k.name}`,
      group: "Agent",
      label: `Open the ${k.label}`,
      hint: "replaced on update — edit upstream, not here",
      terms: "conventions skill installed review plans manage",
      run: () => p.onOpenSkill(k.name),
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
    run: p.onZen,
  });
  add({ id: "v.write", group: "Go", label: "Write", run: () => p.onView("write") });
  add({
    id: "v.source",
    group: "Go",
    label: "Source — the raw markdown",
    run: () => p.onView("source"),
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
      terms: "tab cycle switch forward cmd alt right cycle through open",
      run: () => p.onCycleTab(1),
    });
    add({
      id: "tab.prev",
      group: "Go",
      label: "Previous buffer",
      terms: "tab cycle switch back cmd alt left cycle through open",
      run: () => p.onCycleTab(-1),
    });
  }
  add({
    id: "v.settings",
    group: "Go",
    label: "Settings",
    run: () => p.onView("settings"),
  });
  add({
    id: "settings.file",
    group: "Go",
    label: "Open settings file (JSON)",
    hint: "In your JSON editor",
    terms: "settings json file config preferences edit by hand schema",
    run: p.onOpenSettingsFile,
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
       * The name stays fixed; the state lives in the value chip. A label that
       * flips ("Show all files" / "Hide all files") makes the same setting
       * read as two different commands, and muscle memory types the name.
       * Panels are shown or hidden; everything else is on or off.
       */
      label,
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
  toggle("showGit", "Panels", "Git panel");
  toggle("showMux", "Panels", "Agent chat", undefined, "chat agent talk ask");
  toggle("showStatusBar", "Panels", "Status bar");

  // Not `toggle` only because shown/hidden are its words, not on/off —
  // "turned off" says nothing about what happens to the plans.
  add({
    id: "showCompleted",
    group: "Files",
    label: "Finished plans",
    value: s.showCompleted ? "shown" : "hidden",
    terms: "done completed archive hide show",
    run: () => set({ showCompleted: !s.showCompleted }),
  });

  // Shown/hidden for the same reason as finished plans: "all files: off"
  // sounds like the tree goes dark. The name matches the Settings page.
  add({
    id: "showAllFiles",
    group: "Files",
    label: "Show all files",
    value: s.showAllFiles ? "on" : "off",
    terms: "show all every file text source code extensions markdown only hide",
    run: () => set({ showAllFiles: !s.showAllFiles }),
  });

  // Not a `toggle`: its two states are places, not on and off.
  add({
    id: "chatPlace",
    group: "Panels",
    label: "Chat position",
    value: s.chatPlace === "side" ? "beside the page" : "below the page",
    terms: "move sidebar terminal bottom column row beside below",
    run: () => set({ chatPlace: s.chatPlace === "side" ? "bottom" : "side" }),
  });

  // Ordering by status is the cheap answer to sequencing a plans folder: the
  // status is read on every file already, so it needs no field maintained by
  // hand and cannot drift out of step with itself the way a number would.
  add({
    id: "treeSort",
    group: "Files",
    label: "File order",
    value: s.treeSort === "status" ? "by status" : "by name",
    terms: "sort tree sequence order status name alphabetical",
    run: () => set({ treeSort: s.treeSort === "status" ? "name" : "status" }),
  });

  // Also not a toggle: what it switches between is two lists, not on and off.
  add({
    id: "chatScope",
    group: "Agent",
    label: "Chat search scope",
    value: s.chatScope === "all" ? "every repository" : "this repository",
    terms: "palette hash conversation scope everywhere across search chats",
    run: () => set({ chatScope: s.chatScope === "all" ? "repo" : "all" }),
  });

  add({
    id: "split",
    group: "Go",
    label: p.splitOpen ? "Close the split" : "Split — another file beside this one",
    terms: "pane side by side two editors column",
    run: p.onSplit,
  });
  if (p.splitOpen) {
    add({
      id: "split.dir",
      group: "Go",
      label: "Split the other way",
      terms: "pane horizontal vertical direction",
      run: p.onSplitDir,
    });
    add({
      id: "split.swap",
      group: "Go",
      label: "Swap the panes",
      hint: "each side's tabs trade places",
      terms: "switch order exchange left right flip",
      run: p.onSwapPanes,
    });
    // The override, spelled out: the switch is global, these pin one pane —
    // the same file rich on one side and raw on the other.
    for (const v of ["write", "source", "diff"] as const) {
      add({
        id: `pane.v.${v}`,
        group: "Go",
        label: `This pane: ${v[0].toUpperCase()}${v.slice(1)}`,
        hint: "override — the other pane keeps its view",
        terms: "pane view only override focused split",
        run: () => p.onPaneView(v),
      });
    }
  }
  if (p.canSplitSame) {
    add({
      id: "split.same",
      group: "Go",
      label: "Open this document in both panes",
      hint: "two views of one file",
      terms: "duplicate same side by side compare source",
      run: p.onSplitSame,
    });
  }
  add({
    id: "shortcuts",
    group: "Go",
    label: "Keyboard shortcuts",
    terms: "keys keymap bindings hotkeys rebind customise",
    run: p.onShortcuts,
  });

  add({
    id: "diffStyle",
    group: "Diff",
    label: `Diff layout: ${s.diffStyle === "unified" ? "side by side" : "unified"}`,
    value: s.diffStyle,
    run: () => set({ diffStyle: s.diffStyle === "unified" ? "split" : "unified" }),
  });

  // Hints from the registry, where a binding exists — rendered, never typed.
  for (const c of out) {
    const bound = p.keymap.find((k) => k.id === c.id);
    if (bound) c.hint = renderKeys(bound.keys) || undefined;
  }

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
  }, [isText, term, props.settings.showAllFiles]);

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
        run: () => props.searchRepo && props.onOpenAt(props.searchRepo, h.relPath, h.line, term),
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
    if (row.kind === "cmd") {
      track("palette_command_run", {
        command: commandName(row.key),
        group: row.sub,
        typed: q.length > 0,
        position: i,
      });
    } else {
      track("palette_file_opened", { typed: q.length > 0, position: i });
    }
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
            {/* The markdown/all switch, right where its effect is visible. It
                is the same setting as the tree's "show all files", so the two
                can never disagree about what a "file" is. */}
            {!isCmd && !isChat && (
              <button
                className="palette-scope"
                // Keep the keyboard in the search box across the click.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => props.set({ showAllFiles: !props.settings.showAllFiles })}
                title={
                  props.settings.showAllFiles
                    ? "Searching every file — click for markdown only"
                    : "Searching markdown only — click for every file"
                }
              >
                {props.settings.showAllFiles ? "all files" : "markdown"}
              </button>
            )}
          </span>
          <span>↑↓ move · ⏎ run · esc close</span>
        </div>
      </div>
    </div>
  );
}
