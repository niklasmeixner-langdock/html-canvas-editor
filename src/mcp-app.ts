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
// autoResize measures the document at max-content, which for a 100%-height
// grid is meaningless; the app reports its own size per display mode below.
const app = new App({ name: "HTML slide canvas", version: "0.1.0" }, {}, { autoResize: false });
const appRoot = document.getElementById("app")!;
const editor = new SlideEditor(appRoot, sampleDeck());

/**
 * Three hosted surfaces (MCP Apps display modes) plus the standalone page:
 * - inline: the chat card. Slides only: canvas + filmstrip, no panels.
 * - pip: the chat side panel. Panels start minimised (icon tools, no props)
 *   and can be expanded; Full screen is one click away.
 * - fullscreen / standalone: the full editor, panels adapt to width.
 */
type Mode = "inline" | "pip" | "fullscreen" | "standalone";
const INLINE_HEIGHT = 600; // the host's cap for inline cards
let mode: Mode = standalone ? "standalone" : "inline";
let panelsOpen = false;

function applyLayout() {
  const width = window.innerWidth;
  let rail: "full" | "compact" | "hidden";
  let props: "full" | "compact" | "hidden";
  if (mode === "inline") {
    rail = "hidden";
    props = "hidden";
  } else if (mode === "pip" && !panelsOpen) {
    rail = "compact";
    props = "hidden";
  } else if (width < 560) {
    rail = "hidden";
    props = "compact";
  } else if (width < 900) {
    rail = "compact";
    props = "compact";
  } else {
    rail = "full";
    props = "full";
  }
  appRoot.dataset.mode = mode;
  appRoot.dataset.rail = rail;
  appRoot.dataset.props = props;
  appRoot.dataset.narrow = width < 900 ? "1" : "0";
  const panelsBtn = document.getElementById("panels-btn")!;
  panelsBtn.setAttribute("aria-pressed", String(panelsOpen));
  panelsBtn.title = panelsOpen ? "Hide panels" : "Show panels";
  editor.wheelPans = mode !== "inline";
  editor.refit();
}

function setMode(next: Mode) {
  if (next === mode) return;
  mode = next;
  applyLayout();
  if (mode === "inline") void app.sendSizeChanged({ width: window.innerWidth, height: INLINE_HEIGHT });
}

window.addEventListener("resize", applyLayout);
applyLayout();

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
document.getElementById("play-btn")!.addEventListener("click", () => editor.playAnimations());
document.getElementById("panels-btn")!.addEventListener("click", () => {
  panelsOpen = !panelsOpen;
  applyLayout();
});
document.getElementById("maximize-btn")!.addEventListener("click", () => {
  void app
    .requestDisplayMode({ mode: "fullscreen" })
    .then((result) => setMode(result.mode))
    .catch(() => setStatus("Host did not allow full screen"));
});

app.onhostcontextchanged = (context) => {
  if (context.displayMode) setMode(context.displayMode);
};

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
  editor.status = "Waiting for host…";
  await app.connect();
  setMode(app.getHostContext()?.displayMode ?? "inline");
  // The host shows a loader until the first size report. Inline it also sizes
  // the card from it; side panel and full screen own their size.
  void app.sendSizeChanged({
    width: window.innerWidth,
    height: mode === "inline" ? INLINE_HEIGHT : window.innerHeight,
  });
}

void start().catch((error) => {
  setStatus(error instanceof Error ? error.message : "Failed to start editor");
});
