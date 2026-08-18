/**
 * The command palette.
 *
 * Two modes, in the manner of VS Code: plans by default, commands when the
 * query opens with ">". Everything in Settings is reachable here, so the
 * palette is a second face on the same state rather than a separate feature.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { PlanFile, RepoInfo } from "./api";
import { displayName } from "./FileTree";
import { FONTS, MONO_FONTS } from "./fonts";
import { RANGES, type Settings } from "./settings";
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
  /** Search inside files, for the "?" mode. */
  onSearch: (query: string) => Promise<{ relPath: string; line: number; text: string }[]>;
  onOpenAt: (repoPath: string, relPath: string) => void;
  searchRepo: string | null;
  onPerf: () => void;
  /** Built in App, since they need the repo, its status and its branches. */
  gitCommands: { id: string; label: string; hint?: string; run: () => void }[];
  canNewFolder: boolean;
  onNewFolder: () => void;
  canRename: boolean;
  onRename: () => void;
  onMoveFile: () => void;
  canInsertHtml: boolean;
  onInsertHtml: () => void;
  hasMatter: boolean;
  canEdit: boolean;
  onMatter: () => void;
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
  if (p.canEdit) {
    add({
      id: "matter",
      group: "Plans",
      label: p.hasMatter ? "Edit frontmatter" : "Add frontmatter",
      run: p.onMatter,
    });
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
    hint: "⌘D",
    run: () => p.onView("diff"),
  });
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
  ) => {
    const r = RANGES[key];
    const cur = s[key];
    const show = (n: number) => `${Number(n.toFixed(2))}${unit}`;
    add({
      id: `${key}.up`,
      group,
      label: `${label}: increase`,
      value: show(cur),
      run: () => set({ [key]: Math.min(r.max, cur + r.step) } as Partial<Settings>),
    });
    add({
      id: `${key}.down`,
      group,
      label: `${label}: decrease`,
      value: show(cur),
      run: () => set({ [key]: Math.max(r.min, cur - r.step) } as Partial<Settings>),
    });
  };
  nudge("size", "Typeface", "Size", "px");
  nudge("measure", "Typeface", "Line length", "ch");
  nudge("leading", "Typeface", "Line height");
  nudge("codeSize", "Typeface", "Code size", "px");
  nudge("watchSeconds", "Panels", "Outside-edit check", "s");
  nudge("treeSize", "Files", "Tree text size", "px");

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
      | "sourceLineNumbers"
      | "sourceWrap"
      | "showIndex"
      | "showGit"
      | "showStatusBar",
    group: string,
    label: string,
    hint?: string,
    terms?: string,
  ) =>
    add({
      id: key,
      group,
      label: `${label}: turn ${s[key] ? "off" : "on"}`,
      value: onOff(s[key]),
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
  toggle("showStatusBar", "Panels", "Status bar");

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

  const isCmd = q.startsWith(">");
  /** "?" searches inside files, the way ">" searches commands. */
  const isText = q.startsWith("?");
  const term = isCmd || isText ? q.slice(1).trim() : q.trim();

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
  }, [isCmd, isText, hits, term, commands, props.files, props.onOpenFile]);

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
          placeholder="Find a file · > commands · ? search inside"
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
          <span>{isCmd ? "Commands" : isText ? "Inside files" : "Files"}</span>
          <span>↑↓ move · ⏎ run · esc close</span>
        </div>
      </div>
    </div>
  );
}
