import type { Deck, Slide, SlideComponent, TextAlign } from "./types.ts";
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
  // No id: an exported file re-imported elsewhere must get its own deck.
  const payload = JSON.stringify({ ...deck, id: undefined, rawHtml: undefined });
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

export function fileSlug(title: string): string {
  return (title || "deck")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "deck";
}

function parseDeckJson(html: string): Deck | null {
  const match = html.match(
    /<script type="application\/json" id="deck-data">([\s\S]*?)<\/script>/,
  );
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as Deck;
    if (!parsed?.slides?.length) return null;
    return { ...parsed, width: SLIDE_WIDTH, height: SLIDE_HEIGHT };
  } catch {
    return null;
  }
}

function attr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return match?.[1] ?? "";
}

function styleValue(style: string, name: string): string {
  const match = style.match(new RegExp(`${name}\\s*:\\s*([^;]+)`, "i"));
  return match?.[1]?.trim() ?? "";
}

function px(value: string, fallback: number): number {
  const match = value.match(/(-?[\d.]+)/);
  return match ? Number(match[1]) : fallback;
}

function parseExportedDeck(html: string): Deck | null {
  if (!html.includes("data-component=")) return null;
  const blocks = [
    ...html.matchAll(
      /<section\b([^>]*)>([\s\S]*?)<\/section>/gi,
    ),
  ];
  if (!blocks.length) return null;
  const slides: Slide[] = [];
  for (const block of blocks) {
    const sectionTag = block[1] ?? "";
    const body = block[2] ?? "";
    const style = attr(sectionTag, "style");
    const slide: Slide = {
      id: attr(sectionTag, "data-slide") || uid("slide"),
      name: attr(sectionTag, "data-name") || `Slide ${slides.length + 1}`,
      background: styleValue(style, "background") || "#ffffff",
      components: [],
    };
    for (const match of body.matchAll(
      /<div\b([^>]*data-component="([^"]+)"[^>]*)>([\s\S]*?)<\/div>/gi,
    )) {
      const tag = match[1] ?? "";
      const type = match[2] as SlideComponent["type"];
      const inner = match[3] ?? "";
      const boxStyle = attr(tag, "style");
      const component: SlideComponent = {
        id: attr(tag, "data-id") || uid(type),
        type,
        name: attr(tag, "data-name") || type,
        x: px(styleValue(boxStyle, "left"), 0),
        y: px(styleValue(boxStyle, "top"), 0),
        width: px(styleValue(boxStyle, "width"), 200),
        height: px(styleValue(boxStyle, "height"), 80),
        opacity: Number(styleValue(boxStyle, "opacity") || 1),
        background: styleValue(boxStyle, "background") || undefined,
        borderRadius: px(styleValue(boxStyle, "border-radius"), 0) || undefined,
        border: styleValue(boxStyle, "border") || undefined,
      };
      if (type === "text") {
        const textStyle = inner.match(/style="([^"]*)"/)?.[1] ?? "";
        component.text = inner
          .replace(/<[^>]+>/g, "")
          .replaceAll("&amp;", "&")
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&quot;", '"');
        component.fontSize = px(styleValue(textStyle, "font-size"), 32);
        component.fontWeight = Number(styleValue(textStyle, "font-weight") || 500);
        component.fontFamily = styleValue(textStyle, "font-family") || undefined;
        component.color = styleValue(textStyle, "color") || "#111827";
        component.textAlign = (styleValue(textStyle, "text-align") as TextAlign) || "left";
      }
      if (type === "image") {
        component.src = inner.match(/src="([^"]*)"/)?.[1] ?? "";
      }
      if (type === "html") {
        component.html = inner;
      }
      slide.components.push(component);
    }
    slides.push(slide);
  }
  if (!slides.some((slide) => slide.components.length)) return null;
  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? "Imported deck";
  return {
    title,
    width: SLIDE_WIDTH,
    height: SLIDE_HEIGHT,
    slides,
    source: "user",
    updatedAt: new Date().toISOString(),
  };
}

function splitSlideMarkup(html: string): string[] {
  const slides = [
    ...html.matchAll(/<div\b[^>]*class="[^"]*\bslide\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi),
    ...html.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/gi),
  ].map((match) => match[0]);
  return slides.length ? slides : [html];
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/\s+/g, " ")
    .trim();
}

function extractApproxSlide(markup: string, index: number): Slide {
  const slide = emptySlide(`Slide ${index + 1}`);
  const open = markup.match(/^<[^>]+>/)?.[0] ?? "";
  const bg = styleValue(attr(open, "style"), "background") ||
    styleValue(attr(open, "style"), "background-color");
  if (bg) slide.background = bg;

  let y = 80;
  const texts = [
    ...markup.matchAll(
      /<(h[1-3]|p)([^>]*)>([\s\S]*?)<\/\1>/gi,
    ),
  ];
  for (const match of texts) {
    const text = stripTags(match[3] ?? "");
    if (text.length < 2) continue;
    const tag = (match[1] ?? "p").toLowerCase();
    const slot = attr(match[2] ?? "", "data-slot");
    const fontSize = tag === "h1" ? 56 : tag === "h2" ? 40 : tag === "h3" ? 28 : 24;
    const height = Math.max(48, Math.ceil(text.length / 48) * (fontSize + 10));
    slide.components.push({
      id: uid("text"),
      type: "text",
      name: slot || tag,
      x: 80,
      y,
      width: 1760,
      height,
      opacity: 1,
      text,
      fontSize,
      fontWeight: tag.startsWith("h") ? 600 : 400,
      fontFamily: "Inter, system-ui, sans-serif",
      color: "#111827",
      textAlign: "left",
      lineHeight: 1.25,
    });
    y += height + 24;
  }

  for (const match of markup.matchAll(/<img\b[^>]*src="([^"]+)"[^>]*>/gi)) {
    slide.components.push({
      id: uid("image"),
      type: "image",
      name: "Image",
      x: 120,
      y: Math.min(y, 720),
      width: 640,
      height: 360,
      opacity: 1,
      src: match[1],
      objectFit: "cover",
    });
  }

  if (!slide.components.length) {
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
  }
  return slide;
}

export function htmlToDeck(html: string): Deck {
  const existing = parseDeckJson(html);
  if (existing) return existing;

  const exported = parseExportedDeck(html);
  if (exported) return exported;

  const trimmed = html.trim();
  if (!trimmed) return emptyDeck("Imported deck");

  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? "Imported deck";
  const deck = emptyDeck(title);
  deck.rawHtml = trimmed;
  deck.slides = splitSlideMarkup(trimmed).map((block, index) =>
    extractApproxSlide(block, index),
  );
  return deck;
}

export function deckSummary(deck: Deck): string {
  return `${deck.title} · ${deck.slides.length} slide${deck.slides.length === 1 ? "" : "s"} · ${deck.source} · ${deck.updatedAt}`;
}
