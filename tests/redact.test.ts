import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/client.js';
import {
  redactCardNames, redactWithMap, unredactSpan, poolCardNames, redactionNames, ownShortNames,
} from '../src/atoms/extract.js';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (n: string) => new RegExp('(?<![\\p{L}\\p{N}])' + esc(n) + '(?![\\p{L}\\p{N}])', 'u');

describe('redactCardNames', () => {
  it('replaces the subject card name with the templating placeholder', () => {
    expect(redactCardNames('Grizzly Bears attacks.', ['Grizzly Bears'])).toBe('~ attacks.');
  });

  it('replaces every occurrence, not just the first', () => {
    const out = redactCardNames('Sacrifice Foo: Foo deals 1 damage.', ['Foo']);
    expect(out).toBe('Sacrifice ~: ~ deals 1 damage.');
  });

  it('redacts OTHER cards named in the text — 35 cards do this', () => {
    const t = 'Search your library for a card named Dragonstorm Globe.';
    expect(redactCardNames(t, ['Dragonstorm Forecaster', 'Dragonstorm Globe']))
      .toBe('Search your library for a card named ~.');
  });

  it('redacts longest name first so a name containing another is handled', () => {
    const out = redactCardNames('Ajani, Nacatl Pariah and Ajani.', ['Ajani', 'Ajani, Nacatl Pariah']);
    expect(out).toBe('~ and ~.');
  });

  it('leaves text without any card name untouched', () => {
    const t = 'Target creature gets -2/-2 until end of turn.';
    expect(redactCardNames(t, ['Something Else'])).toBe(t);
  });

  // --- the cases that make this more than a one-liner ---

  it('does NOT redact a name that is merely a substring of a longer word', () => {
    // "Sear" is a real card in the pool and a substring of "Search".
    expect(redactCardNames('Search your library for a card.', ['Sear']))
      .toBe('Search your library for a card.');
  });

  // Anchoring does NOT fix these: "Island" and "Flashback" are whole words. They are card
  // names in the pool AND rules vocabulary, so the redaction list drops every name the
  // current corpus's term index defines (Task 8 ruling R9).
  it('does not blank basic land names used as ordinary rules vocabulary', () => {
    const db = openDb();
    expect(poolCardNames(db)).toEqual(expect.arrayContaining(['Island', 'Mountain', 'Plains']));
    const t = 'Search your library for a basic Island, Mountain, or Plains card.';
    expect(redactCardNames(t, redactionNames(db))).toBe(t);
  });

  it('does not blank a keyword that is also a card name', () => {
    const db = openDb();
    expect(poolCardNames(db)).toContain('Flashback');
    const t = 'Flashback {2}{W} (You may cast this card from your graveyard for its flashback cost.)';
    expect(redactCardNames(t, redactionNames(db))).toBe(t);
  });

  it('leaves every face in the pool free of glued-together redactions', () => {
    const db = openDb();
    const names = redactionNames(db);
    const faces = (db.prepare('SELECT oracle_text FROM card_faces').all() as Array<{ oracle_text: string }>)
      .filter((f) => f.oracle_text);
    const broken = faces.filter((f) => /[A-Za-z]~|~[a-z]/.test(redactCardNames(f.oracle_text, names)));
    expect(broken.map((b) => b.oracle_text.slice(0, 60))).toHaveLength(0);
  });

  it('never leaves a card its own name - the vocabulary exclusion costs no self-reference', () => {
    const db = openDb();
    const names = redactionNames(db);
    const faces = db.prepare(
      'SELECT f.name face, c.name card, f.oracle_text FROM card_faces f JOIN cards c USING (oracle_id)',
    ).all() as Array<{ face: string; card: string; oracle_text: string }>;
    const leaked = faces.filter((f) => {
      const red = redactCardNames(f.oracle_text, names);
      return [f.face, ...f.card.split(' // ')].some((n) => wordRe(n).test(red));
    });
    expect(leaked.map((f) => f.face)).toHaveLength(0);
  }, 30_000);   // pool-wide: about 2 s alone, but over 5 s while the Phase 3 suites run beside it
});

// Legendary cards call themselves by the part of their name before the comma: "When Katara
// enters" on "Katara, Water Tribe's Hope". Full-name redaction missed every one (run 4 found
// "Bahamut", "Kellan", "Huatli", "Aang" ... in the subagents' packets).
describe('short-name redaction', () => {
  it('redacts the card\'s own short name and maps the ~ back to it', () => {
    const text = "When Katara enters, create a token. Katara, Water Tribe's Hope can't be countered.";
    const r = redactWithMap(text, ["Katara, Water Tribe's Hope"], ['Katara']);
    expect(r.text).toBe("When ~ enters, create a token. ~ can't be countered.");
    expect(r.redactions.map((x) => text.slice(x.start, x.end)))
      .toEqual(['Katara', "Katara, Water Tribe's Hope"]);   // the full name wins where both match
    const at = r.text.indexOf('When ~ enters');
    const span = unredactSpan(r.redactions, at, at + 'When ~ enters'.length);
    expect(text.slice(span.start, span.end)).toBe('When Katara enters');
  });

  it('is anchored like full names - "Ash" never eats "Ashes"', () => {
    expect(redactWithMap('Ashes to ashes. Ash attacks.', [], ['Ash']).text).toBe('Ashes to ashes. ~ attacks.');
  });

  it('takes the part before the comma of the card and each face name', () => {
    const db = openDb();
    const id = (name: string) => (db.prepare('SELECT oracle_id FROM cards WHERE name = ?').get(name) as
      { oracle_id: string } | undefined)?.oracle_id;
    const katara = id("Katara, Water Tribe's Hope");
    const dion = id("Dion, Bahamut's Dominant // Bahamut, Warden of Light");
    const bears = db.prepare("SELECT oracle_id FROM cards WHERE name NOT LIKE '%,%' LIMIT 1").get() as
      { oracle_id: string };
    if (katara) expect(ownShortNames(db, katara)).toEqual(['Katara']);
    if (dion) expect(ownShortNames(db, dion).sort()).toEqual(['Bahamut', 'Dion']);
    expect(ownShortNames(db, bears.oracle_id)).toEqual([]);
  });

  it('spares a short name that is rules vocabulary, as full names are spared', () => {
    const db = openDb();
    const storm = db.prepare("SELECT oracle_id FROM cards WHERE name LIKE 'Storm, %'").get() as
      { oracle_id: string } | undefined;
    if (storm) expect(ownShortNames(db, storm.oracle_id)).toEqual([]);
  });

  it('leaves no card in the pool its own short name', () => {
    const db = openDb();
    const names = redactionNames(db);
    const faces = db.prepare('SELECT oracle_id, oracle_text FROM card_faces').all() as
      Array<{ oracle_id: string; oracle_text: string }>;
    const leaked = faces.flatMap((f) => {
      const own = ownShortNames(db, f.oracle_id);
      const red = redactWithMap(f.oracle_text, names, own).text;
      return own.filter((n) => wordRe(n).test(red));
    });
    expect(leaked).toEqual([]);
  });
});

describe('redactWithMap / unredactSpan', () => {
  const names = ['Grizzly Bears', 'Foo'];
  const text = 'When Grizzly Bears enters, Foo deals 1 damage. Draw a card.';
  const { text: red, redactions } = redactWithMap(text, names);

  it('records each replacement as offsets into the original text', () => {
    expect(red).toBe('When ~ enters, ~ deals 1 damage. Draw a card.');
    expect(redactions.map((r) => text.slice(r.start, r.end))).toEqual(['Grizzly Bears', 'Foo']);
  });

  it('maps a span covering a placeholder back to the whole name', () => {
    const q = 'When ~ enters';
    const at = red.indexOf(q);
    const span = unredactSpan(redactions, at, at + q.length);
    expect(text.slice(span.start, span.end)).toBe('When Grizzly Bears enters');
  });

  it('maps spans that start or end exactly on a placeholder', () => {
    const at = red.indexOf('~ deals');
    const s1 = unredactSpan(redactions, at, at + '~ deals'.length);
    expect(text.slice(s1.start, s1.end)).toBe('Foo deals');
    const s2 = unredactSpan(redactions, red.indexOf('enters, ~'), red.indexOf('enters, ~') + 'enters, ~'.length);
    expect(text.slice(s2.start, s2.end)).toBe('enters, Foo');
  });

  it('maps spans after every placeholder by the accumulated shift', () => {
    const at = red.indexOf('Draw a card.');
    const span = unredactSpan(redactions, at, at + 'Draw a card.'.length);
    expect(text.slice(span.start, span.end)).toBe('Draw a card.');
  });
});
