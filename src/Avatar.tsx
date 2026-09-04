/**
 * A face, or the letter that stands in for one.
 *
 * Auth0 hands the server a picture for most accounts; a dev login and some
 * tenants have none, so the fallback is the first letter of the name on the
 * colour the person's cursor already wears. Small by default: this sits
 * beside a file name and in the page head, where it is a mark, not a
 * portrait.
 */
export type Face = { name: string; color: string; avatar?: string | null };

export function Avatar({ who, size = 18 }: { who: Face; size?: number }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.55) };
  return who.avatar ? (
    <img className="avatar" src={who.avatar} alt="" title={who.name} style={style} referrerPolicy="no-referrer" />
  ) : (
    <span className="avatar" title={who.name} style={{ ...style, background: who.color }} aria-hidden>
      {(who.name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

/** A row of faces, each once, for everyone in a place. */
export function Faces({ who, size = 18 }: { who: Face[]; size?: number }) {
  if (who.length === 0) return null;
  return (
    <span className="presence" aria-label={`Here: ${who.map((w) => w.name).join(", ")}`}>
      {who.map((w, i) => (
        <Avatar key={`${w.name}:${i}`} who={w} size={size} />
      ))}
    </span>
  );
}
