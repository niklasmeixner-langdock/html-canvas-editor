# HTML slide canvas

Figma-like **16:9 HTML slide editor**. The agent can drop a first draft in; you move type, frames, and images without another prompt.

This is a standalone MCP App. Same pattern as the Camunda canvas: a real iframe UI plus `/mcp`.

## What you get

| URL | Purpose |
| --- | --- |
| `/` or `/canvas` | The editor (standalone; `?deck=<id>` keeps your deck across reloads) |
| `/download/:snapshotId` | Deck download, 15 minute link |
| `/mcp` | Streamable HTTP MCP endpoint for Langdock |
| `/health` | Health check |

## MCP surface

Deliberately small so the model picks the right one:

- `open_slide_canvas` — the only tool needed to start or continue. Pass an
  attached `.html` as `file` (Langdock resolves chat attachments into
  `{ fileName, mimeType, base64 }` via `format: "file"`, see
  [file input](https://docs.langdock.com/en/using-langdock/guides/integrations/mcp/mcp-file-input)),
  inline `html`, a `deckId` to reopen, or nothing for a blank deck. The canvas
  renders with the deck loaded and returns its `deckId`.
- `export_slides_html` — `deckId` → presentable HTML plus a `resource_link` to
  `file:///slides/<deckId>.html`. Reading that resource makes Langdock attach
  the file ([MCP file outputs](https://docs.langdock.com/en/using-langdock/guides/integrations/mcp/mcp-file-outputs)).
- `save_deck` — app-only (`_meta.ui.visibility: ["app"]`); fallback save path
  for the canvas. Not for the model.

The canvas normally saves with a direct `PUT /api/decks/:id` to this server
rather than through `save_deck`: tool calls from an app go through the host's
API, and Langdock rejects inputs over 1 MB (`Input too large`), which any deck
with inline images exceeds. Same for downloads (`POST /api/snapshots`).

Attach a slide in chat and say "open this in the canvas" — one tool call.

### Isolation

MCP hosts call this server statelessly and send no per-conversation identity,
so every deck gets a server-minted id and **all** state is keyed by it. There
is no "current deck": a caller only reaches a deck whose id they were given.
Imports always mint a new id (exported files carry none). Decks live in memory
for 7 days.

## Download inside Langdock

Langdock mounts the app in a sandbox without `allow-downloads`, so a plain
`<a download>` is a no-op there. The Download button therefore posts the deck
on screen to `/api/snapshots` and asks the host to open `/download/:id` in a
new tab; it does not wait on a save. The server injects its public URL into the
app HTML for this; set `PUBLIC_URL` if it sits behind a proxy that hides the
host (Railway is detected automatically).

## Import fidelity

Imported HTML is flattened in the browser into real layers (text, image,
frame) using computed layout, so any slide becomes editable — not just decks
exported from here. Inside Langdock's sandbox a nested iframe is opaque, so the
flatten runs in a Shadow DOM container instead. Translucent colours, gradients
and opacity are preserved; hidden "presentation mode" slides are recovered;
nav/controls are dropped; iframe shell pages are unwrapped; inline `<svg>`
becomes an image layer with its computed colours baked in.

The shadow container has to stand in for the document: `:root`, `html` and
`body` selectors are rewritten to the wrapper (otherwise every `var(--…)`
defined on `:root` silently falls back and the deck loses its theme),
`<html>`/`<body>` attributes such as `data-theme` are copied over, `vw`/`vh`
are pinned to 1920×1080 and `rem` to the deck's own `html { font-size }`.
Known gap: `::before`/`::after` pseudo-elements are not captured.

Interactive presentation files (stage + thumbnail rail + nav script) are
handled as decks, not as apps: thumbnails and rails are excluded (by ancestor
and by geometry — a slide is big and roughly 16:9), every slide gets the
`active`/`current`-style classes its script would have added so gated content
shows, per-word reveal `<span>`s collapse back into one heading, and type is
scaled with the geometry when the stage is narrower than 1920px.

Layout is measured only after stylesheets, webfonts and images have loaded,
with every entrance animation jumped to its final keyframe (otherwise staggered
fade-ups produce faint, displaced layers). The deck's webfont CSS
(`@import`/`@font-face`) travels with it as `fontCss`, so the editor and the
export wrap text exactly like the source did; `letter-spacing` and
`text-transform` are captured for the same reason.

## Editor

- 1920×1080 slides, 8px snap (hold Alt to disable)
- Navigation like Figma: drag empty canvas (or Space/middle-drag) to pan,
  scroll to pan, ⌘/Ctrl+scroll or pinch to zoom around the cursor, Fit to reset
- Insert **text**, **image**, or **frame**
- Drag to move, handles to resize, double-click text to edit
- Layers, undo (`⌘Z`), duplicate (`⌘D`), arrow-key nudge
- Existing decks come in through chat (`open_slide_canvas` with the attached
  file); there is deliberately no in-app file picker
- Copy or download HTML. Deck JSON is embedded so a re-import round-trips.

### Surfaces

The app reads the host's MCP Apps display mode and lays itself out per surface
(`data-mode` on `#app`, see `mcp-app.ts`):

- **inline** (chat card): slides only — canvas, filmstrip, Download. Plain
  scroll is left to the chat (a stray wheel used to pan the slide out of view);
  ⌘/Ctrl+scroll still zooms. The app reports a 600px height, the host's cap.
- **pip** (side panel): panels start minimised (icon tools, no properties).
  The top bar gets a panel toggle and a Full screen button
  (`ui/request-display-mode`).
- **fullscreen** / standalone: the full editor; below 900px the rail goes
  icon-only, below 560px it hides.

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
