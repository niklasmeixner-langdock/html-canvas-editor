# HTML slide canvas

Figma-like **16:9 HTML slide editor**. The agent can drop a first draft in; you move type, frames, and images without another prompt.

This is a standalone MCP App. Same pattern as the Camunda canvas: a real iframe UI plus `/mcp`.

## What you get

| URL | Purpose |
| --- | --- |
| `/` | Landing page with the editor in an iframe |
| `/canvas` | The editor |
| `/export` | Current deck as presentable HTML |
| `/mcp` | Streamable HTTP MCP endpoint for Langdock |
| `/health` | Health check |

MCP tools:

- `show_editor` — opens the MCP App; optional `html` loads a draft first
- `load_html` / `get_deck` / `save_deck` / `export_html`
- `add_slide` / `reset_deck`

MCP resource `file:///slides/langdock-slides.html` returns the current deck as
`text/html`. Langdock turns that into a downloadable attachment, so "give me
the file" in chat works ([MCP file outputs](https://docs.langdock.com/en/using-langdock/guides/integrations/mcp/mcp-file-outputs)).

Edits stay in memory on this service.

## Download inside Langdock

Langdock mounts the app in a sandbox without `allow-downloads`, so a plain
`<a download>` is a no-op there. The Download button therefore saves the deck
via `save_deck`, posts a snapshot to `/api/deck/snapshot`, and asks the host to
open `/download/:id` in a new tab (15 minute link). The server injects its
public URL into the app HTML for this; set `PUBLIC_URL` if it sits behind a
proxy that hides the host (Railway is detected automatically).

## Editor

- 1920×1080 slides, zoom/pan, 8px snap (hold Alt to disable)
- Insert **text**, **image**, or **frame**
- Drag to move, handles to resize, double-click text to edit
- Layers, undo (`⌘Z`), duplicate (`⌘D`), arrow-key nudge
- Open or drop an existing `.html` slide — layers become editable
- Copy or download HTML. Deck JSON is embedded so the next `load_html` round-trips.

## Run locally

```bash
pnpm install   # or npm install
pnpm build     # or npm run build
pnpm start     # or npm start
```

Open [http://localhost:8788](http://localhost:8788). If that port is taken: `PORT=3010 pnpm start`.

Dev mode (rebuilds the UI on change):

```bash
pnpm dev
```

## Connect Langdock

1. Deploy or run the server so `/mcp` is reachable.
2. Add a custom MCP server in Langdock pointing at `https://<host>/mcp`.
3. Ask the assistant to **show the HTML slide canvas**.
4. Langdock should render the MCP App iframe after `show_editor`.

If you set `MCP_AUTH_TOKEN`, send `Authorization: Bearer <token>`.

## Railway

Normal Node service (`npm run build` then `npm start`, binds `PORT`). After deploy, generate a public domain and use `https://<service>.up.railway.app/mcp`.
