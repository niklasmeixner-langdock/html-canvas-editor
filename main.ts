import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deckToHtml, fileSlug } from "./src/html.ts";
import { PPTX_MIME, deckToPptx } from "./src/pptx.ts";
import { deckStore } from "./src/store.ts";
import { createServer } from "./server.ts";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8788);

function sendCanvas(_req: Request, res: Response) {
  res.sendFile(path.join(rootDir, "dist", "mcp-app.html"));
}

function publicBaseUrl(req: Request): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol).split(",")[0]!.trim();
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? `localhost:${port}`)
    .split(",")[0]!
    .trim();
  return `${proto}://${host}`;
}

function sendDeckDownload(res: Response, html: string, title: string) {
  res.setHeader("Content-Disposition", `attachment; filename="${fileSlug(title)}.html"`);
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(html);
}

function requireMcpAuth(req: Request, res: Response, next: () => void) {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) {
    next();
    return;
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

async function start() {
  const canvasHtml = path.join(rootDir, "dist", "mcp-app.html");
  if (!fs.existsSync(canvasHtml)) {
    throw new Error("Missing dist/mcp-app.html. Run `npm run build` first.");
  }

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "12mb" }));

  app.get("/health", (_req, res) => {
    res.type("text/plain").send("ok\n");
  });

  // Standalone editor API (the MCP path goes through tools). Everything is
  // keyed by deck id; there is no server-wide current deck.
  app.post("/api/decks", (req, res) => {
    try {
      const html = typeof req.body?.html === "string" ? req.body.html : "";
      const deck = html.trim()
        ? deckStore.createFromHtml(html, "user")
        : req.body?.sample
          ? deckStore.createSample()
          : deckStore.createBlank(typeof req.body?.title === "string" ? req.body.title : undefined);
      res.json(deck);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid deck" });
    }
  });

  app.get("/api/decks/:id", (req, res) => {
    const deck = deckStore.get(String(req.params.id));
    if (!deck) {
      res.status(404).json({ error: "Unknown deck" });
      return;
    }
    res.json(deck);
  });

  app.put("/api/decks/:id", (req, res) => {
    try {
      res.json(deckStore.save({ ...req.body, id: String(req.params.id) }));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid deck" });
    }
  });

  // Download of an exact snapshot: the editor posts the deck it has on
  // screen, gets a short-lived id back, and opens /download/:id in a new tab.
  // Needed because the MCP host sandbox blocks <a download> inside the iframe.
  app.post("/api/snapshots", (req, res) => {
    try {
      if (!req.body?.slides?.length) throw new Error("Deck needs at least one slide");
      const id = deckStore.snapshot(req.body);
      res.json({ id, url: `${publicBaseUrl(req)}/download/${id}` });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid deck" });
    }
  });

  // PowerPoint export of the same snapshot. Declared before the plain route
  // so ":id" never swallows the extension.
  app.get("/download/:id.pptx", async (req, res) => {
    const deck = deckStore.readSnapshot(String(req.params.id));
    if (!deck) {
      res.status(404).type("text/plain").send("This download link has expired. Press PPTX in the editor again.\n");
      return;
    }
    try {
      const bytes = await deckToPptx(deck);
      res.setHeader("Content-Disposition", `attachment; filename="${fileSlug(deck.title)}.pptx"`);
      res.setHeader("Cache-Control", "no-store");
      res.type(PPTX_MIME).send(Buffer.from(bytes));
    } catch (error) {
      console.error("PPTX export failed:", error);
      res.status(500).type("text/plain").send("Could not build the PowerPoint file. Please try again.\n");
    }
  });

  app.get("/download/:id", (req, res) => {
    const deck = deckStore.readSnapshot(String(req.params.id));
    if (!deck) {
      res.status(404).type("text/plain").send("This download link has expired. Press Download in the editor again.\n");
      return;
    }
    sendDeckDownload(res, deckToHtml(deck), deck.title);
  });

  app.get("/", sendCanvas);
  app.get("/canvas", sendCanvas);
  app.use(express.static(path.join(rootDir, "dist")));

  app.all("/mcp", requireMcpAuth, async (req, res) => {
    const server = createServer(publicBaseUrl(req));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.listen(port, "0.0.0.0", () => {
    console.log(`HTML slide canvas on http://0.0.0.0:${port}`);
    console.log(`Editor: http://localhost:${port}/canvas`);
    console.log(`MCP:    http://localhost:${port}/mcp`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
