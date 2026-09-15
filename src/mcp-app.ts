import { App } from "@modelcontextprotocol/ext-apps";
import { SlideEditor } from "./editor.ts";
import { deckSummary } from "./html.ts";
import { sampleDeck } from "./sample.ts";
import type { Deck } from "./types.ts";

const standalone = location.pathname === "/canvas" || location.search.includes("standalone=1");
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

async function loadStandalone() {
  const response = await fetch("/api/deck");
  if (!response.ok) {
    throw new Error(`Failed to load deck (${response.status})`);
  }
  const deck = (await response.json()) as Deck;
  editor.setDeck(deck, deckSummary(deck));
}

async function saveStandalone() {
  const deck = editor.getDeck();
  const response = await fetch("/api/deck", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(deck),
  });
  if (!response.ok) {
    throw new Error(`Save failed (${response.status})`);
  }
  const saved = (await response.json()) as Deck;
  setStatus(`Saved ${saved.updatedAt}`);
}

async function resetStandalone() {
  const response = await fetch("/api/deck/reset", { method: "POST" });
  if (!response.ok) {
    throw new Error(`Reset failed (${response.status})`);
  }
  editor.setDeck((await response.json()) as Deck, "Reset to sample deck");
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = await app.callServerTool({ name, arguments: args });
  const deck = deckFromToolResult(result);
  if (deck) {
    editor.setDeck(deck, `Loaded from ${name}`);
  }
  return result;
}

async function save() {
  setStatus("Saving…");
  if (standalone) {
    await saveStandalone();
    return;
  }
  await callTool("save_deck", { deck: editor.getDeck() });
  setStatus("Saved to MCP store");
}

async function reset() {
  setStatus("Resetting…");
  if (standalone) {
    await resetStandalone();
    return;
  }
  await callTool("reset_deck");
}

async function copyHtml() {
  await navigator.clipboard.writeText(editor.exportHtml());
  setStatus("HTML copied");
}

function downloadHtml() {
  const blob = new Blob([editor.exportHtml()], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${editor.getDeck().title.replace(/\s+/g, "-").toLowerCase() || "deck"}.html`;
  link.click();
  URL.revokeObjectURL(url);
  setStatus("Downloaded HTML");
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
document.getElementById("download-btn")!.addEventListener("click", downloadHtml);

app.ontoolresult = (result) => {
  const deck = deckFromToolResult(result);
  if (deck) {
    editor.setDeck(deck, "Loaded from MCP tool");
  }
};

editor.onChange = (deck) => {
  if (standalone) {
    void fetch("/api/deck", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(deck),
    });
  }
};

async function start() {
  if (standalone) {
    await loadStandalone();
    return;
  }
  app.connect();
  setStatus("Waiting for host…");
}

void start().catch((error) => {
  setStatus(error instanceof Error ? error.message : "Failed to start editor");
});
