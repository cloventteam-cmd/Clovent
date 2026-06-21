/**
 * Intent Detector — Keyword/phrase NLP without external APIs.
 *
 * Scans messages and activity notes for behavioral intent signals.
 * Uses a weighted phrase dictionary with temporal decay.
 *
 * Temporal decay model: signal weight × e^(-λ × days_old)
 * where λ = ln(2) / half_life_days (default half-life = 45 days)
 *
 * Deduplication: same phrase from same day is counted once.
 */
import type { MessageSummary, ActivitySummary, IntentPhrase, PredictionSignal } from './types';
import { clamp } from '../../shared/utils';

const LN2 = Math.LN2;
const HALF_LIFE_DAYS = 45; // signal weight halves every 45 days
const DECAY_LAMBDA   = LN2 / HALF_LIFE_DAYS;

// ── Intent phrase dictionary ──────────────────────────────────────────────────
const INTENT_PHRASES: IntentPhrase[] = [
  // ── Seller signals (high specificity first) ────────────────────────────────
  { phrase: 'want to list',              weight: 0.95, category: 'seller' },
  { phrase: 'ready to sell',             weight: 0.95, category: 'seller' },
  { phrase: 'sell my home',              weight: 0.95, category: 'seller' },
  { phrase: 'put it on the market',      weight: 0.90, category: 'seller' },
  { phrase: 'thinking of selling',       weight: 0.85, category: 'seller' },
  { phrase: 'thinking about selling',    weight: 0.85, category: 'seller' },
  { phrase: 'list my house',             weight: 0.85, category: 'seller' },
  { phrase: 'list my home',             weight: 0.85, category: 'seller' },
  { phrase: "what's my home worth",      weight: 0.80, category: 'seller' },
  { phrase: 'home valuation',            weight: 0.75, category: 'seller' },
  { phrase: 'market analysis',           weight: 0.65, category: 'seller' },
  { phrase: 'cma',                       weight: 0.60, category: 'seller' },
  { phrase: 'time to move',             weight: 0.60, category: 'seller' },
  { phrase: 'downsizing',               weight: 0.65, category: 'seller' },
  { phrase: 'relocating',               weight: 0.55, category: 'seller' },
  { phrase: 'need to sell',             weight: 0.80, category: 'seller' },
  { phrase: 'pricing my home',          weight: 0.80, category: 'seller' },
  { phrase: 'home value',               weight: 0.50, category: 'seller' },
  { phrase: 'what would i get',         weight: 0.55, category: 'seller' },
  { phrase: 'comparable sales',         weight: 0.45, category: 'seller' },
  { phrase: 'neighborhood prices',      weight: 0.35, category: 'seller' },

  // ── Buyer signals ──────────────────────────────────────────────────────────
  { phrase: 'looking to buy',           weight: 0.90, category: 'buyer' },
  { phrase: 'want to buy',              weight: 0.90, category: 'buyer' },
  { phrase: 'ready to buy',             weight: 0.95, category: 'buyer' },
  { phrase: 'pre-approved',             weight: 0.85, category: 'buyer' },
  { phrase: 'pre approved',             weight: 0.85, category: 'buyer' },
  { phrase: 'got approved',             weight: 0.80, category: 'buyer' },
  { phrase: 'my budget is',             weight: 0.75, category: 'buyer' },
  { phrase: 'budget of',                weight: 0.65, category: 'buyer' },
  { phrase: 'looking for a house',      weight: 0.80, category: 'buyer' },
  { phrase: 'looking for a home',       weight: 0.80, category: 'buyer' },
  { phrase: 'find me a',                weight: 0.65, category: 'buyer' },
  { phrase: 'searching for',            weight: 0.55, category: 'buyer' },
  { phrase: 'need to move by',          weight: 0.70, category: 'buyer' },
  { phrase: 'school year',              weight: 0.45, category: 'buyer' },
  { phrase: 'bedrooms',                 weight: 0.30, category: 'buyer' },
  { phrase: '3 bed',                    weight: 0.35, category: 'buyer' },
  { phrase: '4 bed',                    weight: 0.35, category: 'buyer' },
  { phrase: 'must have',                weight: 0.30, category: 'buyer' },
  { phrase: 'garage',                   weight: 0.20, category: 'buyer' },
  { phrase: 'open houses',              weight: 0.40, category: 'buyer' },
  { phrase: 'want to schedule a showing', weight: 0.70, category: 'buyer' },

  // ── Going cold signals ─────────────────────────────────────────────────────
  { phrase: 'not ready yet',            weight: 0.70, category: 'cold' },
  { phrase: "not the right time",       weight: 0.75, category: 'cold' },
  { phrase: 'need more time',           weight: 0.60, category: 'cold' },
  { phrase: 'wait and see',             weight: 0.55, category: 'cold' },
  { phrase: 'on hold',                  weight: 0.65, category: 'cold' },
  { phrase: 'pausing our search',       weight: 0.75, category: 'cold' },
  { phrase: 'taking a break',           weight: 0.65, category: 'cold' },
  { phrase: 'not interested anymore',   weight: 0.90, category: 'cold' },
  { phrase: 'decided to rent',          weight: 0.80, category: 'cold' },
  { phrase: 'going another direction',  weight: 0.85, category: 'cold' },

  // ── Reactivation signals ───────────────────────────────────────────────────
  { phrase: 'checking back in',         weight: 0.70, category: 'reactivation' },
  { phrase: 'still interested',         weight: 0.75, category: 'reactivation' },
  { phrase: 'ready to start again',     weight: 0.80, category: 'reactivation' },
  { phrase: 'back in the market',       weight: 0.85, category: 'reactivation' },
  { phrase: 'situation has changed',    weight: 0.65, category: 'reactivation' },
  { phrase: 'things have changed',      weight: 0.60, category: 'reactivation' },

  // ── Investor signals ───────────────────────────────────────────────────────
  { phrase: 'rental property',          weight: 0.80, category: 'investor' },
  { phrase: 'investment property',      weight: 0.85, category: 'investor' },
  { phrase: 'cash flow',                weight: 0.70, category: 'investor' },
  { phrase: 'cap rate',                 weight: 0.80, category: 'investor' },
  { phrase: 'flip',                     weight: 0.65, category: 'investor' },
  { phrase: 'buy and hold',             weight: 0.75, category: 'investor' },
  { phrase: 'portfolio',                weight: 0.55, category: 'investor' },
  { phrase: 'multi-family',             weight: 0.70, category: 'investor' },
];

// Pre-build lowercase phrase lookup for performance
const PHRASE_INDEX = INTENT_PHRASES.map(p => ({ ...p, lower: p.phrase.toLowerCase() }));

// ── Temporal decay ────────────────────────────────────────────────────────────
function decayWeight(weight: number, daysOld: number): number {
  return weight * Math.exp(-DECAY_LAMBDA * daysOld);
}

function daysOld(date: Date): number {
  return Math.max(0, (Date.now() - new Date(date).getTime()) / 86_400_000);
}

// ── Text scanner ──────────────────────────────────────────────────────────────
interface Match {
  phrase: string;
  weight: number;
  decayedWeight: number;
  category: IntentPhrase['category'];
}

function scanText(text: string, date: Date): Match[] {
  const lower = text.toLowerCase();
  const age   = daysOld(date);
  const found: Match[] = [];

  for (const p of PHRASE_INDEX) {
    if (lower.includes(p.lower)) {
      found.push({
        phrase: p.phrase,
        weight: p.weight,
        decayedWeight: decayWeight(p.weight, age),
        category: p.category,
      });
    }
  }

  return found;
}

// ── Public API ────────────────────────────────────────────────────────────────
export interface IntentScores {
  seller: number;
  buyer: number;
  cold: number;
  reactivation: number;
  investor: number;
  top_signals: PredictionSignal[];
  matched_phrases: string[];
}

export function detectIntent(
  messages: MessageSummary[],
  activities: ActivitySummary[],
  maxTextAgeDays = 120,
): IntentScores {
  const scores = { seller: 0, buyer: 0, cold: 0, reactivation: 0, investor: 0 };
  const matchMap = new Map<string, Match>();
  const cutoff = Date.now() - maxTextAgeDays * 86_400_000;

  // Scan messages
  for (const m of messages) {
    if (!m.body || new Date(m.sent_at).getTime() < cutoff) continue;
    const matches = scanText(m.body, m.sent_at);
    for (const match of matches) {
      const key = `${match.category}:${match.phrase}`;
      const existing = matchMap.get(key);
      if (!existing || match.decayedWeight > existing.decayedWeight) {
        matchMap.set(key, match);
      }
    }
  }

  // Scan activity notes
  for (const a of activities) {
    if (!a.body || new Date(a.occurred_at).getTime() < cutoff) continue;
    const matches = scanText(a.body, a.occurred_at);
    for (const match of matches) {
      const key = `${match.category}:${match.phrase}`;
      const existing = matchMap.get(key);
      if (!existing || match.decayedWeight > existing.decayedWeight) {
        matchMap.set(key, match);
      }
    }
  }

  // Aggregate scores
  for (const match of matchMap.values()) {
    scores[match.category] = clamp(
      scores[match.category] + match.decayedWeight,
      0, 1,
    );
  }

  // Build top signals for audit trail
  const sorted = [...matchMap.values()]
    .sort((a, b) => b.decayedWeight - a.decayedWeight)
    .slice(0, 8);

  const top_signals: PredictionSignal[] = sorted.map(m => ({
    type: `intent_${m.category}`,
    weight: m.decayedWeight,
    value: m.phrase,
    description: `"${m.phrase}" detected in ${m.category} context`,
    is_intent: true,
  }));

  const matched_phrases = sorted.map(m => m.phrase);

  return { ...scores, top_signals, matched_phrases };
}
