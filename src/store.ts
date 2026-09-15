import { randomUUID } from "node:crypto";
import { htmlToDeck } from "./html.ts";
import { sampleDeck } from "./sample.ts";
import type { Deck, DeckSource } from "./types.ts";
import { emptyDeck, emptySlide } from "./types.ts";

/**
 * Deck storage keyed by deck id.
 *
 * Langdock (and other MCP hosts) call this server statelessly and send no
 * per-conversation identity, so the only safe scope is the deck id that the
 * opening tool call mints and returns. Everything else is looked up by id;
 * there is deliberately no "current deck".
 */

const DECK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SNAPSHOT_TTL_MS = 15 * 60 * 1000;

type Entry<T> = { value: T; expires: number };

const decks = new Map<string, Entry<Deck>>();
const snapshots = new Map<string, Entry<Deck>>();

function prune<T>(map: Map<string, Entry<T>>) {
  const now = Date.now();
  for (const [key, entry] of map) {
    if (entry.expires < now) map.delete(key);
  }
}

function newId(): string {
  // Short, URL-safe, unguessable enough for a 7-day in-memory record.
  return randomUUID().replace(/-/g, "").slice(0, 20);
}

function normalize(deck: Deck, id: string, source: DeckSource): Deck {
  if (!deck.slides?.length) {
    throw new Error("Deck needs at least one slide");
  }
  return {
    ...deck,
    id,
    width: 1920,
    height: 1080,
    source,
    updatedAt: new Date().toISOString(),
    slides: deck.slides.map((slide, index) => ({
      ...slide,
      name: slide.name || `Slide ${index + 1}`,
      components: slide.components ?? [],
    })),
  };
}

function put(deck: Deck): Deck {
  prune(decks);
  decks.set(deck.id!, { value: deck, expires: Date.now() + DECK_TTL_MS });
  return deck;
}

export const deckStore = {
  /** Look up a deck. Undefined when unknown or expired. */
  get(id: string | undefined): Deck | undefined {
    if (!id) return undefined;
    prune(decks);
    return decks.get(id)?.value;
  },

  /** Store a deck under a fresh id (always; imports never reuse an id). */
  create(deck: Deck, source: DeckSource): Deck {
    return put(normalize(deck, newId(), source));
  },

  /** Fresh single-slide deck. */
  createBlank(title = "Untitled deck"): Deck {
    const deck = emptyDeck(title);
    deck.slides = [emptySlide("Slide 1")];
    return this.create(deck, "user");
  },

  createSample(): Deck {
    return this.create(sampleDeck(), "sample");
  },

  /** Parse HTML (exported deck, single slide, or arbitrary page) into a new deck. */
  createFromHtml(html: string, source: DeckSource): Deck {
    return this.create(htmlToDeck(html), source);
  },

  /**
   * Overwrite an existing deck. The id must be known; a save for an unknown
   * id (expired, or made up) creates a new deck so the client never silently
   * writes into someone else's.
   */
  save(deck: Deck, source: DeckSource = "user"): Deck {
    const existing = this.get(deck.id);
    if (!existing) return this.create(deck, source);
    return put(normalize({ ...deck, rawHtml: deck.rawHtml }, existing.id!, source));
  },

  /** Immutable copy for a one-off download link. */
  snapshot(deck: Deck): string {
    prune(snapshots);
    const id = randomUUID();
    snapshots.set(id, { value: structuredClone(deck), expires: Date.now() + SNAPSHOT_TTL_MS });
    return id;
  },

  readSnapshot(id: string): Deck | undefined {
    prune(snapshots);
    return snapshots.get(id)?.value;
  },
};
