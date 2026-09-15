import { randomUUID } from "node:crypto";
import { htmlToDeck } from "./html.ts";
import { sampleDeck } from "./sample.ts";
import type { Deck, DeckSource } from "./types.ts";
import { emptyDeck, emptySlide } from "./types.ts";

function stamp(deck: Deck, source: DeckSource): Deck {
  return {
    ...deck,
    source,
    updatedAt: new Date().toISOString(),
  };
}

let current = sampleDeck();

const SNAPSHOT_TTL_MS = 15 * 60 * 1000;
const snapshots = new Map<string, { deck: Deck; expires: number }>();

function pruneSnapshots() {
  const now = Date.now();
  for (const [id, entry] of snapshots) {
    if (entry.expires < now) snapshots.delete(id);
  }
}

export const deckStore = {
  /** Store an immutable copy for a one-off download link. */
  snapshot(deck: Deck): string {
    pruneSnapshots();
    const id = randomUUID();
    snapshots.set(id, { deck: structuredClone(deck), expires: Date.now() + SNAPSHOT_TTL_MS });
    return id;
  },
  readSnapshot(id: string): Deck | undefined {
    pruneSnapshots();
    return snapshots.get(id)?.deck;
  },
  get(): Deck {
    return current;
  },
  save(deck: Deck, source: DeckSource = "user"): Deck {
    if (!deck.slides?.length) {
      throw new Error("Deck needs at least one slide");
    }
    current = stamp(
      {
        ...deck,
        width: 1920,
        height: 1080,
        rawHtml: deck.rawHtml,
        slides: deck.slides.map((slide, index) => ({
          ...slide,
          name: slide.name || `Slide ${index + 1}`,
          components: slide.components ?? [],
        })),
      },
      source,
    );
    return current;
  },
  loadHtml(html: string, source: DeckSource = "agent"): Deck {
    current = stamp(htmlToDeck(html), source);
    return current;
  },
  addSlide(name?: string): Deck {
    const next = structuredClone(current);
    next.slides.push(emptySlide(name ?? `Slide ${next.slides.length + 1}`));
    current = stamp(next, "user");
    return current;
  },
  reset(): Deck {
    current = sampleDeck();
    return current;
  },
  clear(): Deck {
    current = stamp(emptyDeck(), "user");
    return current;
  },
};
