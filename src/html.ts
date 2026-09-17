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
    // Text spills rather than disappears when a viewer's font metrics differ
    // by a hair from where the layer was measured; the editor does the same.
    component.type === "text" ? `overflow:visible` : `overflow:hidden`,
  ]
    .filter(Boolean)
    .join(";");
}

function renderComponent(component: SlideComponent): string {
  // Every style value is attribute-escaped: computed font stacks carry double
  // quotes ("STK Bureau Sans"), which would otherwise end the attribute early
  // and drop the font and everything declared after it.
  const common = `data-component="${component.type}" data-id="${component.id}" data-name="${escapeHtml(component.name)}" style="${escapeHtml(cssSize(component))}"`;

  if (component.type === "text") {
    const style = [
      `font-size:${component.fontSize ?? 32}px`,
      `font-weight:${component.fontWeight ?? 500}`,
      `font-family:${component.fontFamily ?? "Inter, system-ui, sans-serif"}`,
      `color:${component.color ?? "#111827"}`,
      `text-align:${component.textAlign ?? "left"}`,
      `line-height:${component.lineHeight ?? 1.25}`,
      component.letterSpacing != null ? `letter-spacing:${component.letterSpacing}px` : "",
      `white-space:pre-wrap`,
    ]
      .filter(Boolean)
      .join(";");
    return `<div ${common}><div style="${escapeHtml(style)}">${escapeHtml(component.text ?? "")}</div></div>`;
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
  // Build steps: the presentation script reveals these on click, in order.
  const body = slide.components
    .map((component) => {
      const html = renderComponent(component);
      const step = component.animation?.step;
      return step ? html.replace("<div data-component=", `<div data-step="${step}" data-component=`) : html;
    })
    .join("\n");
  return `<section class="slide" data-slide="${slide.id}" data-name="${escapeHtml(slide.name)}" style="width:${SLIDE_WIDTH}px;height:${SLIDE_HEIGHT}px;background:${escapeHtml(slide.background)}">
${body}
</section><!-- slide ${index + 1} -->`;
}

/** Keyframes for the effects in `AnimationEffect`; shared by export and editor preview. */
export const ANIMATION_KEYFRAMES = `@keyframes ld-fade{from{opacity:0}}
@keyframes ld-fade-up{from{opacity:0;transform:translateY(32px)}}
@keyframes ld-fade-down{from{opacity:0;transform:translateY(-32px)}}
@keyframes ld-fade-left{from{opacity:0;transform:translateX(32px)}}
@keyframes ld-fade-right{from{opacity:0;transform:translateX(-32px)}}
@keyframes ld-scale{from{opacity:0;transform:scale(.94)}}`;

/** Gap between click-revealed build steps when the deck plays on its own. */
export const STEP_GAP_MS = 450;

/**
 * `animation` shorthand for a layer, or "" when it has none. With `autoSteps`
 * (the editor's Play button) build steps are sequenced on a timer; the
 * exported presentation reveals them on click instead, so it leaves that out.
 */
export function animationValue(component: SlideComponent, autoSteps = true): string {
  const anim = component.animation;
  if (!anim) return "";
  const delay = anim.delay + (autoSteps && anim.step ? anim.step * STEP_GAP_MS : 0);
  return `ld-${anim.effect} ${anim.duration}ms cubic-bezier(.2,.7,.2,1) ${delay}ms both`;
}

/**
 * Preserved entrances. Each animated layer gets its own rule; they run when
 * the slide becomes active, build steps when the script reveals them, and
 * never for print or reduced-motion.
 */
function animationCss(deck: Deck): string {
  const rules = deck.slides.flatMap((slide) =>
    slide.components
      .filter((component) => component.animation)
      .map(
        (component) =>
          `.slide.active[data-slide="${slide.id}"] [data-id="${component.id}"]{animation:${animationValue(component, false)}}`,
      ),
  );
  if (!rules.length) return "";
  return `
    ${ANIMATION_KEYFRAMES}
    ${rules.join("\n    ")}
    @media print, (prefers-reduced-motion: reduce){ .slide [data-id]{animation:none!important} }
  `;
}

/**
 * Presentation chrome: one slide at a time, scaled to the window, keyboard /
 * click / swipe navigation, click-revealed build steps, an overview grid on
 * Esc, the slide number in the URL hash. Print gets every slide on its own
 * page. Kept dependency-free and small so the file stays a plain HTML deck.
 */
const PRESENTATION_CSS = `
    html, body { margin: 0; height: 100%; background: #0b1220; overflow: hidden; font-family: Inter, system-ui, sans-serif; }
    .deck { position: fixed; inset: 0; }
    .slide { position: absolute; left: 50%; top: 50%; display: none; overflow: hidden; transform: translate(-50%, -50%) scale(var(--s, 1)); transform-origin: center; box-shadow: 0 24px 80px rgba(0,0,0,.35); }
    .slide.active { display: block; }
    .slide.active [data-step].pending { opacity: 0 !important; animation: none !important; }
    /* HUD: only while the pointer moves, so it never sits on a slide's own footer. */
    .counter, .hint, .progress { opacity: 0; transition: opacity .4s; pointer-events: none; user-select: none; }
    body.hud .counter, body.hud .hint, body.hud .progress { opacity: 1; }
    .counter { position: fixed; right: 16px; bottom: 12px; padding: 3px 8px; border-radius: 6px; background: rgba(11,18,32,.7); color: rgba(255,255,255,.75); font-size: 12px; letter-spacing: .02em; }
    .progress { position: fixed; left: 0; bottom: 0; height: 2px; width: 0; background: #4469fc; transition: width .25s ease, opacity .4s; }
    .hint { position: fixed; left: 16px; bottom: 10px; padding: 3px 8px; border-radius: 6px; background: rgba(11,18,32,.7); color: rgba(255,255,255,.6); font-size: 12px; }
    body.overview .deck { overflow: auto; padding: 32px; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 24px; align-content: start; }
    body.overview .slide { display: block; position: relative; left: auto; top: auto; transform: none; zoom: 0.2; cursor: pointer; outline: 8px solid transparent; }
    body.overview .slide.active { outline-color: #4469fc; }
    body.overview .slide [data-step].pending { opacity: 1 !important; }
    body.overview .counter, body.overview .progress, body.overview .hint { display: none; }
    @page { size: ${SLIDE_WIDTH}px ${SLIDE_HEIGHT}px; margin: 0; }
    @media print {
      html, body { background: #fff; overflow: visible; height: auto; }
      .deck { position: static; }
      .slide { display: block; position: relative; left: auto; top: auto; transform: none; box-shadow: none; page-break-after: always; }
      .slide [data-step].pending { opacity: 1 !important; }
      .counter, .progress, .hint { display: none; }
    }`;

const PRESENTATION_SCRIPT = `<script>
(function(){
var slides=[].slice.call(document.querySelectorAll(".slide")),n=slides.length,i=0,body=document.body;
var counter=document.querySelector(".counter"),progress=document.querySelector(".progress"),hint=document.querySelector(".hint");
function fit(){var s=Math.min(innerWidth/${SLIDE_WIDTH},innerHeight/${SLIDE_HEIGHT});document.documentElement.style.setProperty("--s",s)}
function steps(s){return [].slice.call(s.querySelectorAll("[data-step]"))}
function pending(s){return steps(s).filter(function(e){return e.classList.contains("pending")})}
function show(k,fromBack){i=Math.max(0,Math.min(n-1,k));slides.forEach(function(s,j){s.classList.toggle("active",j===i)});
 steps(slides[i]).forEach(function(e){e.classList.toggle("pending",!fromBack)});
 counter.textContent=(i+1)+" / "+n;progress.style.width=((i+1)/n*100)+"%";history.replaceState(null,"","#"+(i+1))}
function next(){var p=pending(slides[i]);if(p.length){var m=Math.min.apply(null,p.map(function(e){return +e.dataset.step}));p.forEach(function(e){if(+e.dataset.step===m)e.classList.remove("pending")});return}if(i<n-1)show(i+1)}
function prev(){var shown=steps(slides[i]).filter(function(e){return !e.classList.contains("pending")});if(shown.length){var m=Math.max.apply(null,shown.map(function(e){return +e.dataset.step}));shown.forEach(function(e){if(+e.dataset.step===m)e.classList.add("pending")});return}if(i>0)show(i-1,true)}
function overview(on){body.classList.toggle("overview",on);if(on&&slides[i].scrollIntoView)slides[i].scrollIntoView({block:"center"})}
addEventListener("resize",fit);fit();
show(Math.max(0,(parseInt(location.hash.slice(1),10)||1)-1));
addEventListener("keydown",function(e){
 if(e.metaKey||e.ctrlKey||e.altKey)return;
 if(["ArrowRight","ArrowDown"," ","PageDown","Enter"].indexOf(e.key)>-1){e.preventDefault();body.classList.contains("overview")?show(i+1):next()}
 else if(["ArrowLeft","ArrowUp","PageUp","Backspace"].indexOf(e.key)>-1){e.preventDefault();body.classList.contains("overview")?show(i-1):prev()}
 else if(e.key==="Home"){e.preventDefault();show(0)}else if(e.key==="End"){e.preventDefault();show(n-1)}
 else if(e.key==="Escape"||e.key==="o"){overview(!body.classList.contains("overview"))}
 else if(e.key==="f"){document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen()}
});
document.addEventListener("click",function(e){
 if(e.target.closest("a,button,input,textarea,select")){return}
 var s=e.target.closest(".slide");
 if(body.classList.contains("overview")){if(s){show(slides.indexOf(s),true);overview(false)}return}
 e.clientX<innerWidth*0.2?prev():next()});
var tx=null;addEventListener("touchstart",function(e){tx=e.touches[0].clientX},{passive:true});
addEventListener("touchend",function(e){if(tx===null)return;var dx=e.changedTouches[0].clientX-tx;tx=null;if(Math.abs(dx)>40){dx<0?next():prev()}});
addEventListener("hashchange",function(){var k=(parseInt(location.hash.slice(1),10)||1)-1;if(k!==i)show(k,true)});
var hudTimer;function hud(){body.classList.add("hud");clearTimeout(hudTimer);hudTimer=setTimeout(function(){body.classList.remove("hud")},2500)}
addEventListener("mousemove",hud);addEventListener("touchstart",hud,{passive:true});hud();
setTimeout(function(){hint.remove()},8000);
})();
</script>`;

export function deckToHtml(deck: Deck): string {
  // No id: an exported file re-imported elsewhere must get its own deck.
  const payload = JSON.stringify({ ...deck, id: undefined, rawHtml: undefined });
  const animations = animationCss(deck);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(deck.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
${deck.fontCss ? `  <style>\n${deck.fontCss}\n  </style>\n` : ""}  <style>${PRESENTATION_CSS}${animations}
  </style>
</head>
<body>
  <main class="deck">
${deck.slides.map(renderSlide).join("\n")}
  </main>
  <div class="counter"></div>
  <div class="progress"></div>
  <div class="hint">← → to navigate · Esc overview · F full screen</div>
  <script type="application/json" id="${DECK_MARKER}">${payload.replaceAll("<", "\\u003c")}</script>
${PRESENTATION_SCRIPT}
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
