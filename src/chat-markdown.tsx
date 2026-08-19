/**
 * Just enough markdown for a chat bubble.
 *
 * Not Milkdown: that is an editor, and a second instance of it per message
 * would be absurd for text nobody edits. Not `dangerouslySetInnerHTML`
 * either — this renders text an agent produced, which is text a *file*
 * produced, and injecting that into the DOM as markup is how a plan file ends
 * up executing something.
 *
 * So: React elements, built from four things that actually show up in an
 * agent's prose — fenced code, inline code, bold, and bullet or numbered
 * lists. Anything else is left as the characters the agent typed, which is
 * the honest failure for a renderer this small.
 */
import type { ReactNode } from "react";

/** `**bold**` and `` `code` ``, which can appear mid-sentence. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > at) out.push(text.slice(at, m.index));
    if (m[1]) out.push(<code key={`${key}-${m.index}`}>{m[1].slice(1, -1)}</code>);
    else out.push(<strong key={`${key}-${m.index}`}>{m[2].slice(2, -2)}</strong>);
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let list: string[] | null = null;
  let fence: string[] | null = null;

  const flushList = () => {
    if (!list) return;
    blocks.push(
      <ul key={`l${blocks.length}`} className="chat-md-list">
        {list.map((li, i) => (
          <li key={i}>{inline(li, `${blocks.length}-${i}`)}</li>
        ))}
      </ul>,
    );
    list = null;
  };

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (fence) {
        blocks.push(
          <pre key={`f${blocks.length}`} className="chat-md-code">
            {fence.join("\n")}
          </pre>,
        );
        fence = null;
      } else {
        flushList();
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    const bullet = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      list = list ?? [];
      list.push(bullet[1]);
      continue;
    }
    flushList();
    if (!line.trim()) continue;
    blocks.push(
      <p key={`p${blocks.length}`} className="chat-md-p">
        {inline(line, `p${blocks.length}`)}
      </p>,
    );
  }
  flushList();
  // An unterminated fence is still code; the answer was cut off, not malformed.
  if (fence?.length) {
    blocks.push(
      <pre key={`f${blocks.length}`} className="chat-md-code">
        {fence.join("\n")}
      </pre>,
    );
  }
  return <>{blocks}</>;
}
