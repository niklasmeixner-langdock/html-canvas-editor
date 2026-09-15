import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { deckToHtml, deckSummary } from "./src/html.ts";
import { deckStore } from "./src/store.ts";
import type { Deck } from "./src/types.ts";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const CANVAS_URI = "ui://html-canvas/editor.html";

const deckSchema = z.object({
  title: z.string(),
  width: z.number(),
  height: z.number(),
  source: z.enum(["sample", "user", "agent"]).optional(),
  updatedAt: z.string().optional(),
  slides: z.array(z.record(z.unknown())),
});

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function deckResult(deck: Deck, extra?: string) {
  const header = extra ? `${extra}\n\n` : "";
  return {
    content: [
      {
        type: "text" as const,
        text: `${header}${deckSummary(deck)}\n\n${JSON.stringify(deck, null, 2)}`,
      },
    ],
    structuredContent: { deck },
  };
}

async function readCanvasHtml(): Promise<string> {
  return fs.readFile(path.join(rootDir, "dist", "mcp-app.html"), "utf8");
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "html-canvas-editor",
    version: "0.1.0",
  });

  registerAppTool(
    server,
    "show_editor",
    {
      title: "Show HTML slide canvas",
      description:
        "Open the 16:9 HTML slide canvas. Optionally load HTML first so the user can drag, resize, and add text, images, or frames without another prompt.",
      inputSchema: {
        html: z
          .string()
          .optional()
          .describe("Full HTML deck or a single slide. Round-trips if it contains deck-data JSON."),
        title: z.string().optional().describe("Deck title when loading fresh HTML"),
      },
      _meta: { ui: { resourceUri: CANVAS_URI } },
    },
    async ({ html, title }) => {
      if (html) {
        const deck = deckStore.loadHtml(html, "agent");
        if (title) deck.title = title;
        return deckResult(deck, "Opened the canvas with the provided HTML.");
      }
      return deckResult(deckStore.get(), "Opened the current HTML slide canvas.");
    },
  );

  registerAppResource(
    server,
    CANVAS_URI,
    CANVAS_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: CANVAS_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readCanvasHtml(),
        },
      ],
    }),
  );

  server.registerTool(
    "load_html",
    {
      title: "Load HTML into the canvas",
      description:
        "Replace the current deck with HTML. Prefer exporting from this editor so the deck JSON survives. Arbitrary HTML becomes an imported slide the user can overlay.",
      inputSchema: {
        html: z.string().describe("HTML for one slide or a full deck"),
        title: z.string().optional(),
      },
    },
    async ({ html, title }) => {
      const deck = deckStore.loadHtml(html, "agent");
      if (title) {
        deck.title = title;
        deckStore.save(deck, "agent");
      }
      return deckResult(deck, "Loaded HTML into the canvas.");
    },
  );

  server.registerTool(
    "get_deck",
    {
      title: "Get current deck",
      description: "Return the structured 16:9 deck currently in the editor store.",
      inputSchema: {},
    },
    async () => deckResult(deckStore.get()),
  );

  server.registerTool(
    "export_html",
    {
      title: "Export deck HTML",
      description: "Return presentable 16:9 HTML for the current deck, including round-trip JSON.",
      inputSchema: {},
    },
    async () => {
      const deck = deckStore.get();
      return {
        content: [{ type: "text" as const, text: deckToHtml(deck) }],
        structuredContent: { deck, html: deckToHtml(deck) },
      };
    },
  );

  server.registerTool(
    "save_deck",
    {
      title: "Save deck",
      description: "Save a structured deck. This is what the canvas calls after an edit.",
      inputSchema: {
        deck: deckSchema.describe("Structured deck JSON from the editor"),
      },
    },
    async ({ deck }) => deckResult(deckStore.save(deck as Deck, "user"), "Saved deck."),
  );

  server.registerTool(
    "add_slide",
    {
      title: "Add slide",
      description: "Append an empty 16:9 slide to the current deck.",
      inputSchema: {
        name: z.string().optional(),
      },
    },
    async ({ name }) => deckResult(deckStore.addSlide(name), "Added a slide."),
  );

  server.registerTool(
    "reset_deck",
    {
      title: "Reset deck",
      description: "Restore the sample three-slide deck.",
      inputSchema: {},
    },
    async () => deckResult(deckStore.reset(), "Reset to the sample deck."),
  );

  return server;
}
