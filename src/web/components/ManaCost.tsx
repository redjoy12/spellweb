const SIMPLE_COLORS = new Set(['W', 'U', 'B', 'R', 'G']);

/**
 * Parses one `{X}` token from a Scryfall-style mana cost string into a
 * `.pip` variant + label. Handles generic numbers, X/Y/Z, colorless (C),
 * snow (S), and falls back to a generic pip carrying the raw token text for
 * hybrid/Phyrexian tokens (e.g. `{W/U}`, `{2/W}`, `{W/P}`) — never crashes,
 * never renders raw braces.
 */
function pipFor(token: string): { cls: string; label: string } {
  const inner = token.slice(1, -1);
  const upper = inner.toUpperCase();

  if (SIMPLE_COLORS.has(upper)) {
    return { cls: `pip pip-${upper.toLowerCase()}`, label: upper };
  }
  if (/^\d+$/.test(inner)) {
    return { cls: 'pip pip-c', label: inner };
  }
  if (upper === 'X' || upper === 'Y' || upper === 'Z' || upper === 'C' || upper === 'S') {
    return { cls: 'pip pip-c', label: upper };
  }
  // Hybrid / Phyrexian / other unusual tokens: generic pip, raw token text.
  return { cls: 'pip pip-c', label: inner };
}

export function ManaCost({ cost, className }: { cost: string | null | undefined; className?: string }) {
  if (!cost) return null;
  const tokens = cost.match(/\{[^}]+\}/g);
  if (!tokens || tokens.length === 0) return null;

  return (
    <span className={className ? `mana ${className}` : 'mana'}>
      {tokens.map((token, i) => {
        const { cls, label } = pipFor(token);
        return (
          <span className={cls} key={`${token}-${i}`}>
            {label}
          </span>
        );
      })}
    </span>
  );
}

export function IdentityPips({ identity }: { identity: string[] }) {
  if (identity.length === 0) return <span className="muted">—</span>;
  return (
    <span className="mana">
      {identity.map((c) => (
        <span className={`pip pip-${c.toLowerCase()} identity-pip`} key={c}>
          {c}
        </span>
      ))}
    </span>
  );
}
