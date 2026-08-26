import { createContext, isValidElement, useContext, useState, type ReactNode } from "react";
import { FONTS, MONO_FONTS } from "./fonts";
import { THEMES } from "./theme";
import { DEFAULTS, RANGES, type Settings } from "./settings";
import type { AgentFound, CliStatus, RepoInfo } from "./api";
import type { SkillState } from "./skill";

type Props = {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onReset: () => void;
  repos: RepoInfo[];
  activeRepoPath: string | null;
  onAddRepo: () => void;
  onForgetRepo: (path: string) => void;
  /** Write the bundled agent skill into this repository. */
  onInstallSkill: (path: string) => void;
  /** What each repository already has, by path — absent while still looking. */
  skills: Record<string, SkillState>;
  onInstallCli: () => void;
  /** `npm i -g` the chosen agent. */
  onInstallAgent: (id: string) => void;
  /** The installed `plans` script, null when there is none. */
  cli: CliStatus | null;
  /** Which known agents are on this machine. */
  agents: AgentFound[];
  /** The version actually running, and the two things you can do about it. */
  version: string;
  onCheckUpdates: () => void;
  onReleaseNotes: () => void;
  /** Open the Keyboard page, which lives beside this one. */
  onKeyboard: () => void;
  /** Where settings.json is on this machine — empty until it has been read. */
  settingsFilePath: string;
  /** Hand settings.json to whatever edits JSON here. */
  onOpenSettingsFile: () => void;
};

/**
 * The filter query, read by Group so each control can hide itself.
 *
 * Controls all take `label` and `hint`, so matching can be done on their props
 * rather than threading a prop through every call site.
 */
const Query = createContext("");

/** Does this element's own text match? Elements without labels never do. */
function matches(node: ReactNode, q: string): boolean {
  if (!q) return true;
  if (!isValidElement(node)) return false;
  const p = node.props as { label?: string; hint?: string };
  return `${p.label ?? ""} ${p.hint ?? ""}`.toLowerCase().includes(q);
}

export function SettingsPage({
  settings: s,
  onChange,
  onReset,
  repos,
  activeRepoPath,
  onAddRepo,
  onForgetRepo,
  onInstallSkill,
  skills,
  onInstallCli,
  onInstallAgent,
  cli,
  agents,
  version,
  onCheckUpdates,
  onReleaseNotes,
  onKeyboard,
  settingsFilePath,
  onOpenSettingsFile,
}: Props) {
  const [q, setQ] = useState("");

  /**
   * Which agents the conventions are being installed for.
   *
   * The row used to name a path, which was Claude Code's and nobody else's —
   * and said nothing about the three agents that would never read it. The
   * agents on this machine are the honest answer to what pressing the button
   * does.
   */
  const here = agents.filter((a) => a.ready && a.conventions.length);
  const conventionsFor = here.length
    ? `For ${here.map((a) => a.label).join(", ")} — written where each of them looks`
    : "No agent found on this machine; the conventions go where Claude Code looks";

  return (
    <div className="settings">
      <Query.Provider value={q}>
      <div className="settings-inner">
        <header className="settings-head">
          <h1 className="settings-title">Settings</h1>
          <button className="rail-btn" onClick={onReset}>
            Reset to defaults
          </button>
        </header>

        <input
          className="settings-filter"
          value={q}
          placeholder="Search settings"
          spellCheck={false}
          autoFocus
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && q) {
              e.preventDefault();
              e.stopPropagation();
              setQ("");
            }
          }}
        />

        {/* ---- paper ---------------------------------------------------- */}
        <Group
          name="Paper"
          hint="The theme — light or dark — for the whole app, not just the page."
        >
          <div className="papers wide">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`paper-swatch ${t.id === s.theme ? "on" : ""}`}
                onClick={() => onChange({ theme: t.id })}
                aria-pressed={t.id === s.theme}
              >
                <span
                  className="specimen"
                  style={{ background: t.swatch.paper, color: t.swatch.ink }}
                >
                  Aa
                </span>
                {t.label}
              </button>
            ))}
          </div>
        </Group>

        {/* ---- type ----------------------------------------------------- */}
        <Group
          name="Typeface"
          hint="The reading font. Five open-source families from Open Foundry, bundled with the app."
        >
          <div className="faces">
            {FONTS.map((f) => (
              <button
                key={f.id}
                className={`face ${f.id === s.fontId ? "on" : ""}`}
                onClick={() => onChange({ fontId: f.id })}
                aria-pressed={f.id === s.fontId}
              >
                <span>
                  <span className="face-name" style={{ fontFamily: f.stack }}>
                    {f.label}
                  </span>
                  <span className="face-note">
                    {f.note} · {f.designer}
                  </span>
                </span>
                <span className="face-check">●</span>
              </button>
            ))}
          </div>
        </Group>

        <Group
          name="Monospace"
          hint="The mono font: the chrome, the source view, and code blocks."
        >
          <div className="faces">
            {MONO_FONTS.map((m) => (
              <button
                key={m.id}
                className={`face ${m.id === s.monoId ? "on" : ""}`}
                onClick={() => onChange({ monoId: m.id })}
                aria-pressed={m.id === s.monoId}
              >
                <span>
                  <span className="face-name" style={{ fontFamily: m.stack }}>
                    {m.label}
                  </span>
                  <span className="face-note">{m.note}</span>
                </span>
                <span className="face-check">●</span>
              </button>
            ))}
          </div>
        </Group>

        <Group name="Measure">
          <Slider
            label="Text size"
            value={s.size}
            display={`${s.size}px`}
            {...RANGES.size}
            onChange={(size) => onChange({ size })}
            fallback={DEFAULTS.size}
          />
          <Slider
            label="Line length"
            value={s.measure}
            display={`${s.measure} characters`}
            {...RANGES.measure}
            onChange={(measure) => onChange({ measure })}
            fallback={DEFAULTS.measure}
          />
          <Slider
            label="Line height"
            value={s.leading}
            display={s.leading.toFixed(2)}
            {...RANGES.leading}
            onChange={(leading) => onChange({ leading })}
            fallback={DEFAULTS.leading}
          />
          <Slider
            label="Code size"
            value={s.codeSize}
            display={`${s.codeSize}px · code blocks, inline code, the source view`}
            {...RANGES.codeSize}
            onChange={(codeSize) => onChange({ codeSize })}
            fallback={DEFAULTS.codeSize}
          />
          <div className="specimen-block">
            A plan is mostly prose. Set it so a paragraph reads without effort,
            then leave it alone.
          </div>
        </Group>

        {/* ---- writing -------------------------------------------------- */}
        <Group name="Writing">
          <Toggle
            label="Check spelling"
            hint="Uses the system dictionary."
            on={s.spellcheck}
            onChange={(spellcheck) => onChange({ spellcheck })}
          />
          <Choice
            label="Autosave"
            value={s.autosave}
            options={[
              { value: "afterDelay", label: "After a pause" },
              { value: "onBlur", label: "On focus loss" },
              { value: "manual", label: "Manual" },
            ]}
            onChange={(autosave) =>
              onChange({ autosave: autosave as "afterDelay" | "onBlur" | "manual" })
            }
            hint={
              s.autosave === "manual"
                ? "⌘S only. Switching files still writes what's pending."
                : s.autosave === "onBlur"
                  ? "Writes when the window loses focus, or on ⌘S."
                  : undefined
            }
          />
          {s.autosave === "afterDelay" && (
            <Slider
              label="Pause before saving"
              value={s.autosaveDelay}
              display={`${s.autosaveDelay.toFixed(1)} seconds`}
              {...RANGES.autosaveDelay}
              onChange={(autosaveDelay) => onChange({ autosaveDelay })}
              fallback={DEFAULTS.autosaveDelay}
            />
          )}
        </Group>

        {/* ---- files ------------------------------------------------------ */}
        <Group name="Files" hint="What the sidebar tree down the left shows.">
          <Toggle
            label="File extensions"
            hint="Off shows 'auth plan' rather than 'auth-plan.md'."
            on={s.showExtensions}
            onChange={(showExtensions) => onChange({ showExtensions })}
          />
          <Toggle
            label="Gitignored files"
            hint="Markdown that .gitignore excludes is hidden by default."
            on={s.showIgnored}
            onChange={(showIgnored) => onChange({ showIgnored })}
          />
          <Toggle
            label="All files"
            hint="Every text file, not only the markdown. Anything that is not markdown opens in Source."
            on={s.showAllFiles}
            onChange={(showAllFiles) => onChange({ showAllFiles })}
          />
          <Slider
            label="Tree width"
            value={s.treeWidth}
            display={`${s.treeWidth}px`}
            {...RANGES.treeWidth}
            onChange={(treeWidth) => onChange({ treeWidth })}
            fallback={DEFAULTS.treeWidth}
          />
          <Slider
            label="Tree text size"
            value={s.treeSize}
            display={`${s.treeSize}px`}
            {...RANGES.treeSize}
            onChange={(treeSize) => onChange({ treeSize })}
            fallback={DEFAULTS.treeSize}
          />
          <Field
            label="Image folder"
            hint="Where a pasted image is written, from the repository root."
            value={s.imageFolder}
            placeholder="assets"
            onChange={(imageFolder) => onChange({ imageFolder })}
          />
          <Toggle
            label="Frontmatter block"
            hint="Keeps YAML out of the page, behind a header button. Off leaves it in the editor."
            on={s.showFrontmatter}
            onChange={(showFrontmatter) => onChange({ showFrontmatter })}
          />
          <TagsField
            label="Statuses"
            hint="What the palette offers for status:. Files may still say anything."
            value={s.statuses}
            onChange={(statuses) => onChange({ statuses })}
          />
        </Group>

        {/* ---- source ---------------------------------------------------- */}
        <Group name="Source" hint="The raw markdown, behind ⌘2.">
          <Toggle
            label="Line numbers"
            on={s.sourceLineNumbers}
            onChange={(sourceLineNumbers) => onChange({ sourceLineNumbers })}
          />
          <Toggle
            label="Wrap long lines"
            hint="Off runs lines to the window edge and scrolls sideways, ignoring the line length."
            on={s.sourceWrap}
            onChange={(sourceWrap) => onChange({ sourceWrap })}
          />
        </Group>

        {/* ---- changes -------------------------------------------------- */}
        <Group
          name="Diff"
          hint="How the diff against the last commit is drawn."
        >
          <Choice
            label="Layout"
            value={s.diffStyle}
            options={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Side by side" },
            ]}
            onChange={(diffStyle) =>
              onChange({ diffStyle: diffStyle as Settings["diffStyle"] })
            }
          />
          <Toggle
            label="Line numbers"
            on={s.diffLineNumbers}
            onChange={(diffLineNumbers) => onChange({ diffLineNumbers })}
          />
          <Toggle
            label="Wrap long lines"
            hint="Off scrolls sideways instead."
            on={s.diffWrap}
            onChange={(diffWrap) => onChange({ diffWrap })}
          />
          <Toggle
            label="Show the whole file"
            hint="Off shows only changed passages with a few lines of context."
            on={s.diffExpandUnchanged}
            onChange={(diffExpandUnchanged) => onChange({ diffExpandUnchanged })}
          />
          <Toggle
            label="Update as I type"
            hint="Off compares against what's saved on disk instead."
            on={s.diffLive}
            onChange={(diffLive) => onChange({ diffLive })}
          />
        </Group>

        {/* ---- agents ----------------------------------------------------
            Everything about the agent in one place: which one, what it is
            told, where its answers appear. The controls were scattered
            between here and Panels, which made the chat look like a piece of
            window furniture rather than the thing it is. */}
        <Group
          name="Agents"
          hint="The chat panel talks to an agent CLI headlessly, one turn per message. It never commits, and its edits land in files where git can see them."
        >
          {/*
            * A list, not a text field: the app can see which agents are on the
            * machine, and asking someone to type a binary name correctly when
            * it could offer the ones it found is work for its own sake. A name
            * the app does not know is still kept — whatever is configured is
            * always in the list, so nothing is lost by choosing from it.
            */}
          {/*
            * Every agent the app knows, and where you stand with each.
            *
            * A picker plus a separate "not installed" line made you assemble
            * the answer from two places. This is the answer: the four rows,
            * which one is chosen, which are here, and — for the ones that are
            * not — a button rather than a command to copy out.
            */}
          <AgentList
            label="Chat agent"
            hint="Every one of these speaks the Agent Client Protocol, so what it can do — models, effort, commands — comes from the agent rather than from this app."
            agents={agents}
            current={s.chatCommand}
            onChoose={(chatCommand) => onChange({ chatCommand })}
            onInstall={onInstallAgent}
          />
          <Area
            label="Handoff prompt: complete"
            hint="What the agent is told by “Hand off to agent: complete this plan”, from the tree's right-click menu or the palette — flesh the plan out until it is ready. {file} is the plan's path. Yours to argue with — it is the one part of this that is about your house style."
            value={s.handoffPrompt}
            onChange={(handoffPrompt) => onChange({ handoffPrompt })}
            onReset={() => onChange({ handoffPrompt: DEFAULTS.handoffPrompt })}
          />
          <Area
            label="Handoff prompt: implement"
            hint="What the agent is told by “Hand off to agent: implement this plan” — claim it as busy, build what it describes, mark it done. {file} is the plan's path."
            value={s.implementPrompt}
            onChange={(implementPrompt) => onChange({ implementPrompt })}
            onReset={() => onChange({ implementPrompt: DEFAULTS.implementPrompt })}
          />
          <Area
            label="Rewrite prompt"
            hint="What the agent is told by “Rewrite…”, from the right-click menu on selected text. {file} is the file, {quote} the passage you selected, {ask} what you typed, and {lines} a line-range hint that is left out unless the passage appears exactly once."
            value={s.rewritePrompt}
            onChange={(rewritePrompt) => onChange({ rewritePrompt })}
            onReset={() => onChange({ rewritePrompt: DEFAULTS.rewritePrompt })}
          />
          <Field
            label="Copyable command"
            hint="For running a plan by hand in a terminal instead: {prompt} is the instruction, {file} the plan's path."
            value={s.agentCommand}
            placeholder="claude {prompt}"
            onChange={(agentCommand) => onChange({ agentCommand })}
          />
          <Choice
            label="Chat sits"
            hint="A row under the page, or a column beside it. Beside, it and the git panel take turns — they want the same space."
            value={s.chatPlace}
            options={[
              { value: "bottom", label: "Below" },
              { value: "side", label: "Beside" },
            ]}
            onChange={(v) => onChange({ chatPlace: v as "bottom" | "side" })}
          />
          <Choice
            label="Order files by"
            hint="By status uses the vocabulary above, in the order it is written there. A file with an unrecognised status, or none, comes last. Name is the order a tree is read in."
            value={s.treeSort}
            options={[
              { value: "name", label: "Name" },
              { value: "status", label: "Status" },
            ]}
            onChange={(v) => onChange({ treeSort: v as "name" | "status" })}
          />
          <Choice
            label="Palette chats"
            hint="What # in the command palette lists. Across every repository, a chat is labelled with the one it belongs to, and opening it takes you there."
            value={s.chatScope}
            options={[
              { value: "repo", label: "This repository" },
              { value: "all", label: "Every repository" },
            ]}
            onChange={(v) => onChange({ chatScope: v as "repo" | "all" })}
          />
          {s.chatPlace === "side" ? (
            <Slider
              label="Chat width"
              hint="Or drag the panel's left edge."
              value={s.chatWidth}
              display={`${s.chatWidth}px`}
              {...RANGES.chatWidth}
              onChange={(chatWidth) => onChange({ chatWidth })}
            />
          ) : (
            <Slider
              label="Chat height"
              hint="Or drag the panel's top edge."
              value={s.muxHeight}
              display={`${s.muxHeight}px`}
              {...RANGES.muxHeight}
              onChange={(muxHeight) => onChange({ muxHeight })}
            />
          )}
        </Group>

        {/* ---- panels --------------------------------------------------- */}

        <Group name="Panels">
          <Row
            label="Zen"
            hint="⌘⇧L hides everything but the page. Escape brings it back."
          />
          <Toggle
            label="File tree"
            hint="⌘B, or ⌘⌃B while writing. Every open repository's markdown, down the left."
            on={s.showIndex}
            onChange={(showIndex) => onChange({ showIndex })}
          />
          <Toggle
            label="Git panel"
            hint="⌘G. The index marks changed plans whether it's open or not."
            on={s.showGit}
            onChange={(showGit) => onChange({ showGit })}
          />
          <Toggle
            label="Agent chat"
            hint="⌘J. A conversation about the open plan. Each plan keeps its own transcript, resumed when reopened."
            on={s.showMux}
            onChange={(showMux) => onChange({ showMux })}
          />
          {/* Shown/hidden rather than a switch: "off" for a thing called
              "finished plans" reads as though it turns the plans off. */}
          <Choice
            label="Show finished plans"
            hint="Anything marked done, and anything inside a completed/ folder. Hidden is a view of the tree — they stay on disk, and an open tab stays open."
            value={s.showCompleted ? "shown" : "hidden"}
            options={[
              { value: "shown", label: "Shown" },
              { value: "hidden", label: "Hidden" },
            ]}
            onChange={(v) => onChange({ showCompleted: v === "shown" })}
          />
          <Toggle
            label="Status bar"
            on={s.showStatusBar}
            onChange={(showStatusBar) => onChange({ showStatusBar })}
          />
          <Slider
            label="Check for outside edits"
            value={s.watchSeconds}
            display={s.watchSeconds === 0 ? "never" : `every ${s.watchSeconds}s`}
            {...RANGES.watchSeconds}
            onChange={(watchSeconds) => onChange({ watchSeconds })}
          />
        </Group>

        {/* ---- keyboard ------------------------------------------------- */}
        <Group
          name="Keyboard"
          hint="Every shortcut, on its own page: rebind, chords, preset packs. ⌘/ shows the quick reference."
        >
          <div className="setting-row static">
            <span className="setting-label">
              Keyboard shortcuts
              <span className="setting-hint">
                Rebind any command, build ⌘K chords, or choose a preset pack.
              </span>
            </span>
            <button className="act" onClick={onKeyboard}>
              Open
            </button>
          </div>
        </Group>

        {/* ---- updates -------------------------------------------------- */}
        <Group
          name="Updates"
          hint="Plans checks GitHub for a new version of itself. Nothing downloads or installs without a press."
        >
          <Choice
            label="New versions"
            hint="Off means never asking, and never being told."
            value={s.updates}
            options={[
              { value: "notify", label: "Tell me" },
              { value: "off", label: "Off" },
            ]}
            onChange={(v) => onChange({ updates: v as Settings["updates"] })}
          />
          <div className="setting-row static">
            <span className="setting-label">
              Version
              <span className="setting-hint">{version}</span>
            </span>
            <span className="update-settings-acts">
              <button className="act" onClick={onCheckUpdates}>
                Check now
              </button>
              <button className="act quiet" onClick={onReleaseNotes}>
                Release notes
              </button>
            </span>
          </div>
        </Group>

        {/* ---- privacy -------------------------------------------------- */}
        <Group
          name="Privacy"
          hint="Plans counts which features get used, so it can be improved by something other than guesswork. Nobody is identified, and no file name, path, or word of your writing ever leaves this machine."
        >
          <Toggle
            label="Send anonymous usage data"
            hint="Counts and setting names only. Off means nothing is sent at all."
            on={s.telemetry}
            onChange={(telemetry) => onChange({ telemetry })}
          />
        </Group>

        {/* ---- library -------------------------------------------------- */}
        <Group
          name="Repositories"
          hint="Forgetting a repository removes it from this list only. Nothing on disk changes. Install conventions writes the bundled skills — plan-writing and PR review — everywhere the agents on this machine look: Claude Code's .claude/skills/ files, and a fenced section per skill in AGENTS.md or GEMINI.md for the agents that read those."
        >
          {repos.length === 0 && <p className="none">None yet.</p>}
          {repos.map((r) => (
            <div className="repo-row" key={r.path}>
              <span className="repo-row-main">
                <span className="repo-row-name">
                  {r.name}
                  {r.path === activeRepoPath && <em> · open</em>}
                </span>
                <span className="repo-row-path">{r.path}</span>
                <span className="repo-row-dirs">
                  {r.planDirs.length
                    ? r.planDirs.join("   ")
                    : "no plans folder found"}
                </span>
              </span>
              {/* One button, three things to say: the conventions are not
                  there, they are out of date, or they are exactly the bundled
                  ones — in which case there is nothing to press and it says so
                  instead. The tooltip names the agents being installed for,
                  rather than a path, because the path is the app's business and
                  which agent will read it is the reader's. */}
              {skills[r.path] === "current" ? (
                <span className="act done" title={conventionsFor}>
                  Conventions installed
                </span>
              ) : (
                <button className="act" onClick={() => onInstallSkill(r.path)} title={conventionsFor}>
                  {skills[r.path] === "stale" ? "Update conventions" : "Install conventions"}
                </button>
              )}
              <button className="act" onClick={() => onForgetRepo(r.path)}>
                Forget
              </button>
            </div>
          ))}
          <button className="new-plan" onClick={onAddRepo}>
            Add a repository
          </button>
          <div className="setting-row static">
            <span className="setting-label">
              Command line
              <span className="setting-hint">
                Puts a `plans` command on your PATH, so `plans .` in a terminal
                opens that repository here.
              </span>
            </span>
            {cli?.current ? (
              <span className="act done" title={cli.path}>
                Installed
              </span>
            ) : (
              <button className="act" onClick={onInstallCli} title={cli?.path}>
                {cli ? "Update" : "Install"}
              </button>
            )}
          </div>
        </Group>

        {/* ---- the file ------------------------------------------------- */}
        <Group
          name="Settings file"
          hint="Everything on this page is one JSON file, with a schema beside it — so an editor completes the keys and explains them, and the agent in the chat can change your settings by editing a file. Saves outside the app are picked up on the same interval as everything else read from disk."
        >
          <div className="setting-row static">
            <span className="setting-label">
              settings.json
              {/* The config directory differs per platform, so "where is my
                  file" gets an answer here rather than in a document. */}
              <span className="setting-hint">
                {settingsFilePath || "Reading…"}
              </span>
            </span>
            <button className="act" onClick={onOpenSettingsFile}>
              Open settings file (JSON)
            </button>
          </div>
        </Group>

        <Group name="Credits">
          <p className="credit">
            Typefaces are released under the SIL Open Font License and bundled
            with the app: Vollkorn by Friedrich Althausen, Libre Baskerville by
            Impallari Type, Work Sans by Wei Huang, Karla by Jonny Pinhorn, and
            Space Mono by Colophon Foundry. Editing is Milkdown Crepe; diffs are
            rendered with @pierre/diffs.
          </p>
        </Group>
      </div>
      </Query.Provider>
    </div>
  );
}

/* --- pieces -------------------------------------------------------------- */

function Group({
  name,
  hint,
  children,
}: {
  name: string;
  hint?: string;
  children: ReactNode;
}) {
  const q = useContext(Query).trim().toLowerCase();

  // A group whose own name matches keeps all of its contents — that is how the
  // pickers and specimens, which carry no label of their own, stay reachable.
  const wholeGroup = !q || `${name} ${hint ?? ""}`.toLowerCase().includes(q);
  const kids = wholeGroup
    ? children
    : (Array.isArray(children) ? children : [children]).filter((c) => matches(c, q));

  if (!wholeGroup && (kids as ReactNode[]).length === 0) return null;

  return (
    <section className="settings-group">
      <div className="settings-aside">
        <span className="tag">{name}</span>
        {hint && <p className="settings-hint">{hint}</p>}
      </div>
      <div className="settings-body">{kids}</div>
    </section>
  );
}

/** A row that only tells you something — a shortcut, usually. */
function Row({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="setting-row static">
      <span className="setting-label">
        {label}
        <span className="setting-hint">{hint}</span>
      </span>
    </div>
  );
}

/** Every supported agent, what it is called, and whether it is here. */
function AgentList({
  label,
  hint,
  agents,
  current,
  onChoose,
  onInstall,
}: {
  /** Named and explained through props, so the settings filter can find it. */
  label: string;
  hint: string;
  agents: AgentFound[];
  current: string;
  onChoose: (id: string) => void;
  onInstall: (id: string) => void;
}) {
  return (
    <div className="setting-row static tall">
      <span className="setting-label">
        {label}
        <span className="setting-hint">{hint}</span>
      </span>
      <div className="agent-list">
      {agents.map((a) => (
        <div key={a.id} className={`agent-row ${a.id === current ? "on" : ""}`}>
          <button
            className="agent-choose"
            onClick={() => onChoose(a.id)}
            aria-pressed={a.id === current}
            // Choosing one you do not have is allowed: you may be about to
            // install it, and a setting that refuses to hold your answer is
            // more annoying than one that waits for the world to catch up.
          >
            <span className="agent-mark" aria-hidden>
              {a.id === current ? "●" : "○"}
            </span>
            <span className="agent-name">{a.label}</span>
            <span className="agent-state">
              {a.installed ? "installed" : a.ready ? "via npx" : "not installed"}
            </span>
          </button>
          {a.id === current && a.auth && (
            // Said before it bites: every one of these needs signing in, and
            // the failure it produces otherwise names a key rather than a fix.
            <span className="agent-auth">{a.auth}</span>
          )}
          {a.installable && (
            <button className="act" onClick={() => onInstall(a.id)}>
              Install
            </button>
          )}
        </div>
        ))}
      </div>
    </div>
  );
}

/** A short piece of text: a folder name, a path. */
function Field({
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="setting-row static">
      <span className="setting-label">
        {label}
        {hint && <span className="setting-hint">{hint}</span>}
      </span>
      <input
        className="setting-field"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/**
 * A paragraph rather than a line — a prompt, which wants to be read whole.
 * It carries its own reset because a default worth shipping is one people
 * will want back after editing it.
 */
function Area({
  label,
  hint,
  value,
  onChange,
  onReset,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  onReset?: () => void;
}) {
  return (
    <div className="setting-row static tall">
      <span className="setting-label">
        {label}
        {hint && <span className="setting-hint">{hint}</span>}
      </span>
      <span className="setting-area">
        <textarea
          className="setting-field"
          value={value}
          rows={5}
          spellCheck={false}
          aria-label={label}
          onChange={(e) => onChange(e.target.value)}
        />
        {onReset && (
          <button className="setting-reset" onClick={onReset}>
            reset
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * A short list captured one entry at a time: type, Enter, badge. The value is
 * still the comma-separated string the rest of the app reads.
 */
function TagsField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const tags = value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const commit = () => {
    const t = draft.trim().replace(/,+$/, "");
    setDraft("");
    if (!t || tags.some((x) => x.toLowerCase() === t.toLowerCase())) return;
    onChange([...tags, t].join(", "));
  };

  return (
    <div className="setting-row static tags-row">
      <span className="setting-label">
        {label}
        {hint && <span className="setting-hint">{hint}</span>}
      </span>
      <span className="setting-tags">
        {tags.map((t) => (
          <span key={t} className="setting-tag">
            {t}
            <button
              aria-label={`Remove ${t}`}
              onClick={() => onChange(tags.filter((x) => x !== t).join(", "))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="setting-field tags-input"
          value={draft}
          placeholder={tags.length ? "" : "add a status…"}
          spellCheck={false}
          aria-label={label}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit();
            } else if (e.key === "Backspace" && !draft && tags.length) {
              onChange(tags.slice(0, -1).join(", "));
            }
          }}
        />
      </span>
    </div>
  );
}

function Toggle({
  label,
  hint,
  on,
  onChange,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      className="setting-row"
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
    >
      <span className="setting-label">
        {label}
        {hint && <span className="setting-hint">{hint}</span>}
      </span>
      <span className={`switch ${on ? "on" : ""}`} aria-hidden="true">
        <span className="knob" />
      </span>
    </button>
  );
}

function Choice({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <div className="setting-row static">
      <span className="setting-label">
        {label}
        {hint && <span className="setting-hint">{hint}</span>}
      </span>
      <span className="segmented">
        {options.map((o) => (
          <button
            key={o.value}
            className={o.value === value ? "on" : ""}
            onClick={() => onChange(o.value)}
            aria-pressed={o.value === value}
          >
            {o.label}
          </button>
        ))}
      </span>
    </div>
  );
}

function Slider({
  label,
  hint,
  value,
  display,
  min,
  max,
  step,
  onChange,
  fallback,
}: {
  label: string;
  /** Said once beside the number, for sliders whose units need explaining. */
  hint?: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  /** The default. When given and departed from, a reset appears for this one setting. */
  fallback?: number;
}) {
  const moved = fallback !== undefined && value !== fallback;
  return (
    <div className="setting-row static">
      <span className="setting-label">
        {label}
        <span className="setting-hint">
          {display}
          {hint && ` · ${hint}`}
          {moved && (
            <button
              className="setting-reset"
              onClick={() => onChange(fallback)}
              title={`Back to ${fallback}`}
            >
              reset
            </button>
          )}
        </span>
      </span>
      <input
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export { DEFAULTS };
