import { App } from "@modelcontextprotocol/ext-apps";
import { SlideEditor } from "./editor.ts";
import { fileSlug } from "./html.ts";
import { deckSummary } from "./html.ts";
import { sampleDeck } from "./sample.ts";
import type { Deck } from "./types.ts";
import { emptyDeck, emptySlide } from "./types.ts";

declare global {
  interface Window {
    __CANVAS_BASE__?: string;
  }
}

// Served directly from our own server (top-level window) vs. mounted by an
// MCP host inside its sandboxed iframe.
const standalone = window.self === window.top || location.search.includes("standalone=1");
// Absolute URL of our server. Injected by server.ts for the hosted case; in
// standalone mode it is simply where we were loaded from.
const serverBase = (window.__CANVAS_BASE__ || (standalone ? location.origin : "")).replace(/\/$/, "");
const app = new App({ name: "HTML slide canvas", version: "0.1.0" });
const editor = new SlideEditor(document.getElementById("app")!, sampleDeck());

function setStatus(text: string) {
  editor.status = text;
  editor.render();
}

function deckFromToolResult(result: {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}): Deck | null {
  const structured = result.structuredContent as { deck?: Deck } | Deck | undefined;
  if (structured && "slides" in structured) {
    return structured as Deck;
  }
  if (structured && "deck" in structured && structured.deck) {
    return structured.deck;
  }
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Deck | { deck?: Deck };
    if ("slides" in parsed) return parsed;
    if (parsed.deck) return parsed.deck;
  } catch {
    return null;
  }
  return null;
}

/** Standalone: the deck id lives in the URL so a reload keeps your work. */
function urlDeckId(): string | null {
  return new URLSearchParams(location.search).get("deck");
}

function rememberDeckId(id: string) {
  const params = new URLSearchParams(location.search);
  if (params.get("deck") === id) return;
  params.set("deck", id);
  history.replaceState(null, "", `${location.pathname}?${params}`);
}

async function createStandaloneDeck(body: Record<string, unknown>): Promise<Deck> {
  const response = await fetch("/api/decks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Could not create deck (${response.status})`);
  return (await response.json()) as Deck;
}

async function loadStandalone() {
  const id = urlDeckId();
  let deck: Deck | null = null;
  if (id) {
    const response = await fetch(`/api/decks/${encodeURIComponent(id)}`);
    if (response.ok) deck = (await response.json()) as Deck;
  }
  if (!deck) deck = await createStandaloneDeck({ sample: true });
  rememberDeckId(deck.id!);
  editor.setDeck(deck, deckSummary(deck));
}

/** What we send over the wire: the raw import is only needed until flattened. */
function deckForSave(): Deck {
  const { rawHtml: _rawHtml, ...deck } = editor.getDeck();
  return deck as Deck;
}

/** Write the deck straight to our server (no host in between, 12 MB limit). */
async function putDeck(deck: Deck): Promise<Deck> {
  const response = await fetch(`${serverBase}/api/decks/${encodeURIComponent(deck.id!)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(deck),
  });
  if (!response.ok) throw new Error(`Save failed (${response.status})`);
  return (await response.json()) as Deck;
}

async function saveStandalone() {
  const deck = deckForSave();
  if (!deck.id) {
    const created = await createStandaloneDeck({});
    deck.id = created.id;
    editor.adoptId(created.id!);
  }
  const saved = await putDeck(deck);
  editor.adoptId(saved.id!);
  rememberDeckId(saved.id!);
  editor.status = `Saved ${saved.updatedAt}`;
}

/**
 * Hosted save. Preferred path is a direct PUT to our server: the MCP route
 * goes through the host's API, and Langdock rejects tool inputs above 1 MB
 * ("Input too large"), which any deck with inline images exceeds. The
 * save_deck tool is only the fallback when we do not know our own URL.
 * Only the id is taken from the response: the editor keeps its own state.
 */
async function saveHosted() {
  const deck = deckForSave();
  if (serverBase && deck.id) {
    const saved = await putDeck(deck);
    editor.adoptId(saved.id!);
    return;
  }
  const result = await app.callServerTool({ name: "save_deck", arguments: { deck } });
  if (result.isError) {
    const text = result.content?.find((part) => part.type === "text");
    throw new Error(text && "text" in text ? String(text.text) : "Save failed");
  }
  const saved = deckFromToolResult(result);
  if (saved?.id) editor.adoptId(saved.id);
}

async function save() {
  editor.status = "Saving…";
  editor.render();
  if (standalone) {
    await saveStandalone();
  } else {
    await saveHosted();
    editor.status = "Saved";
  }
  editor.render();
}

/** Reset is local: a blank deck under the same id, nothing else is touched. */
async function reset() {
  const id = editor.getDeck().id;
  const blank = emptyDeck("Untitled deck");
  blank.slides = [emptySlide("Slide 1")];
  blank.id = id;
  editor.setDeck(blank, "Blank deck");
  await save();
}

async function copyHtml() {
  await navigator.clipboard.writeText(editor.exportHtml());
  editor.status = "HTML copied";
}

function downloadFilename(): string {
  return `${fileSlug(editor.getDeck().title)}.html`;
}

function downloadBlob() {
  const html = editor.exportHtml();
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = downloadFilename();
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Ask the server for a one-off download link for exactly this deck. */
async function snapshotUrl(): Promise<string> {
  const response = await fetch(`${serverBase}/api/snapshots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(deckForSave()),
  });
  if (!response.ok) throw new Error(`Snapshot failed (${response.status})`);
  const { url } = (await response.json()) as { url: string };
  return url;
}

async function downloadHtml() {
  editor.status = "Preparing download…";
  editor.render();

  if (standalone) {
    try {
      await saveStandalone();
    } catch {
      // still download the local deck
    }
    downloadBlob();
    editor.status = "Downloaded HTML";
    return;
  }

  // Hosted: the sandbox iframe has no allow-downloads, so <a download> is a
  // no-op. The snapshot carries the exact deck on screen, so the download
  // never waits on (or fails with) the save; that runs alongside.
  void saveHosted().catch(() => {
    /* surfaced on explicit Save */
  });
  let url = "";
  if (serverBase) {
    try {
      url = await snapshotUrl();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Snapshot failed");
      return;
    }
  }
  if (!url) {
    // Server did not tell us where it lives; last resort is the blob.
    downloadBlob();
    setStatus("Download started (if your browser allows it)");
    return;
  }
  const { isError } = await app.openLink({ url });
  setStatus(
    isError
      ? "Host blocked the download link · ask the chat for the file"
      : "Download opened in a new tab",
  );
}

async function openHtmlFile(file: File) {
  await editor.importHtml(await file.text());
}

document.getElementById("save-btn")!.addEventListener("click", () => {
  void save().catch((error) => setStatus(error instanceof Error ? error.message : "Save failed"));
});
document.getElementById("reset-btn")!.addEventListener("click", () => {
  void reset().catch((error) => setStatus(error instanceof Error ? error.message : "Reset failed"));
});
document.getElementById("copy-btn")!.addEventListener("click", () => {
  void copyHtml().catch((error) => setStatus(error instanceof Error ? error.message : "Copy failed"));
});
document.getElementById("download-btn")!.addEventListener("click", () => {
  void downloadHtml().catch((error) => setStatus(error instanceof Error ? error.message : "Download failed"));
});
document.getElementById("open-btn")!.addEventListener("click", () => {
  document.getElementById("html-file")!.click();
});
document.getElementById("html-file")!.addEventListener("change", () => {
  const input = document.getElementById("html-file") as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) void openHtmlFile(file).catch((error) => setStatus(error instanceof Error ? error.message : "Import failed"));
});

app.ontoolresult = (result) => {
  const deck = deckFromToolResult(result);
  if (deck) {
    editor.setDeck(deck, "Loaded from MCP tool");
  }
};

// Autosave, debounced, so a closed tab or a "give me the file" in chat never
// sees stale slides.
let autosave: number | undefined;
editor.onChange = () => {
  window.clearTimeout(autosave);
  autosave = window.setTimeout(() => {
    const run = standalone ? saveStandalone() : saveHosted();
    void run.catch(() => {
      /* surfaced on explicit Save */
    });
  }, 800);
};

async function start() {
  if (standalone) {
    await loadStandalone();
    return;
  }
  app.connect();
  editor.status = "Waiting for host…";
}

void start().catch((error) => {
  setStatus(error instanceof Error ? error.message : "Failed to start editor");
});
