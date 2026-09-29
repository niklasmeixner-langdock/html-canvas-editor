import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

/**
 * Decks are also written to disk so a redeploy or restart does not lose a
 * user's edits. `DATA_DIR` (Railway: a mounted volume) or ./data.
 */
const dataDir = process.env.DATA_DIR || path.resolve("data");
const ID_PATTERN = /^[a-z0-9]{8,40}$/i;

function deckPath(id: string): string {
  return path.join(dataDir, `${id}.json`);
}

function persist(entry: Entry<Deck>) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${deckPath(entry.value.id!)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, deckPath(entry.value.id!));
  } catch (error) {
    console.error("Could not persist deck:", error);
  }
}

function unlink(id: string) {
  fs.rm(deckPath(id), { force: true }, () => undefined);
}

function loadFromDisk() {
  let files: string[] = [];
  try {
    files = fs.readdirSync(dataDir).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  const now = Date.now();
  for (const file of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf8")) as Entry<Deck>;
      if (entry?.value?.id && entry.expires > now) decks.set(entry.value.id, entry);
      else fs.rmSync(path.join(dataDir, file), { force: true });
    } catch {
      // unreadable file: skip it
    }
  }
  if (decks.size) console.log(`Loaded ${decks.size} deck(s) from ${dataDir}`);
}
loadFromDisk();

function prune<T>(map: Map<string, Entry<T>>, onDisk = false) {
  const now = Date.now();
  for (const [key, entry] of map) {
    if (entry.expires < now) {
      map.delete(key);
      if (onDisk) unlink(key);
    }
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
  prune(decks, true);
  const entry = { value: deck, expires: Date.now() + DECK_TTL_MS };
  decks.set(deck.id!, entry);
  persist(entry);
  return deck;
}

export const deckStore = {
  /** Look up a deck. Undefined when unknown or expired. */
  get(id: string | undefined): Deck | undefined {
    if (!id) return undefined;
    prune(decks, true);
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
   * Overwrite a deck. An unknown id (expired, or lost to a restart before
   * persistence existed) is kept rather than replaced: the chat holds that
   * id, and minting a new one would orphan every later tool call. Ids are
   * unguessable, so writing to an unknown one cannot touch anyone else's.
   */
  save(deck: Deck, source: DeckSource = "user"): Deck {
    const existing = this.get(deck.id);
    const id = existing?.id ?? (deck.id && ID_PATTERN.test(deck.id) ? deck.id : newId());
    return put(normalize({ ...deck, rawHtml: deck.rawHtml }, id, source));
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
