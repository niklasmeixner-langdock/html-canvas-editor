import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deckToHtml, fileSlug } from "./src/html.ts";
import { deckStore } from "./src/store.ts";
import { createServer } from "./server.ts";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8788);

function sendCanvas(_req: Request, res: Response) {
  res.sendFile(path.join(rootDir, "dist", "mcp-app.html"));
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

  app.get("/api/deck", (_req, res) => {
    res.json(deckStore.get());
  });

  app.put("/api/deck", (req, res) => {
    try {
      res.json(deckStore.save(req.body));
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid deck",
      });
    }
  });

  app.post("/api/deck/reset", (_req, res) => {
    res.json(deckStore.reset());
  });

  app.post("/api/deck/html", (req, res) => {
    const html =
      typeof req.body === "string"
        ? req.body
        : typeof req.body?.html === "string"
          ? req.body.html
          : "";
    if (!html.trim()) {
      res.status(400).json({ error: "html is required" });
      return;
    }
    res.json(deckStore.loadHtml(html, "user"));
  });

  app.get("/export", (req, res) => {
    const deck = deckStore.get();
    const html = deckToHtml(deck);
    if (req.query.download) {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileSlug(deck.title)}.html"`,
      );
    }
    res.type("html").send(html);
  });

  app.get("/", sendCanvas);
  app.get("/canvas", sendCanvas);
  app.use(express.static(path.join(rootDir, "dist")));

  app.all("/mcp", requireMcpAuth, async (req, res) => {
    const server = createServer();
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
