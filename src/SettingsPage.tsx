import type { ReactNode } from "react";
import { FONTS } from "./fonts";
import { THEMES } from "./theme";
import { DEFAULTS, RANGES, type Settings } from "./settings";
import type { RepoInfo } from "./api";

type Props = {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onReset: () => void;
  repos: RepoInfo[];
  activeRepoPath: string | null;
  onAddRepo: () => void;
  onForgetRepo: (path: string) => void;
};

export function SettingsPage({
  settings: s,
  onChange,
  onReset,
  repos,
  activeRepoPath,
  onAddRepo,
  onForgetRepo,
}: Props) {
  return (
    <div className="settings">
      <div className="settings-inner">
        <header className="settings-head">
          <h1 className="settings-title">Settings</h1>
          <button className="rail-btn" onClick={onReset}>
            Reset to defaults
          </button>
        </header>

        {/* ---- paper ---------------------------------------------------- */}
        <Group name="Paper" hint="Applies to the whole app, not just the page.">
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
          hint="Five open-source families from Open Foundry, bundled with the app."
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

        <Group name="Measure">
          <Slider
            label="Text size"
            value={s.size}
            display={`${s.size}px`}
            {...RANGES.size}
            onChange={(size) => onChange({ size })}
          />
          <Slider
            label="Line length"
            value={s.measure}
            display={`${s.measure} characters`}
            {...RANGES.measure}
            onChange={(measure) => onChange({ measure })}
          />
          <Slider
            label="Line height"
            value={s.leading}
            display={s.leading.toFixed(2)}
            {...RANGES.leading}
            onChange={(leading) => onChange({ leading })}
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
        </Group>

        {/* ---- changes -------------------------------------------------- */}
        <Group
          name="Changes"
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

        {/* ---- panels --------------------------------------------------- */}
        <Group name="Panels">
          <Toggle
            label="Git panel"
            hint="⌘G. The index marks changed plans whether it's open or not."
            on={s.showGit}
            onChange={(showGit) => onChange({ showGit })}
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

        {/* ---- library -------------------------------------------------- */}
        <Group
          name="Repositories"
          hint="Forgetting a repository removes it from this list only. Nothing on disk changes."
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
              <button className="act" onClick={() => onForgetRepo(r.path)}>
                Forget
              </button>
            </div>
          ))}
          <button className="new-plan" onClick={onAddRepo}>
            Add a repository
          </button>
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
  return (
    <section className="settings-group">
      <div className="settings-aside">
        <span className="tag">{name}</span>
        {hint && <p className="settings-hint">{hint}</p>}
      </div>
      <div className="settings-body">{children}</div>
    </section>
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
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="setting-row static">
      <span className="setting-label">{label}</span>
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
  value,
  display,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="setting-row static">
      <span className="setting-label">
        {label}
        <span className="setting-hint">{display}</span>
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
