import { describe, it, expect, beforeAll } from 'vitest';
import { poolCardNames, redactCardNames } from '../src/atoms/extract.js';
import { scanCrCitations } from '../src/rules/parse.js';
import { contentRefs, emptyContent, loadRowStore, set5CrContent, typeCrContent, withKernel } from '../src/graph/crContent.js';
import {
  PAIR_ANSWER_FORMAT, PAIR_INSTRUCTIONS, ROLE_ANSWER_FORMAT, ROLE_INSTRUCTIONS,
  BATCH_CR_HEADING, packetContext, planPairBatchPart, planPairPackets, planRolePackets, planSharedPart, typeId, type PacketChunk, type PacketContext,
} from '../src/graph/edgePackets.js';
import { permittedIntrinsicValues } from '../src/graph/intrinsic.js';
import { loadGraphPolicy, weightsSha } from '../src/graph/policy.js';
import { maybe, realDb as db, realCorpusId as corpusId } from './helpers/realDb.js';

describe('graph policy (plan D4)', () => {
  it('loads the provisional values of spec sec. 19', () => {
    const p = loadGraphPolicy();
    expect(p.packet_budget_bytes).toBe(300000);
    expect(p.resources).toContain('other');
    expect(p.cycles).toEqual({ max_length: 4, top_k: 50, budget: 200000 });
  });

  it('weightsSha hashes the weights only', () => {
    const p = loadGraphPolicy();
    expect(weightsSha({ ...p, cycles: { ...p.cycles, top_k: 7 } })).toBe(weightsSha(p));
    expect(weightsSha({ ...p, weights: { ...p.weights, cost_per_mv: 0.2 } })).not.toBe(weightsSha(p));
    expect(weightsSha(JSON.parse(JSON.stringify(p)))).toBe(weightsSha(p));
  });
});

const DEMAND = { family: 'CARES_ABOUT', type_key: 'PERMANENT_DIES' };

maybe('edge-rule packets (spec sec. 5.2-5.3)', () => {
  let ctx: PacketContext;
  let roles: PacketChunk[];
  let pairs: PacketChunk[];
  let allIds: string[];
  let typeRows: Array<{ family: string; type_key: string; label: string; params_schema: string; evidence: string }>;

  beforeAll(() => {
    ctx = packetContext(db);
    roles = planRolePackets(db, ctx);
    allIds = roles.flatMap((c) => c.types);
    pairs = planPairPackets(db, ctx, DEMAND, allIds);
    typeRows = db.prepare('SELECT family, type_key, label, params_schema, evidence FROM atom_types WHERE schema_version = ? ORDER BY family, type_key')
      .all(ctx.schemaVersion) as typeof typeRows;
  });

  const kernelRefs = () => contentRefs(loadRowStore(db, corpusId), withKernel(db, corpusId, emptyContent()));

  it('each chunk is packet_budget_bytes or smaller', () => {
    for (const c of [...roles, ...pairs]) {
      expect(c.bytes).toBeLessThanOrEqual(ctx.graph.packet_budget_bytes);
      expect(c.bytes).toBe(Buffer.byteLength(c.markdown, 'utf8'));
    }
  });

  it('Stage A covers each type one time', () => {
    expect([...allIds].sort()).toEqual(typeRows.map(typeId).sort());
  });

  it('each Stage A chunk contains the full kernel', () => {
    for (const c of roles) expect(c.refs).toEqual(expect.arrayContaining(kernelRefs()));
  });

  it('Stage A splits by family first, then into consecutive type keys', () => {
    const familyOf = (t: string) => t.slice(0, t.indexOf('.'));
    if (roles.length === 1) return;
    for (const c of roles) {
      expect(new Set(c.types.map(familyOf)).size).toBe(1);
      expect(c.batch_key).toBe(familyOf(c.types[0]!));
    }
    expect(allIds).toEqual(typeRows.map(typeId));                  // consecutive, in family and type-key order
  });

  it('a family that is too large splits into consecutive type keys, each chunk with the full kernel', () => {
    const small = packetContext(db, { graph: { ...ctx.graph, packet_budget_bytes: 210000 } });
    const chunks = planRolePackets(db, small);
    const familyOf = (t: string) => t.slice(0, t.indexOf('.'));
    const split = [...new Set(chunks.map((c) => c.batch_key))].filter((f) => chunks.filter((c) => c.batch_key === f).length > 1);
    expect(split.length).toBeGreaterThan(0);
    for (const f of split) {
      const own = chunks.filter((c) => c.batch_key === f);
      expect(own.map((c) => c.chunk)).toEqual(own.map((_, i) => i));
      expect(own.flatMap((c) => c.types)).toEqual(typeRows.map(typeId).filter((t) => familyOf(t) === f));
    }
    for (const c of chunks) {
      expect(c.bytes).toBeLessThanOrEqual(210000);
      expect(c.refs).toEqual(expect.arrayContaining(kernelRefs()));
    }
    expect(chunks.flatMap((c) => c.types)).toEqual(typeRows.map(typeId));
  });

  it('each Stage B chunk contains the full CR content of the demand type', () => {
    const own = contentRefs(loadRowStore(db, corpusId), typeCrContent(db, corpusId, ctx.schemaVersion, DEMAND, ctx.termPolicy));
    expect(own.length).toBeGreaterThan(0);
    for (const c of pairs) {
      expect(c.types[0]).toBe(typeId(DEMAND));
      expect(c.refs).toEqual(expect.arrayContaining([...own, ...kernelRefs()]));
    }
  });

  it('each Stage B chunk contains the class kinds with their values, and set 5, one time', () => {
    const set5 = contentRefs(loadRowStore(db, corpusId), set5CrContent(db, corpusId));
    const values = permittedIntrinsicValues(db, corpusId, ctx.scope);
    expect(Object.keys(values)).toEqual(['card_type', 'subtype', 'mana_value', 'color_identity']);
    for (const c of pairs) {
      expect(c.markdown.split('\n').filter((l) => l.startsWith('# Intrinsic class kinds'))).toHaveLength(1);
      for (const [kind, list] of Object.entries(values)) {
        expect(c.markdown.split('\n').filter((l) => l.startsWith(`${kind}: `))).toEqual([`${kind}: ${list.join(', ')}`]);
      }
      expect(c.refs).toEqual(expect.arrayContaining(set5));
    }
  });

  it('the Stage B chunks together list each supply candidate one time', () => {
    expect(pairs.flatMap((c) => c.types.slice(1))).toEqual(allIds);
  });

  it('a packet shows each rule row one time', () => {
    for (const c of [...roles, ...pairs]) {
      const ruleLines = c.markdown.split('\n').filter((l) => /^\d{3}\.\d+[a-z]? /.test(l)).map((l) => l.slice(0, l.indexOf(' ')));
      expect(new Set(ruleLines).size).toBe(ruleLines.length);
      expect(c.refs.filter((r) => !r.startsWith('glossary:')).sort()).toEqual([...ruleLines].sort());
    }
  });

  // Plan Step 7 also names the type entries. Three atom-type labels are keyword names that are
  // also pool card names; the owner accepted them on 2026-10-10. The next test guards the entries.
  it('the instructions and answer formats contain no pool card name', () => {
    const names = poolCardNames(db);
    for (const text of [ROLE_INSTRUCTIONS, PAIR_INSTRUCTIONS, ROLE_ANSWER_FORMAT, PAIR_ANSWER_FORMAT]) {
      expect(redactCardNames(text, names)).toBe(text);
    }
    for (const c of [...roles, ...pairs]) {
      expect(c.markdown).toContain(c.stage === 'roles' ? ROLE_INSTRUCTIONS : PAIR_INSTRUCTIONS);
      expect(c.markdown).toContain(c.stage === 'roles' ? ROLE_ANSWER_FORMAT : PAIR_ANSWER_FORMAT);
    }
  });

  it('the type entries contain only text from atom_types', () => {
    const expected = new Map(typeRows.map((r) => {
      const props = (JSON.parse(r.params_schema) as { properties?: Record<string, unknown> }).properties ?? {};
      const refs = scanCrCitations(r.evidence);
      return [`${r.family}.${r.type_key}`, `${r.family} ${r.type_key} - ${r.label}` +
        (Object.keys(props).length ? ` params: ${JSON.stringify(props)}` : '') +
        (refs.length ? ` evidence: ${refs.map((n) => `CR ${n}`).join(', ')}` : '')];
    }));
    const section = (md: string, head: string) => {
      const from = md.indexOf(`\n${head}\n`) + head.length + 2;
      return md.slice(from, md.indexOf('\n# ', from)).split('\n').filter(Boolean);
    };
    for (const c of roles) expect(section(c.markdown, '# Atom types')).toEqual(c.types.map((t) => expected.get(t)));
    for (const c of pairs) {
      expect(section(c.markdown, '# Demand type')).toEqual([expected.get(c.types[0]!)]);
      expect(section(c.markdown, '# Supply candidates')).toEqual(c.types.slice(1).map((t) => expected.get(t)));
    }
  });

  it('the same input gives the same bytes two times', () => {
    const ctx2 = packetContext(db);
    expect(planRolePackets(db, ctx2).map((c) => c.markdown)).toEqual(roles.map((c) => c.markdown));
    expect(planPairPackets(db, ctx2, DEMAND, allIds).map((c) => c.markdown)).toEqual(pairs.map((c) => c.markdown));
  });

  it('a smaller budget gives more chunks, and each still fits', () => {
    const small = packetContext(db, { graph: { ...ctx.graph, packet_budget_bytes: 240000 } });
    const chunks = planPairPackets(db, small, DEMAND, allIds);
    expect(chunks.length).toBeGreaterThan(pairs.length);
    for (const c of chunks) expect(c.bytes).toBeLessThanOrEqual(240000);
    expect(() => planPairPackets(db, packetContext(db, { graph: { ...ctx.graph, packet_budget_bytes: 1000 } }), DEMAND, allIds))
      .toThrow(/alone makes a packet larger/);
  });
});

maybe('a policy rule in a batch part (spec sec. 24.6)', () => {
  const ctx = packetContext(db);
  const RULE = ctx.graph.batch_part_rules[0]!.rule;
  const [KEYWORD] = ctx.graph.batch_part_rules[0]!.types as [string];
  const DEMAND_TYPE = 'CARES_ABOUT.LIFEGAIN';
  const part = (supply: string[], fixed = supply) => planPairBatchPart(db, ctx, DEMAND_TYPE, supply, planSharedPart(db, ctx, fixed, [DEMAND_TYPE]), 1);

  it('shows the rule when a candidate needs it and the fixed part does not have it', () => {
    const c = part([KEYWORD]);
    expect(c.refs).toContain(RULE);
    expect(c.markdown.indexOf(`${RULE} `)).toBeGreaterThan(c.markdown.indexOf(BATCH_CR_HEADING));
    expect(c.markdown).toContain(`[for: ${KEYWORD}]`);
  });
  it('leaves out the rule when no candidate needs it', () => {
    expect(part(['ENABLES.CAST']).refs).not.toContain(RULE);
  });
  it('does not show the rule two times when the fixed part has it', () => {
    const c = part([KEYWORD], [KEYWORD, 'PRODUCES.SACRIFICE']);
    expect(c.refs).toContain(RULE);
    expect(c.markdown).not.toContain(`${RULE} `);
  });
});
