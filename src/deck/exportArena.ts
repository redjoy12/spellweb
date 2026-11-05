/**
 * The MTGA import text (Phase 4 design sec. 10): one header line and one line for each card. The
 * form of a name with two faces is not known from project data, so it is a policy value by layout,
 * and the first real import decides it.
 */
import type { DeckPolicy } from './policy.js';

export interface ExportCard { copies: number; name: string; front_name: string; layout: string; set_code: string; collector_number: string }

/** The name of a card in the import text. */
export function exportName(c: Pick<ExportCard, 'name' | 'front_name' | 'layout'>, p: DeckPolicy): string {
  const form = p.export.name_form[c.layout] ?? p.export.name_form['default'] ?? 'full';
  return form === 'front' ? c.front_name : c.name;
}

export function arenaText(cards: readonly ExportCard[], p: DeckPolicy): string {
  const lines = cards.map((c) => `${c.copies} ${exportName(c, p)} (${c.set_code.toUpperCase()}) ${c.collector_number}`);
  return ['Deck', ...lines].join('\n');
}
