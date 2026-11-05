import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A prepare writes generated agent files (pairFixed.ts). A test must never touch .claude/agents.
process.env['EDGE_AGENTS_DIR'] = mkdtempSync(join(tmpdir(), 'edge-agents-'));
