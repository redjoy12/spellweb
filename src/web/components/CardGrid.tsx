import type { CardSummary } from '../api.js';
import { getArtClass } from '../lib/cardArt.js';
import { ManaCost } from './ManaCost.js';

export function CardGrid({ items }: { items: CardSummary[] }) {
  return (
    <div className="card-grid">
      {items.map((card) => (
        <a key={card.oracle_id} className="tile" href={`#/card/${encodeURIComponent(card.oracle_id)}`} data-card-id={card.oracle_id}>
          <div className={['tile-art', card.image_art_crop ? '' : getArtClass(card.color_identity)].filter(Boolean).join(' ')}>
            {card.image_art_crop ? <img src={card.image_art_crop} alt={card.name} loading="lazy" /> : null}
            {card.rotated === 1 && <span className="badge-rotated">ROTATED</span>}
          </div>
          <div className="tile-body">
            <div className="tile-name">{card.name}</div>
            <div className="tile-metarow">
              <ManaCost cost={card.mana_cost} />
            </div>
            <div className="tile-type">{card.type_line}</div>
          </div>
        </a>
      ))}
    </div>
  );
}
