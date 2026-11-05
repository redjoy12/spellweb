import { useEffect, useState } from 'react';
import { api, type PacketGlossaryTerm, type PacketSection, type RulesPacket } from '../api.js';

/**
 * The server always returns these two extra fields; api.ts's `RulesPacket` intentionally
 * omits them from the "full" call's declared type; here we need `coreOmitted` to know
 * whether the currently-held `core` sections carry real rule text.
 */
interface PacketResponse extends RulesPacket {
  coreOmitted: boolean;
}

async function fetchPacketCoreOmitted(oracleId: string): Promise<PacketResponse> {
  const res = await fetch(`/api/cards/${oracleId}/packet?core=false`);
  if (!res.ok) throw new Error(`packet fetch → HTTP ${res.status}`);
  return res.json() as Promise<PacketResponse>;
}

function SectionBlock({ section }: { section: PacketSection }) {
  return (
    <div className="psection">
      <h4>
        <span className="num">{section.number}</span> {section.title}
      </h4>
      {section.rules.map((rule) => (
        <div className="prule" key={rule.number}>
          <span className="pnum">{rule.number}</span>
          <span className="ptext">{rule.text}</span>
        </div>
      ))}
    </div>
  );
}

function GlossaryRow({ entry }: { entry: PacketGlossaryTerm }) {
  return (
    <div className="prule pgloss">
      <span className="pnum">
        {entry.term}
        {entry.surface.toLowerCase() !== entry.term.toLowerCase() && <span className="pmatch">matched “{entry.surface}”</span>}
      </span>
      <span className="ptext">{entry.definition}</span>
    </div>
  );
}

/** Rule numbers in reading order: 100.1 < 100.1a < 100.2 < 100.10. */
function compareRuleNumbers(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

export function PacketView({ oracleId }: { oracleId: string }) {
  const [packet, setPacket] = useState<PacketResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [coreExpanded, setCoreExpanded] = useState(false);
  const [coreLoaded, setCoreLoaded] = useState(false);
  const [loadingCore, setLoadingCore] = useState(false);

  useEffect(() => {
    setPacket(null);
    setError(null);
    setCoreExpanded(false);
    setCoreLoaded(false);
    fetchPacketCoreOmitted(oracleId)
      .then(setPacket)
      .catch((e) => setError((e as Error).message));
  }, [oracleId]);

  const handleCoreToggle = (open: boolean) => {
    setCoreExpanded(open);
    if (open && !coreLoaded) {
      setLoadingCore(true);
      api
        .packet(oracleId)
        .then((full) => {
          setPacket({ ...full, coreOmitted: false });
          setCoreLoaded(true);
        })
        .catch((e) => setError((e as Error).message))
        .finally(() => setLoadingCore(false));
    }
  };

  if (error) return <div className="error-block">Failed to load rules packet: {error}</div>;
  if (!packet) return <p className="muted">Loading rules packet…</p>;

  const coreTokens = Math.round(packet.coreChars / 3.6);
  const cardTokens = Math.round(packet.cardChars / 3.6);
  const glossaryTokens = Math.round(packet.glossaryChars / 3.6);
  const whitelist = [...packet.packetRules].sort(compareRuleNumbers);

  return (
    <section className="packet-view">
      <div className="packet-summary three">
        <div className="packet-stat">
          <div className="big">
            {packet.cardChars.toLocaleString()} <small>chars · ~{cardTokens.toLocaleString()} tokens</small>
          </div>
          <div className="lbl">Card-specific · {packet.cardSpecific.length} sections</div>
        </div>
        <div className="packet-stat">
          <div className="big">
            {packet.glossaryChars.toLocaleString()} <small>chars · ~{glossaryTokens.toLocaleString()} tokens</small>
          </div>
          <div className="lbl">Glossary · {packet.glossary.length} terms</div>
        </div>
        <div className="packet-stat">
          <div className="big">
            {packet.coreChars.toLocaleString()} <small>chars · ~{coreTokens.toLocaleString()} tokens</small>
          </div>
          <div className="lbl">Core packet · {packet.core.length} sections</div>
        </div>
      </div>
      <p className="packet-note">
        This is the scoped packet Phase 2 extraction sends for this card <code>(§3.3–3.5)</code>: {packet.packetChars.toLocaleString()} chars in all.
        The core packet (the kernel, derived from golden-set citations <code>(§3.4)</code>) is byte-identical for every card and is therefore a cacheable constant prefix <code>(§5.3)</code>.
        Corpus effective {packet.effectiveDate}.
      </p>

      {packet.unresolvedKeywords.length > 0 && (
        <div className="warning-block">
          These keywords produced no rule section. The packet is incomplete for this card.
          <ul>
            {packet.unresolvedKeywords.map((kw) => (
              <li key={kw}>{kw}</li>
            ))}
          </ul>
        </div>
      )}

      {packet.missingRules.length > 0 && (
        <div className="error-block">
          The packet kernel or a derived map names rules that do not exist in this corpus (re-run npm run kernel:derive): {packet.missingRules.join(', ')}
        </div>
      )}

      <details className="pgroup card-add" open>
        <summary>
          <span className="caret">▶</span>
          Card-specific additions
          <span className="tag">
            · {packet.cardSpecific.length} sections · {packet.cardChars} chars
          </span>
        </summary>
        <div className="pbody">
          {packet.cardSpecific.length === 0 ? (
            <p className="muted">No card-specific additions for this card.</p>
          ) : (
            packet.cardSpecific.map((section) => <SectionBlock key={section.number} section={section} />)
          )}
        </div>
      </details>

      <details className="pgroup glossary" open>
        <summary>
          <span className="caret">▶</span>
          Glossary terms
          <span className="tag">
            · {packet.glossary.length} terms · {packet.glossaryChars} chars
          </span>
        </summary>
        <div className="pbody">
          {packet.glossary.length === 0 ? (
            <p className="muted">No glossary terms matched this card's text.</p>
          ) : (
            packet.glossary.map((entry) => (
              <GlossaryRow key={`${entry.term}: ${entry.definition}`} entry={entry} />
            ))
          )}
        </div>
      </details>

      <details className="pgroup core" open={coreExpanded} onToggle={(e) => handleCoreToggle(e.currentTarget.open)}>
        <summary>
          <span className="caret">▶</span>
          Core packet
          <span className="tag">
            · {packet.core.length} sections · {packet.coreChars} chars
          </span>
        </summary>
        <div className="pbody">
          {loadingCore && <p className="muted">Loading core rule text…</p>}
          {!coreExpanded && !loadingCore && (
            <div className="core-collapsed">
              <span className="lock">◆</span> ~{coreTokens.toLocaleString()} tokens — identical constant for every card. Expand
              to load the full core rule text.
            </div>
          )}
          {coreExpanded && !loadingCore && packet.core.map((section) => <SectionBlock key={section.number} section={section} />)}
        </div>
      </details>

      <details className="pgroup whitelist">
        <summary>
          <span className="caret">▶</span>
          Rule-number whitelist
          <span className="tag">· {whitelist.length} citable numbers · gate 4</span>
        </summary>
        <div className="pbody">
          <p className="muted pwl-note">
            Every rule number whose text this packet carried. An extracted atom citing a rule outside
            this list is rejected.
          </p>
          <div className="pwl">
            {whitelist.map((n) => <span className="pwl-num" key={n}>{n}</span>)}
          </div>
        </div>
      </details>
    </section>
  );
}
