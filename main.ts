import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import type { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deckToHtml } from "./src/html.ts";
import { deckStore } from "./src/store.ts";
import { createServer } from "./server.ts";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8788);

function landingPage(req: Request): string {
  const origin = `${req.protocol}://${req.get("host")}`;
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>HTML slide canvas</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }
      body { margin: 0; background: #111; color: #eee; }
      main { max-width: 1200px; margin: 0 auto; padding: 24px; }
      h1 { font-size: 1.35rem; margin: 0 0 8px; }
      p { line-height: 1.5; color: #bbb; }
      code { background: #222; padding: 1px 6px; border-radius: 4px; }
      .meta { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0 20px; }
      .pill { background: #1c1c1c; border: 1px solid #333; border-radius: 999px; padding: 6px 12px; font-size: 0.9rem; }
      iframe { width: 100%; height: 78vh; min-height: 640px; border: 1px solid #333; border-radius: 12px; background: #1c1c1c; }
    </style>
  </head>
  <body>
    <main>
      <h1>HTML slide canvas</h1>
      <p>Figma-like 16:9 editor for HTML decks. Same UI is the MCP App via <code>show_editor</code>.</p>
      <div class="meta">
        <span class="pill">MCP <code>${origin}/mcp</code></span>
        <span class="pill">Canvas <code>${origin}/canvas</code></span>
        <span class="pill">Export <code>${origin}/export</code></span>
      </div>
      <iframe title="HTML slide canvas" src="/canvas"></iframe>
    </main>
  </body>
</html>`;
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
    const html = typeof req.body?.html === "string" ? req.body.html : "";
    if (!html.trim()) {
      res.status(400).json({ error: "html is required" });
      return;
    }
    res.json(deckStore.loadHtml(html, "agent"));
  });

  app.get("/export", (_req, res) => {
    res.type("html").send(deckToHtml(deckStore.get()));
  });

  app.get("/", (req, res) => {
    res.type("html").send(landingPage(req));
  });

  app.get("/canvas", (_req, res) => {
    res.sendFile(path.join(rootDir, "dist", "mcp-app.html"));
  });
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
