import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// zod v4 API: `.meta({ format: "file" })` is how Langdock detects file inputs.
import { z } from "zod/v4";
import { deckToHtml, deckSummary, fileSlug } from "./src/html.ts";
import { PPTX_MIME, deckToPptx } from "./src/pptx.ts";
import { deckStore } from "./src/store.ts";
import type { Deck } from "./src/types.ts";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const CANVAS_URI = "ui://html-canvas/editor.html";
const BASE_URL_MARKER = 'window.__CANVAS_BASE__=""';

export function deckFileUri(deckId: string, ext: "html" | "pptx" = "html"): string {
  return `file:///slides/${deckId}.${ext}`;
}

const deckSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  width: z.number(),
  height: z.number(),
  source: z.enum(["sample", "user", "agent"]).optional(),
  updatedAt: z.string().optional(),
  rawHtml: z.string().optional(),
  fontCss: z.string().optional(),
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
  .describe("The .html slide or deck the user attached in chat. Always use this for attachments (reference the attached file here).")
  .meta({ format: "file" });

type FileInput = z.infer<typeof fileSchema>;

const deckIdSchema = z
  .string()
  .describe("Deck id returned by open_slide_canvas (also shown in its result as `deckId`).");

function looksLikeHtml(text: string): boolean {
  return /<\s*(!doctype|html|body|section|div|h1|p)\b/i.test(text);
}

function decodeHtmlFile(file: FileInput): string {
  const html = Buffer.from(file.base64, "base64").toString("utf8");
  if (!looksLikeHtml(html)) {
    throw new Error(`${file.fileName} does not look like HTML (${file.mimeType}). Attach an .html slide or deck.`);
  }
  return html;
}

function titleFromFile(file: FileInput): string {
  return file.fileName.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "Imported deck";
}

/**
 * Some "HTML files" are just a shell that iframes the real page (preview
 * wrappers do this). Editing the shell gives a blank dark slide, so unwrap:
 * use `srcdoc` when present, fetch an http(s) `src` otherwise.
 */
async function unwrapIframeShell(html: string): Promise<string> {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const stripped = body.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const iframes = [...stripped.matchAll(/<iframe\b([^>]*)>/gi)];
  const textOutside = stripped.replace(/<iframe\b[\s\S]*?(?:<\/iframe>|>)/gi, "").replace(/<[^>]+>/g, "").trim();
  if (iframes.length !== 1 || textOutside.length > 40) return html;

  const attrs = iframes[0]![1] ?? "";
  const srcdoc = attrs.match(/\bsrcdoc\s*=\s*"([^"]*)"|\bsrcdoc\s*=\s*'([^']*)'/i);
  if (srcdoc) {
    const raw = srcdoc[1] ?? srcdoc[2] ?? "";
    return raw.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  }
  const src = attrs.match(/\bsrc\s*=\s*"([^"]*)"|\bsrc\s*=\s*'([^']*)'/i);
  const url = src?.[1] ?? src?.[2];
  if (!url || !/^https?:\/\//i.test(url)) return html;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "follow" });
    if (!response.ok) return html;
    const text = await response.text();
    return text.length <= 5_000_000 && looksLikeHtml(text) ? text : html;
  } catch {
    return html;
  }
}

/** A path or filename where markup was expected (e.g. `/mnt/data/deck.html`). */
function looksLikeFileReference(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.includes("<")) return false;
  return (
    trimmed.length < 400 &&
    (/^(\/mnt\/data\/|attachment\/\/|file:\/\/|https?:\/\/)/i.test(trimmed) || /\.html?$/i.test(trimmed))
  );
}

async function resolveHtml(input: { file?: FileInput; html?: string }): Promise<{ html: string; fallbackTitle?: string } | null> {
  if (input.file) {
    return { html: await unwrapIframeShell(decodeHtmlFile(input.file)), fallbackTitle: titleFromFile(input.file) };
  }
  const inline = input.html?.trim();
  if (!inline) return null;
  if (looksLikeFileReference(inline)) {
    throw new Error(
      `\`html\` received a file reference ("${inline}") instead of HTML markup. Attached files must be passed in the \`file\` parameter (pass the same reference there); \`html\` is only for raw markup.`,
    );
  }
  if (!looksLikeHtml(inline)) {
    throw new Error("`html` does not contain HTML markup. Pass raw HTML, or an attached file in `file`.");
  }
  return { html: await unwrapIframeShell(inline) };
}

function deckResult(deck: Deck, extra?: string) {
  const header = extra ? `${extra}\n\n` : "";
  // Keep the model-facing text small: the deck itself (which can carry inline
  // images) only matters to the canvas, which gets it via structuredContent.
  const slides = deck.slides
    .map((slide, index) => `${index + 1}. ${slide.name} (${slide.components.length} layers)`)
    .join("\n");
  return {
    content: [
      {
        type: "text" as const,
        text: `${header}deckId: ${deck.id}\n${deckSummary(deck)}\n${slides}`,
      },
    ],
    structuredContent: { deckId: deck.id, deck },
  };
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function unknownDeck(deckId: string) {
  return errorResult(
    `No deck with id "${deckId}" (never created, or expired after 7 days). Call open_slide_canvas to start a new one.`,
  );
}

async function readCanvasHtml(baseUrl: string): Promise<string> {
  const html = await fs.readFile(path.join(rootDir, "dist", "mcp-app.html"), "utf8");
  // The app runs inside the host's sandbox origin, so it needs to know where
  // this server lives to open download links.
  return html.replace(BASE_URL_MARKER, `window.__CANVAS_BASE__=${JSON.stringify(baseUrl)}`);
}

export function createServer(baseUrl = ""): McpServer {
  const server = new McpServer(
    { name: "langdock-slide-canvas", version: "0.2.0" },
    {
      instructions: [
        "Slide canvas: a Figma-like editor for 16:9 HTML slides that the user edits directly, without prompting you for each change.",
        "Use open_slide_canvas whenever the user wants to see, edit, or start slides. If they attached an .html file, pass it in the `file` parameter directly; never read the file or paste its path into `html`.",
        "The canvas persists its own edits. Only call export_slides_html (HTML) or export_slides_pptx (PowerPoint) when the user asks for the file or a download; both need the deckId from open_slide_canvas.",
        "Do not call save_deck; the canvas UI does that.",
      ].join(" "),
    },
  );

  registerAppTool(
    server,
    "open_slide_canvas",
    {
      title: "Open slide canvas",
      description: [
        "Open the interactive 16:9 slide canvas for the user. This is the only tool needed to start or continue editing; do not read or inspect the file first.",
        "If the user attached an .html file, pass it in `file` (the canvas opens with it loaded and every text/image/frame editable).",
        "Use `html` only for markup you wrote yourself. Pass `deckId` to reopen a deck from earlier in the conversation. With no input, opens a blank deck.",
      ].join(" "),
      inputSchema: {
        file: fileSchema.optional(),
        html: z
          .string()
          .optional()
          .describe(
            "Raw HTML markup you generated yourself, starting with a tag. NEVER a file path or filename: attached files go in `file`.",
          ),
        deckId: deckIdSchema.optional(),
        title: z.string().optional().describe("Deck title. Defaults to the file's <title> or filename."),
      },
      _meta: { ui: { resourceUri: CANVAS_URI } },
    },
    async (input) => {
      try {
        if (input.deckId) {
          const existing = deckStore.get(input.deckId);
          if (!existing) return unknownDeck(input.deckId);
          return deckResult(existing, "Reopened the canvas.");
        }
        const source = await resolveHtml(input);
        if (source) {
          const deck = deckStore.createFromHtml(source.html, "agent");
          const title = input.title ?? (deck.title === "Imported deck" ? source.fallbackTitle : undefined);
          if (title) deckStore.save({ ...deck, title }, "agent");
          return deckResult(
            deckStore.get(deck.id)!,
            input.file
              ? `Opened the canvas with ${input.file.fileName}. The user edits it directly; you do not need to do anything else.`
              : "Opened the canvas with the provided HTML.",
          );
        }
        const blank = deckStore.createBlank(input.title);
        return deckResult(blank, "Opened a blank canvas.");
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
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

  server.registerTool(
    "export_slides_html",
    {
      title: "Export slides as HTML",
      description: [
        "Return the deck as presentable, self-contained 16:9 HTML. Use only when the user asks for the HTML, the file, or a download.",
        "The result includes a resource link; read it to hand the user the file as an attachment.",
      ].join(" "),
      inputSchema: { deckId: deckIdSchema },
    },
    async ({ deckId }) => {
      const deck = deckStore.get(deckId);
      if (!deck) return unknownDeck(deckId);
      const html = deckToHtml(deck);
      const id = deckStore.snapshot(deck);
      return {
        content: [
          { type: "text" as const, text: html },
          {
            type: "resource_link" as const,
            uri: deckFileUri(deck.id!),
            name: `${fileSlug(deck.title)}.html`,
            mimeType: "text/html",
            description: "Read this resource to attach the deck as a downloadable file",
          },
        ],
        structuredContent: {
          deckId: deck.id,
          downloadUrl: baseUrl ? `${baseUrl}/download/${id}` : undefined,
        },
      };
    },
  );

  // Per-deck download resource. Langdock turns resources/read contents into
  // an attachment; the last path segment becomes the filename.
  server.registerResource(
    "deck-html",
    new ResourceTemplate("file:///slides/{deckId}.html", { list: undefined }),
    {
      title: "Slide deck HTML file",
      description: "The deck with this id as a downloadable .html file.",
      mimeType: "text/html",
    },
    async (uri, { deckId }) => {
      const deck = deckStore.get(String(deckId));
      if (!deck) throw new Error(`Unknown deck ${String(deckId)}`);
      return {
        contents: [{ uri: uri.href, mimeType: "text/html", text: deckToHtml(deck) }],
      };
    },
  );

  server.registerTool(
    "export_slides_pptx",
    {
      title: "Export slides as PowerPoint",
      description: [
        "Return the deck as a .pptx with native, editable shapes (text boxes, pictures, rectangles) and the entrance animations as PowerPoint animations.",
        "Use only when the user asks for PowerPoint / pptx. The result includes a resource link; read it to hand the user the file as an attachment.",
      ].join(" "),
      inputSchema: { deckId: deckIdSchema },
    },
    async ({ deckId }) => {
      const deck = deckStore.get(deckId);
      if (!deck) return unknownDeck(deckId);
      const id = deckStore.snapshot(deck);
      return {
        content: [
          { type: "text" as const, text: `${deckSummary(deck)}. Read the linked resource to attach the PowerPoint file.` },
          {
            type: "resource_link" as const,
            uri: deckFileUri(deck.id!, "pptx"),
            name: `${fileSlug(deck.title)}.pptx`,
            mimeType: PPTX_MIME,
            description: "Read this resource to attach the deck as a downloadable .pptx",
          },
        ],
        structuredContent: {
          deckId: deck.id,
          downloadUrl: baseUrl ? `${baseUrl}/download/${id}.pptx` : undefined,
        },
      };
    },
  );

  server.registerResource(
    "deck-pptx",
    new ResourceTemplate("file:///slides/{deckId}.pptx", { list: undefined }),
    {
      title: "Slide deck PowerPoint file",
      description: "The deck with this id as a downloadable .pptx.",
      mimeType: PPTX_MIME,
    },
    async (uri, { deckId }) => {
      const deck = deckStore.get(String(deckId));
      if (!deck) throw new Error(`Unknown deck ${String(deckId)}`);
      const bytes = await deckToPptx(deck);
      return {
        contents: [{ uri: uri.href, mimeType: PPTX_MIME, blob: Buffer.from(bytes).toString("base64") }],
      };
    },
  );

  // Called by the canvas UI after edits. Hidden from the model.
  registerAppTool(
    server,
    "save_deck",
    {
      title: "Save deck (internal)",
      description: "Internal: the canvas UI persists its edits with this. Do not call it yourself.",
      inputSchema: { deck: deckSchema },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ deck }) => deckResult(deckStore.save(deck as Deck, "user"), "Saved."),
  );

  return server;
}
