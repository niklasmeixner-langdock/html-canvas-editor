import type { Deck, Slide, SlideComponent } from "./types.ts";
import {
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  emptyDeck,
  emptySlide,
  uid,
} from "./types.ts";

const DECK_MARKER = "deck-data";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function cssSize(component: SlideComponent): string {
  return [
    `position:absolute`,
    `left:${component.x}px`,
    `top:${component.y}px`,
    `width:${component.width}px`,
    `height:${component.height}px`,
    `opacity:${component.opacity}`,
    component.borderRadius != null
      ? `border-radius:${component.borderRadius}px`
      : "",
    component.background ? `background:${component.background}` : "",
    component.border ? `border:${component.border}` : "",
    component.padding != null ? `padding:${component.padding}px` : "",
    `box-sizing:border-box`,
    `overflow:hidden`,
  ]
    .filter(Boolean)
    .join(";");
}

function renderComponent(component: SlideComponent): string {
  const common = `data-component="${component.type}" data-id="${component.id}" data-name="${escapeHtml(component.name)}" style="${cssSize(component)}"`;

  if (component.type === "text") {
    const style = [
      `font-size:${component.fontSize ?? 32}px`,
      `font-weight:${component.fontWeight ?? 500}`,
      `font-family:${component.fontFamily ?? "Inter, system-ui, sans-serif"}`,
      `color:${component.color ?? "#111827"}`,
      `text-align:${component.textAlign ?? "left"}`,
      `line-height:${component.lineHeight ?? 1.25}`,
      `white-space:pre-wrap`,
    ].join(";");
    return `<div ${common}><div style="${style}">${escapeHtml(component.text ?? "")}</div></div>`;
  }

  if (component.type === "image") {
    const src = escapeHtml(component.src ?? "");
    const fit = component.objectFit ?? "cover";
    return `<div ${common}><img src="${src}" alt="${escapeHtml(component.name)}" style="width:100%;height:100%;object-fit:${fit};display:block" /></div>`;
  }

  if (component.type === "html") {
    return `<div ${common}>${component.html ?? ""}</div>`;
  }

  return `<div ${common}></div>`;
}

function renderSlide(slide: Slide, index: number): string {
  return `<section class="slide" data-slide="${slide.id}" data-name="${escapeHtml(slide.name)}" style="width:${SLIDE_WIDTH}px;height:${SLIDE_HEIGHT}px;position:relative;overflow:hidden;background:${slide.background}">
${slide.components.map(renderComponent).join("\n")}
</section><!-- slide ${index + 1} -->`;
}

export function deckToHtml(deck: Deck): string {
  const payload = JSON.stringify(deck);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(deck.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    html, body { margin: 0; background: #0b1220; }
    .deck { display: flex; flex-direction: column; align-items: center; gap: 32px; padding: 32px 0 80px; }
    .slide { box-shadow: 0 24px 80px rgba(0,0,0,.35); }
    @media print {
      html, body { background: #fff; }
      .deck { gap: 0; padding: 0; }
      .slide { box-shadow: none; page-break-after: always; }
    }
  </style>
</head>
<body>
  <main class="deck">
${deck.slides.map(renderSlide).join("\n")}
  </main>
  <script type="application/json" id="${DECK_MARKER}">${payload.replaceAll("<", "\\u003c")}</script>
</body>
</html>
`;
}

function parseDeckJson(html: string): Deck | null {
  const match = html.match(
    /<script type="application\/json" id="deck-data">([\s\S]*?)<\/script>/,
  );
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1]) as Deck;
    if (!parsed?.slides?.length) {
      return null;
    }
    return {
      ...parsed,
      width: SLIDE_WIDTH,
      height: SLIDE_HEIGHT,
    };
  } catch {
    return null;
  }
}

function splitSections(html: string): string[] {
  const sections = [...html.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/gi)].map(
    (match) => match[0],
  );
  return sections.length ? sections : [html];
}

function wrapAsHtmlSlide(markup: string, name: string): Slide {
  const slide = emptySlide(name);
  slide.components.push({
    id: uid("html"),
    type: "html",
    name: "Imported HTML",
    x: 0,
    y: 0,
    width: SLIDE_WIDTH,
    height: SLIDE_HEIGHT,
    opacity: 1,
    html: markup.trim(),
  });
  return slide;
}

export function htmlToDeck(html: string): Deck {
  const existing = parseDeckJson(html);
  if (existing) {
    return existing;
  }

  const trimmed = html.trim();
  if (!trimmed) {
    return emptyDeck("Imported deck");
  }

  const sections = splitSections(trimmed);
  const deck = emptyDeck("Imported deck");
  deck.slides = sections.map((section, index) =>
    wrapAsHtmlSlide(section, `Imported ${index + 1}`),
  );
  return deck;
}

export function deckSummary(deck: Deck): string {
  return `${deck.title} · ${deck.slides.length} slide${deck.slides.length === 1 ? "" : "s"} · ${deck.source} · ${deck.updatedAt}`;
}
