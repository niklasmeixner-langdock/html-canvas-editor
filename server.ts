import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// zod v4 API: `.meta({ format: "file" })` is how Langdock detects file inputs.
import { z } from "zod/v4";
import { deckToHtml, deckSummary, fileSlug } from "./src/html.ts";
import { deckStore } from "./src/store.ts";
import type { Deck } from "./src/types.ts";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const CANVAS_URI = "ui://html-canvas/editor.html";
// Static URI so Langdock can discover it at setup time. The last path segment
// becomes the attachment filename (see Langdock "MCP File Outputs").
export const DECK_FILE_URI = "file:///slides/langdock-slides.html";
const BASE_URL_MARKER = 'window.__CANVAS_BASE__=""';

const deckSchema = z.object({
  title: z.string(),
  width: z.number(),
  height: z.number(),
  source: z.enum(["sample", "user", "agent"]).optional(),
  updatedAt: z.string().optional(),
  slides: z.array(z.record(z.string(), z.unknown())),
});

/**
 * Langdock file input. When a user attaches an .html file in chat and the
 * model references it, Langdock resolves it into this object before the call
 * reaches us (docs: "File Input in MCP Tools").
 */
const fileSchema = z
  .object({
    fileName: z.string(),
    mimeType: z.string(),
    base64: z.string(),
    size: z.number().optional(),
  })
  .describe("An .html slide or deck attached in chat. Preferred over `html` for uploads.")
  .meta({ format: "file" });

type FileInput = z.infer<typeof fileSchema>;

function decodeHtmlFile(file: FileInput): string {
  const html = Buffer.from(file.base64, "base64").toString("utf8");
  const looksHtml = /<\s*(!doctype|html|body|section|div|h1|p)\b/i.test(html);
  if (!looksHtml) {
    throw new Error(`${file.fileName} does not look like HTML (${file.mimeType}). Attach an .html slide or deck.`);
  }
  return html;
}

function titleFromFile(file: FileInput): string {
  return file.fileName.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "Imported deck";
}

/** Resolve whichever source the model gave us into HTML, or nothing. */
function resolveHtml(input: { file?: FileInput; html?: string }): { html: string; fallbackTitle?: string } | null {
  if (input.file) {
    return { html: decodeHtmlFile(input.file), fallbackTitle: titleFromFile(input.file) };
  }
  if (input.html?.trim()) return { html: input.html };
  return null;
}

/** Load HTML into the store; explicit title > <title> in the HTML > filename. */
function loadSource(source: { html: string; fallbackTitle?: string }, explicitTitle?: string): Deck {
  const deck = deckStore.loadHtml(source.html, "agent");
  const title = explicitTitle ?? (deck.title === "Imported deck" ? source.fallbackTitle : undefined);
  if (title) {
    deck.title = title;
    deckStore.save(deck, "agent");
  }
  return deck;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
  };
}

function deckResult(deck: Deck, extra?: string) {
  const header = extra ? `${extra}\n\n` : "";
  // Keep the model-facing text small: the raw imported HTML only matters to
  // the canvas, which gets it via structuredContent.
  const { rawHtml: _rawHtml, ...forModel } = deck;
  return {
    content: [
      {
        type: "text" as const,
        text: `${header}${deckSummary(deck)}\n\n${JSON.stringify(forModel, null, 2)}`,
      },
    ],
    structuredContent: { deck },
  };
}

async function readCanvasHtml(baseUrl: string): Promise<string> {
  const html = await fs.readFile(path.join(rootDir, "dist", "mcp-app.html"), "utf8");
  // The app runs inside the host's sandbox origin, so it needs to know where
  // this server lives to open download links.
  return html.replace(BASE_URL_MARKER, `window.__CANVAS_BASE__=${JSON.stringify(baseUrl)}`);
}

export function createServer(baseUrl = ""): McpServer {
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
        "Open the 16:9 HTML slide canvas. When the user attaches or mentions an .html slide, pass it as `file` so the canvas opens with it already loaded and editable in one step. Use this instead of load_html whenever the user should see the editor.",
      inputSchema: {
        file: fileSchema.optional(),
        html: z
          .string()
          .optional()
          .describe("Inline HTML for a deck or single slide when there is no attached file."),
        title: z.string().optional().describe("Deck title override"),
      },
      _meta: { ui: { resourceUri: CANVAS_URI } },
    },
    async (input) => {
      try {
        const source = resolveHtml(input);
        if (source) {
          const deck = loadSource(source, input.title);
          return deckResult(
            deck,
            input.file
              ? `Opened the canvas with ${input.file.fileName}. The user can now edit it directly.`
              : "Opened the canvas with the provided HTML.",
          );
        }
        return deckResult(deckStore.get(), "Opened the current HTML slide canvas.");
      } catch (error) {
        return errorResult(error);
      }
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
          text: await readCanvasHtml(baseUrl),
        },
      ],
    }),
  );

  // Langdock turns resources/read contents with a mimeType into a downloadable
  // attachment. This is the "give me the file" path from chat.
  server.registerResource(
    "deck-html",
    DECK_FILE_URI,
    {
      title: "Slide deck HTML file",
      description:
        "Download the current 16:9 slide deck as a presentable HTML file. Read this after edits to hand the user the file.",
      mimeType: "text/html",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/html",
          text: deckToHtml(deckStore.get()),
        },
      ],
    }),
  );

  // Also an app tool: loading a file shows the canvas right away instead of
  // needing a second show_editor call.
  registerAppTool(
    server,
    "load_html",
    {
      title: "Load HTML into the canvas",
      description:
        "Replace the current deck with an attached .html file or inline HTML and show the canvas. Existing slides become editable layers.",
      inputSchema: {
        file: fileSchema.optional(),
        html: z.string().optional().describe("Inline HTML for one slide or a full deck"),
        title: z.string().optional(),
      },
      _meta: { ui: { resourceUri: CANVAS_URI } },
    },
    async (input) => {
      try {
        const source = resolveHtml(input);
        if (!source) return errorResult("Pass an attached .html file as `file` or inline `html`.");
        const deck = loadSource(source, input.title);
        return deckResult(deck, "Loaded HTML into the canvas.");
      } catch (error) {
        return errorResult(error);
      }
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
      description:
        `Return presentable 16:9 HTML for the current deck, including round-trip JSON. To give the user a downloadable file instead, read the resource ${DECK_FILE_URI}.`,
      inputSchema: {},
    },
    async () => {
      const deck = deckStore.get();
      const html = deckToHtml(deck);
      return {
        content: [
          { type: "text" as const, text: html },
          {
            type: "resource_link" as const,
            uri: DECK_FILE_URI,
            name: `${fileSlug(deck.title)}.html`,
            mimeType: "text/html",
            description: "Read this resource to attach the deck as a file",
          },
        ],
        structuredContent: { deck, html, downloadUrl: baseUrl ? `${baseUrl}/export?download=1` : undefined },
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
