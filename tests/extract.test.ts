import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/db/client.js';
import {
  validateResponse, persistValidated, parseExtractionResponse, recordFailedCard, buildCardRequest,
  redactionNames, INSTRUCTIONS,
} from '../src/atoms/extract.js';
import { renderBatchPacket } from '../src/atoms/extractBatch.js';
import { loadPacketPolicy } from '../src/rules/relevance.js';
import { fixtureWithClauses } from './helpers/fixture.js';

const TEXT = 'Whenever a creature you control dies, each opponent loses 1 life.';
// The plan's fixture was 'Draw a card. Then draw a card.' with the quote 'Draw a card' - but
// the second occurrence is lower-case, so under sec. 6.2's VERBATIM match the quote occurs
// once and the repeat tests could never pass. 'a card' genuinely occurs twice (ruling R10).
const REPEAT = 'Draw a card. Then draw a card.';
const REPEAT_QUOTE = 'a card';

/** One card, one face, one run, a small enum - shared with tests/verify.test.ts (Task 9). */
function fixture(oracleText = TEXT, name = 'N') {
  return fixtureWithClauses(oracleText, { name });
}

/** The rule numbers the packet actually contained, for gate 4. */
const PACKET_RULES = ['700', '118'];

const atom = (over = {}) => ({
  face_index: 0, family: 'CARES_ABOUT', type_key: 'CREATURE_DEATH',
  params: { controller: 'you' }, quote: 'Whenever a creature you control dies',
  rule_numbers: ['700'], confidence: 0.9, ...over,
});

const draw = (over = {}) =>
  atom({ quote: REPEAT_QUOTE, family: 'PRODUCES', type_key: 'CARD_DRAW', params: {}, ...over });

// Run 4 (golden, 133 cards) scored recall 0.76 / precision 0.69, most of it from subagents
// filling these gaps differently. The packet must keep stating each one.
describe('INSTRUCTIONS - tagging conventions', () => {
  it.each([
    ['ACTIVATE on every activated ability, mana and keyword ones included', /ENABLES ACTIVATE:.*mana abilities.*Equip, Crew, Craft/],
    ['self-ETB triggers tagged, with permanent_type', /ENTERS_BATTLEFIELD:.*OWN entering.*permanent_type/],
    ['"create" gets CREATE only, with an amount (schema v15 item V9)', /"create" gets PRODUCES CREATE only, with amount/],
    ['POWER/TOUGHNESS never for printed stats', /COMBAT POWER and COMBAT TOUGHNESS:.*Never for the card's own printed/],
    ['PERMANENT_COUNT when a count decides something', /PERMANENT_COUNT: when how many permanents/],
    ['TIMING on stated timing limits and Craft', /CONSTRAINTS TIMING:.*Craft/],
    ['EXILE includes self-exile, costs, Craft and airbend', /PRODUCES EXILE:.*itself.*cost.*Craft.*airbend/],
    ['SOLVED on To solve and Solved lines', /ENABLES SOLVED: on each "To solve —" line and on each "Solved —" line/],
    ['TYPE_LINE never for the printed type line', /CONSTRAINTS TYPE_LINE:.*Never for the card's own printed type line/],
    ['reminder text gets no atoms of its own', /Reminder text .*no atoms of its own/],
    // Task 11 R11-10: conventions for the types promoted from run 8-9 unclassified, and the two
    // coverage shapes run 9 left uncovered (modal headers, later sentences of one ability).
    ['prepared gets ENABLES PREPARED', /"Prepared".*ENABLES PREPARED/],
    ['ANTHEM is for sets, STAT_CHANGE for one creature', /COMBAT STAT_CHANGE:.*one creature.*ANTHEM/],
    ['enters tapped gets ENTERS_TAPPED', /CONSTRAINTS ENTERS_TAPPED:.*enters tapped/],
    ['setting base P/T is BASE_PT_SET, never STAT_CHANGE', /COMBAT BASE_PT_SET:.*base power and toughness.*not STAT_CHANGE/],
    ['your own life loss is SELF_LIFE_LOSS', /PRODUCES SELF_LIFE_LOSS:.*you lose.*OPPONENT_LIFE_LOSS/],
    // Task 11, owner decision: "each player" includes you.
    ['each player losing life gets both life-loss types', /"Each player loses N life" gets both PRODUCES SELF_LIFE_LOSS and PRODUCES OPPONENT_LIFE_LOSS/],
    ['a modal header goes to unclassified as MODAL_CHOICE', /"Choose one —".*unclassified.*MODAL_CHOICE/],
    ['every sentence of a multi-sentence ability is covered', /Every sentence.*inside some atom's quote or an unclassified entry/],
    // Task 11 R11-12: run 10's voting dissent was 74% span mismatch - one pass quoting reminder text or a whole
    // keyword line, another not. The golden set already quotes one sentence, never reminder text.
    ['one clause per quote, no reminder text, one keyword of a keyword line', /Quote one clause per atom.*one keyword of a keyword line.*Never include reminder text.*never quote two sentences/],
    ['ACTIVATE quotes the first sentence, cost included', /ENABLES ACTIVATE:.*Quote the ability's first sentence, cost included/],
    ['cite numbered rules, not bare sections', /never a bare three-digit section number that only heads a group of rules/],
    // Task 11 R11-8: run 9's seven cross_card_citation rejections were rules printed only for a neighbour.
    ['a rule shown only for another card is left out, and a clause with no own rule is reported',
      /only under another card.*leave it out.*unjustified_clauses.*name the rule/],
  ])('states: %s', (_label, re) => {
    expect(INSTRUCTIONS).toMatch(re);
  });
});

describe('validateResponse — the four gates of sec. 6.3', () => {
  let db: ReturnType<typeof fixture>;
  beforeEach(() => { db = fixture(); });

  const run = (atoms: unknown[], extra = {}) =>
    validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: PACKET_RULES }, { atoms, ...extra });

  it('accepts an atom whose quote resolves verbatim, deriving its span', () => {
    const r = run([atom()]);
    expect(r.rejected).toHaveLength(0);
    expect(r.atoms).toHaveLength(1);
    expect(TEXT.slice(r.atoms[0]!.span_start, r.atoms[0]!.span_end)).toBe(atom().quote);
  });

  it('gate 3 — rejects an atom whose quote is not present in the face text', () => {
    const r = run([atom({ quote: 'Whenever a creature you control attacks' })]);
    expect(r.atoms).toHaveLength(0);
    expect(r.rejected[0]!.reason).toMatch(/quote/i);
  });

  it('gate 3 — matching is verbatim, so a case-changed quote is rejected', () => {
    const r = run([atom({ quote: 'whenever a creature you control dies' })]);
    expect(r.atoms).toHaveLength(0);
    expect(r.rejected[0]!.reason).toMatch(/quote/i);
  });

  it('gate 3 — rejects a face_index the card does not have', () => {
    const r = run([atom({ face_index: 1 })]);
    expect(r.atoms).toHaveLength(0);
    expect(r.rejected[0]!.reason).toMatch(/face/i);
  });

  it('gate 1 — rejects a type not in the enum at this schema_version', () => {
    const r = run([atom({ type_key: 'NOT_A_REAL_TYPE' })]);
    expect(r.atoms).toHaveLength(0);
    expect(r.rejected[0]!.reason).toMatch(/type/i);
  });

  it('gate 2 — rejects params that fail the type schema', () => {
    const r = run([atom({ params: { controller: 'banana' } })]);
    expect(r.atoms).toHaveLength(0);
    expect(r.rejected[0]!.reason).toMatch(/param/i);
  });

  it('gate 4 — rejects an atom citing a rule that was not in the packet (the I1 signature)', () => {
    const r = run([atom({ rule_numbers: ['704'] })]);   // 704 was never sent
    expect(r.atoms).toHaveLength(0);
    expect(r.rejected[0]!.reason).toMatch(/citation|packet/i);
  });

  it('gate 4 — rejects an atom citing no rule at all: every claim must be traceable (I3)', () => {
    const r = run([atom({ rule_numbers: [] })]);
    expect(r.atoms).toHaveLength(0);
    expect(r.rejected[0]!.reason).toMatch(/citation/i);
  });

  it('rejects a malformed atom item with a reason instead of throwing', () => {
    const r = run([{ face_index: 0, family: 'CARES_ABOUT' }, 'not an object']);
    expect(r.atoms).toHaveLength(0);
    expect(r.rejected).toHaveLength(2);
    expect(r.rejected.every((x) => /shape/i.test(x.reason))).toBe(true);
  });

  it('records a reason for every rejection, so the run can report a rate', () => {
    const r = run([atom({ quote: 'nope' }), atom({ type_key: 'NOPE' })]);
    expect(r.rejected.map((x) => x.reason).every(Boolean)).toBe(true);
  });

  it('stamps every accepted atom with the run, pass, schema version and oracle_hash it was read from', () => {
    const [a] = run([atom()]).atoms;
    expect(a).toMatchObject({
      run_id: 1, pass_index: 0, oracle_id: 'o', schema_version: 1, oracle_hash: 'h',
      confidence: 0.9, confidence_source: 'model', span_ambiguous: 0,
    });
  });
});

describe('validateResponse — sec. 6.2 quote resolution', () => {
  it('accepts two atoms sharing one unambiguous quote — same-clause atoms never collide', () => {
    const db = fixture();
    const q = 'Whenever a creature you control dies';
    const r = validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: PACKET_RULES }, {
      atoms: [atom({ quote: q }), atom({ quote: q, family: 'PRODUCES', type_key: 'CARD_DRAW', params: {} })],
    });
    expect(r.rejected).toHaveLength(0);
    expect(r.atoms).toHaveLength(2);
    expect(r.atoms[0]!.span_start).toBe(r.atoms[1]!.span_start);   // same span, both kept
  });

  it('assigns a repeated quote to occurrences in document order within one pass', () => {
    const db = fixture(REPEAT);
    const r = validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: PACKET_RULES }, {
      atoms: [draw(), draw()],
    });
    expect(r.atoms.map((a) => a.span_start)).toEqual([REPEAT.indexOf(REPEAT_QUOTE), REPEAT.lastIndexOf(REPEAT_QUOTE)]);
    expect(r.atoms[0]!.span_start).toBeLessThan(r.atoms[1]!.span_start);
    expect(r.atoms.every((a) => a.span_ambiguous === 0)).toBe(true);
  });

  it('scopes claiming to (run_id, pass_index) so three voting passes do not invalidate each other', () => {
    const db = fixture(REPEAT);
    const ctx = (passIndex: number) => ({ runId: 1, passIndex, packetRules: PACKET_RULES });
    for (const pass of [0, 1, 2]) {
      const r = validateResponse(db, 'o', ctx(pass), { atoms: [draw(), draw()] });
      expect(r.rejected, `pass ${pass} was rejected`).toHaveLength(0);
      expect(r.atoms.map((a) => a.span_ambiguous), `pass ${pass}`).toEqual([0, 0]);
    }
  });

  it('persists with span_ambiguous when occurrences are exhausted, rather than dropping the atom', () => {
    const db = fixture(REPEAT);
    const three = Array.from({ length: 3 }, () => draw());
    const r = validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: PACKET_RULES }, { atoms: three });
    expect(r.atoms).toHaveLength(3);                       // none dropped
    const ambiguous = r.atoms.filter((a) => a.span_ambiguous === 1);
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]!.span_start).toBe(REPEAT.lastIndexOf(REPEAT_QUOTE)); // the last occurrence
  });

  it('resolves a quote copied from the REDACTED text back to a span of the real text', () => {
    const text = 'When Grizzly Bears enters, draw a card.';
    const db = fixture(text, 'Grizzly Bears');
    const r = validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: PACKET_RULES, names: ['Grizzly Bears'] }, {
      atoms: [draw({ quote: 'When ~ enters, draw a card.' })],
    });
    expect(r.rejected).toHaveLength(0);
    expect(r.atoms[0]!.quote).toBe(text);                  // stored quote slices back from the REAL text
    expect(text.slice(r.atoms[0]!.span_start, r.atoms[0]!.span_end)).toBe(r.atoms[0]!.quote);
  });

  it('resolves a quote whose ~ stands for the card\'s SHORT name - "Katara" for "Katara, ..."', () => {
    const text = 'When Katara enters, draw a card.';
    const db = fixture(text, "Katara, Water Tribe's Hope");
    const r = validateResponse(db, 'o', {
      runId: 1, passIndex: 0, packetRules: PACKET_RULES, names: ["Katara, Water Tribe's Hope"],
    }, { atoms: [draw({ quote: 'When ~ enters, draw a card.' })] });
    expect(r.rejected).toHaveLength(0);
    expect(r.atoms[0]!.quote).toBe(text);
  });

  it('rejects a quote that names the card - the model never saw the name, so it cannot be verbatim', () => {
    const text = 'When Grizzly Bears enters, draw a card.';
    const db = fixture(text, 'Grizzly Bears');
    const r = validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: PACKET_RULES, names: ['Grizzly Bears'] }, {
      atoms: [draw({ quote: 'When Grizzly Bears enters' })],
    });
    expect(r.atoms).toHaveLength(0);
    expect(r.rejected[0]!.reason).toMatch(/quote/i);
  });
});

describe('validateResponse — sec. 7.3 type-line atoms', () => {
  it('accepts a type_line atom with an empty quote at span 0..0, marked params.source', () => {
    const db = fixture('');
    const r = validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: PACKET_RULES }, {
      atoms: [draw({ quote: '', source: 'type_line' })],
    });
    expect(r.rejected).toHaveLength(0);
    expect(r.atoms[0]).toMatchObject({ quote: '', span_start: 0, span_end: 0 });
    expect(JSON.parse(r.atoms[0]!.params_json)).toEqual({ source: 'type_line' });
  });

  it('keeps the exemption narrow: a type_line atom that quotes text is rejected', () => {
    const db = fixture();
    const r = validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: PACKET_RULES }, {
      atoms: [atom({ source: 'type_line' })],
    });
    expect(r.atoms).toHaveLength(0);
    expect(r.rejected[0]!.reason).toMatch(/type_line/);
  });

  it('still rejects an empty quote on an ordinary atom', () => {
    const db = fixture();
    const r = validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: PACKET_RULES }, {
      atoms: [atom({ quote: '' })],
    });
    expect(r.atoms).toHaveLength(0);
    expect(r.rejected[0]!.reason).toMatch(/quote/i);
  });
});

describe('validateResponse — the two escape hatches', () => {
  it('routes unjustified_clauses into missing_rule_reports', () => {
    const db = fixture();
    const r = validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: PACKET_RULES }, {
      atoms: [],
      unjustified_clauses: [{ face_index: 0, quote: 'each opponent loses 1 life',
                              statement: 'no rule defining life loss was supplied' }],
    });
    expect(r.missingRules).toHaveLength(1);
    expect(r.atoms).toHaveLength(0);
  });

  it('keeps a missing-rule report whose quote does not resolve - the channel must not be silenced', () => {
    const db = fixture();
    const r = validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: PACKET_RULES }, {
      atoms: [],
      unjustified_clauses: [{ face_index: 0, quote: 'paraphrased clause', statement: 'needs the layer rules' }],
    });
    expect(r.missingRules).toHaveLength(1);
    expect(r.missingRules[0]!.quote).toBe('paraphrased clause');
  });

  it('routes unfitting clauses into unclassified_clauses, never into atoms', () => {
    const db = fixture();
    const r = validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: PACKET_RULES }, {
      atoms: [],
      unclassified: [{ face_index: 0, quote: 'each opponent loses 1 life',
                       proposed_label: 'OPPONENT_LIFE_LOSS', rationale: 'no enum entry fits' }],
    });
    expect(r.unclassified).toHaveLength(1);
    expect(r.unclassified[0]).toMatchObject({ span_start: TEXT.indexOf('each opponent'), quote: 'each opponent loses 1 life' });
    expect(r.atoms).toHaveLength(0);
  });

  it('rejects an unclassified clause whose quote does not resolve - its span is NOT NULL', () => {
    const db = fixture();
    const r = validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: PACKET_RULES }, {
      atoms: [],
      unclassified: [{ face_index: 0, quote: 'nope', proposed_label: 'X', rationale: 'y' }],
    });
    expect(r.unclassified).toHaveLength(0);
    expect(r.rejected[0]!.reason).toMatch(/unclassified/i);
  });
});

describe('persistValidated', () => {
  it('writes atoms, missing-rule reports and unclassified clauses in one transaction', () => {
    const db = fixture();
    const ctx = { runId: 1, passIndex: 0, packetRules: PACKET_RULES };
    const r = validateResponse(db, 'o', ctx, {
      atoms: [atom()],
      unjustified_clauses: [{ face_index: 0, quote: 'each opponent loses 1 life', statement: 'life loss' }],
      unclassified: [{ face_index: 0, quote: 'each opponent loses 1 life', proposed_label: 'L', rationale: 'r' }],
    });
    persistValidated(db, r);
    const n = (t: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE run_id = 1`).get() as { n: number }).n;
    expect([n('atoms'), n('missing_rule_reports'), n('unclassified_clauses')]).toEqual([1, 1, 1]);
    const row = db.prepare('SELECT * FROM atoms').get() as Record<string, unknown>;
    expect(row).toMatchObject({ oracle_hash: 'h', is_current: 1, confidence_source: 'model' });
    expect(JSON.parse(row['rule_numbers'] as string)).toEqual(['700']);
    expect(db.prepare('SELECT status, oracle_hash FROM missing_rule_reports').get())
      .toMatchObject({ status: 'open', oracle_hash: 'h' });
  });
});

describe('parseExtractionResponse — the top-level shape', () => {
  it('accepts a well-formed body, defaulting absent escape-hatch arrays to empty', () => {
    const p = parseExtractionResponse('{"atoms": []}');
    expect(p).toEqual({ ok: true, value: { atoms: [], unjustified_clauses: [], unclassified: [] } });
  });
  it('rejects invalid JSON', () => {
    expect(parseExtractionResponse('{"atoms": [').ok).toBe(false);
  });
  it('rejects a body without an atoms array', () => {
    expect(parseExtractionResponse('{"items": []}').ok).toBe(false);
  });
});

// ---------- the failure-mode table (Task 8 Step 5, amended) ----------

describe('recordFailedCard', () => {
  it('writes a failed result with its diagnosis and leaves the queue row pending', () => {
    const db = fixture();
    db.exec("INSERT INTO extraction_queue (oracle_id, reason, enqueued_at) VALUES ('o','new_card','t')");
    recordFailedCard(db, 1, 'o', 1234, 'response is not valid JSON');
    expect(db.prepare('SELECT * FROM extraction_results WHERE run_id = 1').get())
      .toMatchObject({ outcome: 'failed', packet_chars: 1234, failure_detail: 'response is not valid JSON' });
    expect(db.prepare("SELECT status FROM extraction_queue WHERE oracle_id='o'").get()).toMatchObject({ status: 'pending' });
  });

  it('truncates the diagnosis so one runaway response cannot bloat the database', () => {
    const db = fixture();
    recordFailedCard(db, 1, 'o', 0, 'x'.repeat(10_000));
    expect((db.prepare('SELECT failure_detail d FROM extraction_results').get() as { d: string }).d).toHaveLength(4000);
  });
});

describe('validateResponse — cross-card citations', () => {
  it('names a citation read off another card in the batch, and still rejects it', () => {
    const db = fixture();
    const r = validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: PACKET_RULES, batchRules: [...PACKET_RULES, '613'] },
      { atoms: [atom({ rule_numbers: ['700', '613'] })] });
    expect(r.atoms).toHaveLength(0);
    expect(r.rejected[0]!.reason).toMatch(/^cross_card_citation: 613/);
  });

  it('keeps the plain citation reason when any cited rule was never shown at all', () => {
    const db = fixture();
    const r = validateResponse(db, 'o', { runId: 1, passIndex: 0, packetRules: PACKET_RULES, batchRules: [...PACKET_RULES, '613'] },
      { atoms: [atom({ rule_numbers: ['613', '704'] })] });
    expect(r.rejected[0]!.reason).toMatch(/^citation: 613, 704/);
  });
});


// ---------- request assembly against the real pool ----------

const live = openDb();
const liveCard = (live.prepare(
  `SELECT c.oracle_id, c.name FROM cards c JOIN card_faces f USING (oracle_id)
    WHERE f.oracle_text LIKE '%' || c.name || '%' AND c.layout = 'normal' ORDER BY c.oracle_id LIMIT 1`,
).get() as { oracle_id: string; name: string } | undefined);
const hasKernel = (live.prepare(
  'SELECT COUNT(*) n FROM packet_kernel WHERE corpus_id = (SELECT id FROM rules_corpus WHERE is_current = 1)',
).get() as { n: number }).n > 0;
const maybeLive = liveCard && hasKernel ? describe : describe.skip;

maybeLive('buildCardRequest and the batch packet (local database)', () => {
  const policy = loadPacketPolicy();
  const req = buildCardRequest(live, liveCard!.oracle_id, policy);
  const other = live.prepare(
    "SELECT oracle_id FROM cards WHERE oracle_id <> ? AND layout = 'normal' ORDER BY oracle_id LIMIT 1",
  ).get(liveCard!.oracle_id) as { oracle_id: string };
  const second = buildCardRequest(live, other.oracle_id, policy);
  const packet = renderBatchPacket(live, req.schemaVersion, [req, second]);

  it('shows no card name - the subject card names itself and the packet does not', () => {
    expect(packet).not.toContain(liveCard!.name);
    expect(req.redactions.flatMap((f) => f.redactions).length).toBeGreaterThan(0);
  });

  it('gives every card the same kernel, so a batch renders it once', () => {
    expect(second.kernelSections.map((s) => s.number)).toEqual(req.kernelSections.map((s) => s.number));
    expect(req.kernelSections.length).toBeGreaterThan(0);
  });

  it('renders every rule number gate 4 will accept for the card', () => {
    expect(req.packetRules.length).toBeGreaterThan(0);
    for (const n of req.packetRules.slice(0, 50)) expect(packet).toContain(n);
  });

  it('lists every atom type at the current schema version', () => {
    const v = (live.prepare('SELECT MAX(schema_version) v FROM atom_types').get() as { v: number }).v;
    const keys = live.prepare('SELECT family, type_key FROM atom_types WHERE schema_version = ?').all(v) as
      Array<{ family: string; type_key: string }>;
    expect(req.schemaVersion).toBe(v);
    for (const k of keys) expect(packet).toContain(`${k.family} ${k.type_key} - `);
  });

  it('uses the redaction list that spares rules vocabulary', () => {
    expect(req.names).toEqual(redactionNames(live));
  });

  it('hides the short name a legendary card calls itself by', () => {
    const short = live.prepare(
      `SELECT c.oracle_id, substr(c.name, 1, instr(c.name, ',') - 1) short FROM cards c
         JOIN card_faces f USING (oracle_id)
        WHERE c.layout = 'normal' AND instr(c.name, ', ') > 0
          AND f.oracle_text LIKE 'When ' || substr(c.name, 1, instr(c.name, ',') - 1) || ' enters%'
        ORDER BY c.oracle_id LIMIT 1`,
    ).get() as { oracle_id: string; short: string } | undefined;
    expect(short).toBeDefined();
    const r = buildCardRequest(live, short!.oracle_id, policy);
    expect(r.faces.join('\n')).toContain('When ~ enters');
    expect(r.faces.join('\n')).not.toMatch(new RegExp(`\\b${short!.short}\\b`));
  });
});
