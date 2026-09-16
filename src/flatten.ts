import { colorAlpha, cssColorValue, isTransparent } from "./color.ts";
import type { Deck, Slide, SlideComponent } from "./types.ts";
import {
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  clampComponent,
  emptyDeck,
  emptySlide,
  uid,
} from "./types.ts";

function ownText(el: Element): string {
  return [...el.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

function visibleText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** A leaf inline child that only carries text and inherits its parent's type. */
function isPlainInline(child: Element, parent: CSSStyleDeclaration): boolean {
  if (child.tagName === "BR" || child.tagName === "WBR") return true;
  if (child.children.length) return false;
  if (!["SPAN", "B", "STRONG", "I", "EM", "MARK", "SMALL"].includes(child.tagName)) return false;
  const style = getComputedStyle(child);
  if (!style.display.startsWith("inline")) return false;
  return (
    style.color === parent.color &&
    style.fontSize === parent.fontSize &&
    style.fontWeight === parent.fontWeight &&
    style.fontFamily === parent.fontFamily &&
    style.fontStyle === parent.fontStyle &&
    isTransparent(style.backgroundColor)
  );
}

function urlFromCss(value: string): string {
  const match = value.match(/url\((['"]?)(.*?)\1\)/i);
  return match?.[2] ?? "";
}

function isGradient(value: string): boolean {
  return /gradient\(/i.test(value);
}

/**
 * The CSS `background` an element paints with: gradient image if any,
 * otherwise its colour (alpha preserved). Empty when it paints nothing.
 */
function paintedBackground(style: CSSStyleDeclaration): string {
  const image = style.backgroundImage;
  if (image && image !== "none" && isGradient(image)) {
    const color = isTransparent(style.backgroundColor) ? "" : ` ${cssColorValue(style.backgroundColor)}`;
    return `${image}${color}`;
  }
  if (!isTransparent(style.backgroundColor)) return cssColorValue(style.backgroundColor);
  return "";
}

/**
 * Serialise an inline <svg> with its computed colour, fill and stroke baked in
 * (they normally come from CSS/`currentColor`, which a data URI cannot see).
 */
function svgToDataUri(el: SVGSVGElement, style: CSSStyleDeclaration, rect: DOMRect): string {
  const clone = el.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(Math.round(rect.width)));
  clone.setAttribute("height", String(Math.round(rect.height)));
  if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
  clone.removeAttribute("class");
  clone.setAttribute("color", style.color);
  if (!clone.hasAttribute("fill") && style.fill) clone.setAttribute("fill", style.fill);
  if (!clone.hasAttribute("stroke") && style.stroke && style.stroke !== "none") clone.setAttribute("stroke", style.stroke);
  if (!clone.hasAttribute("stroke-width") && style.strokeWidth) clone.setAttribute("stroke-width", style.strokeWidth);
  // Class-styled children lose their CSS in the data URI; bake computed paint in.
  const originals = el.querySelectorAll<SVGElement>("*");
  clone.querySelectorAll<SVGElement>("*").forEach((node, index) => {
    const source = originals[index];
    if (!source || node.tagName === "title" || node.tagName === "desc") return;
    node.removeAttribute("class");
    const computed = getComputedStyle(source);
    for (const prop of ["fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity"] as const) {
      const value = computed.getPropertyValue(prop);
      if (value && !node.hasAttribute(prop)) node.setAttribute(prop, value);
    }
  });
  const markup = new XMLSerializer().serializeToString(clone).replaceAll("currentColor", style.color);
  if (markup.length > 200_000) return "";
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

function mapRect(
  rect: DOMRect,
  root: DOMRect,
): { x: number; y: number; width: number; height: number } {
  const scaleX = SLIDE_WIDTH / Math.max(root.width, 1);
  const scaleY = SLIDE_HEIGHT / Math.max(root.height, 1);
  return {
    x: (rect.left - root.left) * scaleX,
    y: (rect.top - root.top) * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY,
  };
}

function flattenSlideEl(root: Element, index: number): Slide {
  const slide = emptySlide(`Slide ${index + 1}`);
  const rootRect = root.getBoundingClientRect();
  // Geometry is mapped onto 1920×1080; type and radii must scale with it or a
  // slide rendered at 1680px (rail beside it) gets boxes that outgrow their text.
  const scale = SLIDE_WIDTH / Math.max(rootRect.width, 1);
  const rootStyle = getComputedStyle(root);
  const rootBackground = paintedBackground(rootStyle);
  if (rootBackground) slide.background = rootBackground;
  // A translucent slide root shows the page behind it; bake that in.
  if (rootBackground && colorAlpha(rootStyle.backgroundColor) < 1 && !isGradient(rootBackground)) {
    const behind = root.parentElement ? paintedBackground(getComputedStyle(root.parentElement)) : "";
    if (behind) slide.background = `linear-gradient(${rootBackground}, ${rootBackground}) ${behind}`;
  }

  const add = (component: SlideComponent) => {
    const boxed = clampComponent(component);
    if (boxed.width < 8 || boxed.height < 4) return;
    slide.components.push(boxed);
  };

  const visit = (el: Element, inheritedOpacity: number) => {
    const style = getComputedStyle(el);
    const ownOpacity = Number.parseFloat(style.opacity);
    const opacity = inheritedOpacity * (Number.isFinite(ownOpacity) ? ownOpacity : 1);
    if (style.display === "none" || style.visibility === "hidden" || opacity <= 0.01) {
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 2) return;
    const box = mapRect(rect, rootRect);
    const round = (value: number) => Math.round(value * 100) / 100;

    if (el instanceof HTMLImageElement && el.src) {
      add({
        id: uid("image"),
        type: "image",
        name: el.alt || "Image",
        ...box,
        opacity: round(opacity),
        src: el.src,
        objectFit: (style.objectFit as SlideComponent["objectFit"]) || "cover",
      });
      return;
    }

    // Inline icons/illustrations become image layers; text inside is skipped.
    if (el instanceof SVGSVGElement) {
      const src = svgToDataUri(el, style, rect);
      if (src) {
        add({
          id: uid("image"),
          type: "image",
          name: el.getAttribute("aria-label") || el.querySelector("title")?.textContent?.trim() || "Icon",
          ...box,
          opacity: round(opacity),
          src,
          objectFit: "contain",
        });
      }
      return;
    }

    const bgImage = urlFromCss(style.backgroundImage);
    const background = paintedBackground(style);
    if (bgImage) {
      add({
        id: uid("image"),
        type: "image",
        name: "Background image",
        ...box,
        opacity: round(opacity),
        src: bgImage,
        objectFit: style.backgroundSize === "contain" ? "contain" : "cover",
      });
    } else if (background && el !== root && background !== slide.background) {
      add({
        id: uid("container"),
        type: "container",
        name: (typeof el.className === "string" && el.className.split(/\s+/)[0]) || "Frame",
        ...box,
        opacity: round(opacity),
        background,
        borderRadius: (Number.parseFloat(style.borderRadius) || 0) * scale,
        border:
          style.borderWidth !== "0px" && style.borderStyle !== "none"
            ? `${style.borderWidth} ${style.borderStyle} ${style.borderColor}`
            : undefined,
      });
    }

    let children = [...el.children];
    // Word-by-word reveal markup (`<h1><span>Make</span> <span>AI</span>…`)
    // is one heading: keep it as one layer so wrapping and order survive.
    // Spans styled differently (an accent word) stay their own layer.
    if (children.length && children.every((child) => isPlainInline(child, style))) children = [];
    let text = children.length === 0 ? visibleText(el) : ownText(el);
    if (text) {
      // Bake text-transform in: the editor renders the string as-is, and case
      // changes the width, so it must be measured and rendered the same way.
      if (style.textTransform === "uppercase") text = text.toUpperCase();
      else if (style.textTransform === "lowercase") text = text.toLowerCase();
      const letterSpacing = Number.parseFloat(style.letterSpacing) * scale;
      add({
        id: uid("text"),
        type: "text",
        // Layer list shows this; the text itself beats "div"/"span".
        name: el.getAttribute("data-slot") || (text.length > 28 ? `${text.slice(0, 27)}…` : text),
        ...box,
        opacity: round(opacity),
        text,
        fontSize: Math.max(12, Math.round((Number.parseFloat(style.fontSize) || 24) * scale)),
        fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
        fontFamily: style.fontFamily,
        color: cssColorValue(style.color),
        textAlign: (style.textAlign as SlideComponent["textAlign"]) || "left",
        lineHeight: Number.parseFloat(style.lineHeight) / Math.max(Number.parseFloat(style.fontSize) || 24, 1) || 1.2,
        letterSpacing: Number.isFinite(letterSpacing) && letterSpacing !== 0 ? round(letterSpacing) : undefined,
      });
    }

    for (const child of children) visit(child, opacity);
  };

  const rootOpacity = Number.parseFloat(rootStyle.opacity);
  for (const child of [...root.children]) visit(child, Number.isFinite(rootOpacity) && rootOpacity > 0 ? 1 : 1);
  if (!slide.components.length) {
    const fallback = visibleText(root);
    if (fallback) {
      slide.components.push(
        clampComponent({
          id: uid("text"),
          type: "text",
          name: "Text",
          x: 80,
          y: 80,
          width: 1760,
          height: 200,
          opacity: 1,
          text: fallback,
          fontSize: 36,
          fontWeight: 500,
          fontFamily: "Inter, system-ui, sans-serif",
          color: "#111827",
          textAlign: "left",
          lineHeight: 1.25,
        }),
      );
    }
  }
  return slide;
}

const SLIDE_SELECTOR =
  ".slide, section.slide, [data-slide], section[class*='slide'], div[class*='slide-'], div[class*='-slide']";
const CHROME_SELECTOR =
  "nav, header.controls, .controls, .nav, .navigation, .progress, .progress-bar, .toolbar, .pagination, button";
/** Slide overview rails, minimaps, thumbnails: copies of slides that are not slides. */
const THUMB_ANCESTOR =
  "aside, nav, .rail, .sidebar, .sidenav, .overview, .thumbs, .thumbnails, .minimap, [class*='thumb'], [class*='overview'], [class*='preview'], [class*='minimap'], [class*='mini-'], [class*='-mini']";
/**
 * Decks reveal content with classes their script toggles. Scripts do not run
 * in the import, so give every slide the usual "current" markers up front.
 */
const STATE_CLASSES = [
  "active",
  "is-active",
  "current",
  "is-current",
  "visible",
  "is-visible",
  "show",
  "shown",
  "in-view",
  "revealed",
  "is-revealed",
  "animate",
  "animated",
  "loaded",
  "ready",
];
const PAGE_STATE_CLASSES = ["js", "loaded", "is-loaded", "ready", "is-ready", "fonts-loaded"];

/** Slides in "presentation mode" decks are hidden until active; show them all. */
function forceVisible(el: Element) {
  el.classList.add(...STATE_CLASSES);
  el.removeAttribute("hidden");
  el.removeAttribute("inert");
  if (el.getAttribute("aria-hidden") === "true") el.setAttribute("aria-hidden", "false");
  const style = (el as HTMLElement).style;
  style.display = getComputedStyle(el).display === "none" ? "block" : style.display;
  style.visibility = "visible";
  style.opacity = "1";
  style.transform = "none";
  style.transition = "none";
  style.animation = "none";
  style.position = style.position === "fixed" || style.position === "absolute" ? "relative" : style.position;
  style.left = style.top = "auto";
}

function isSlideSized(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width >= 480 && rect.height >= 200;
}

function isWidescreen(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  const aspect = rect.width / Math.max(rect.height, 1);
  return aspect > 1.5 && aspect < 2.1;
}

function collectSlideRoots(scope: ParentNode & { children: HTMLCollection }): Element[] {
  const matches = [...scope.querySelectorAll(SLIDE_SELECTOR)].filter(
    (el) => !el.matches(CHROME_SELECTOR) && !el.closest(CHROME_SELECTOR) && !el.closest(THUMB_ANCESTOR),
  );
  // Outermost matches only: a `.slide` wrapper often contains `.slide-content`.
  const outermost = matches.filter((el) => !matches.some((other) => other !== el && other.contains(el)));
  if (outermost.length) {
    outermost.forEach(forceVisible);
    // Geometry decides between real slides and same-class thumbnails: a slide
    // is big and roughly 16:9. Fall back gently when a deck sizes oddly.
    const sized = outermost.filter(isSlideSized);
    const widescreen = sized.filter(isWidescreen);
    return widescreen.length ? widescreen : sized.length ? sized : outermost;
  }
  const children = [...scope.children].filter(
    (el) =>
      !["SCRIPT", "STYLE", "LINK", "TEMPLATE"].includes(el.tagName) &&
      !el.matches(CHROME_SELECTOR) &&
      !el.matches(THUMB_ANCESTOR),
  );
  children.forEach(forceVisible);
  // Drop zero-size leftovers (empty wrappers, hidden helpers).
  const sized = children.filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width >= 64 && rect.height >= 36;
  });
  if (sized.length) return sized;
  return [scope as unknown as Element];
}

function settle(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 80)));
}

/**
 * Decks built for presenting animate their content in (staggered fade-ups,
 * slide-ins). Measuring mid-flight yields faint, displaced layers, so every
 * animation jumps to its final keyframe and transitions are off.
 */
const FREEZE_CSS =
  "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-fill-mode:forwards!important;transition:none!important;scroll-behavior:auto!important}";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(resolve, ms))]);
}

/** Stylesheets, webfonts and images all move text around; wait for them. */
async function waitForAssets(scope: ParentNode, doc: Document): Promise<void> {
  const loaded = (el: Element, done: boolean) =>
    done
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          el.addEventListener("load", () => resolve(), { once: true });
          el.addEventListener("error", () => resolve(), { once: true });
        });
  await withTimeout(
    Promise.all([
      ...[...scope.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')].map((link) => loaded(link, !!link.sheet)),
      ...[...scope.querySelectorAll("img")].map((img) => loaded(img, img.complete)),
    ]),
    2500,
  );
  // Fonts only start loading once text that uses them is laid out.
  await settle();
  await withTimeout(doc.fonts.ready, 2500);
  await settle();
}

const FONT_HOST =
  /fonts\.googleapis\.com|fonts\.bunny\.net|use\.typekit\.net|api\.fontshare\.com|fonts\.cdnfonts\.com|@fontsource|rsms\.me\/inter/i;

/**
 * The CSS the imported deck's typography depends on: webfont stylesheets and
 * `@font-face` rules. Everything else about the source layout is baked into
 * the flattened layers; this is the one part that has to travel with them.
 */
export function collectFontCss(doc: Document): string {
  const parts: string[] = [];
  doc.querySelectorAll('link[rel~="stylesheet"]').forEach((link) => {
    const href = link.getAttribute("href") ?? "";
    if (FONT_HOST.test(href)) parts.push(`@import url("${href}");`);
  });
  doc.querySelectorAll("style").forEach((style) => {
    const css = style.textContent ?? "";
    for (const match of css.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)["']?\s*\)?[^;]*;/g)) {
      if (FONT_HOST.test(match[1] ?? "")) parts.push(match[0]);
    }
    for (const match of css.matchAll(/@font-face\s*\{[^}]*\}/g)) parts.push(match[0]);
  });
  return [...new Set(parts)].join("\n");
}

/**
 * Preferred path: a same-origin iframe gives true document semantics
 * (body styles, vw/vh against 1920×1080). Returns null when the host sandbox
 * makes the frame's document inaccessible.
 */
async function flattenViaIframe(html: string): Promise<Deck | null> {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-same-origin");
  iframe.style.cssText =
    "position:fixed;left:-10000px;top:0;width:1920px;height:1080px;border:0;opacity:0;pointer-events:none";
  document.body.append(iframe);
  try {
    await new Promise<void>((resolve) => {
      iframe.addEventListener("load", () => resolve(), { once: true });
      iframe.srcdoc = html;
    });
    let imported: Document | null = null;
    try {
      imported = iframe.contentDocument;
    } catch {
      imported = null;
    }
    if (!imported?.body) return null;
    const freeze = imported.createElement("style");
    freeze.textContent = FREEZE_CSS;
    imported.head.append(freeze);
    imported.body.classList.add(...PAGE_STATE_CLASSES);
    await waitForAssets(imported, imported);
    const deck = emptyDeck(imported.title || "Imported deck");
    deck.source = "user";
    deck.fontCss = collectFontCss(imported) || undefined;
    deck.slides = collectSlideRoots(imported.body).map((root, index) => flattenSlideEl(root, index));
    return deck;
  } finally {
    iframe.remove();
  }
}

/**
 * Scope `:root`/`html`/`body` selectors to the wrapper and pin viewport units
 * to 1920×1080. `:root` matters most: in a shadow tree it matches nothing, so
 * every `var(--…)` a deck defines there would silently fall back (white slide,
 * black text, no accents).
 */
function rewriteCss(css: string): string {
  return css
    .replace(/:root\b/g, ".__body")
    .replace(/(^|[\s,}>~+])(html|body)(?=[\s,{.:#[>~+])/g, "$1.__body")
    .replace(/(\d*\.?\d+)vw\b/g, (_, n: string) => `${(Number(n) * 19.2).toFixed(2)}px`)
    .replace(/(\d*\.?\d+)vh\b/g, (_, n: string) => `${(Number(n) * 10.8).toFixed(2)}px`);
}

/** `rem` resolves against the page, not the wrapper; pin it to the deck's root size. */
function rewriteRem(css: string, rootPx: number): string {
  return css.replace(/(\d*\.?\d+)rem\b/g, (_, n: string) => `${(Number(n) * rootPx).toFixed(2)}px`);
}

/**
 * Fallback used inside MCP host sandboxes (no allow-same-origin, so nested
 * frames are opaque). Renders the import inside a shadow root of this
 * document: styles stay scoped, layout and computed styles still work.
 */
async function flattenViaShadow(html: string): Promise<Deck> {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script, noscript, iframe").forEach((el) => el.remove());

  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:-20000px;top:0;width:1920px;height:1080px;overflow:visible;pointer-events:none;";
  document.body.append(host);
  try {
    const shadow = host.attachShadow({ mode: "open" });

    const reset = document.createElement("style");
    // The transform makes the wrapper the containing block for `position:
    // fixed` descendants (counters, logos), which would otherwise position
    // against the real viewport and land off-slide.
    reset.textContent =
      ":host{all:initial;display:block}.__body{position:relative;width:1920px;min-height:1080px;margin:0;transform:translateZ(0);font-family:Inter,system-ui,sans-serif}";
    shadow.append(reset);

    parsed.querySelectorAll('link[rel~="stylesheet"]').forEach((link) => {
      const clone = document.createElement("link");
      clone.rel = "stylesheet";
      clone.href = (link as HTMLLinkElement).href;
      shadow.append(clone);
    });
    // Webfonts are document-wide, and @import inside a shadow <style> is
    // ignored, so font CSS goes into the page head (and stays: the editor
    // renders the flattened text with these same fonts).
    const fontCss = collectFontCss(parsed);
    ensureFontStyles(fontCss);
    parsed.querySelectorAll("style").forEach((style) => {
      const clone = document.createElement("style");
      clone.textContent = rewriteCss(style.textContent ?? "");
      shadow.append(clone);
    });
    const freeze = document.createElement("style");
    freeze.textContent = FREEZE_CSS;
    shadow.append(freeze);

    // The wrapper stands in for both <html> and <body>: theme switches live on
    // either (`<html data-theme="dark">`, `<body class="dark">`).
    const wrapper = document.createElement("div");
    const htmlEl = parsed.documentElement;
    wrapper.className = `__body ${htmlEl.className} ${parsed.body.className}`.trim();
    for (const attr of [...htmlEl.attributes, ...parsed.body.attributes]) {
      if (attr.name === "class" || attr.name === "style" || attr.name === "lang") continue;
      wrapper.setAttribute(attr.name, attr.value);
    }
    const inlineRoot = [htmlEl.getAttribute("style"), parsed.body.getAttribute("style")].filter(Boolean).join(";");
    if (inlineRoot) wrapper.setAttribute("style", rewriteCss(inlineRoot));
    wrapper.innerHTML = parsed.body.innerHTML;
    // Inline vw/vh on elements too.
    wrapper.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
      const inline = el.getAttribute("style") ?? "";
      if (/\d(vw|vh)\b/.test(inline)) el.setAttribute("style", rewriteCss(inline));
    });
    // Scripts usually flag the page once booted (`body.loaded`, `.ready`).
    wrapper.classList.add(...PAGE_STATE_CLASSES);
    shadow.append(wrapper);

    // Decks that scale type with `html { font-size: … }` + rem: the wrapper now
    // carries the html rules, so its font-size is the intended root size.
    const rootPx = Number.parseFloat(getComputedStyle(wrapper).fontSize) || 16;
    if (Math.abs(rootPx - 16) > 0.05) {
      shadow.querySelectorAll("style").forEach((style) => {
        if (style.textContent?.includes("rem")) style.textContent = rewriteRem(style.textContent, rootPx);
      });
      wrapper.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
        const inline = el.getAttribute("style") ?? "";
        if (/\drem\b/.test(inline)) el.setAttribute("style", rewriteRem(inline, rootPx));
      });
    }

    await waitForAssets(shadow, document);
    const deck = emptyDeck(parsed.title || "Imported deck");
    deck.source = "user";
    deck.fontCss = fontCss || undefined;
    deck.slides = collectSlideRoots(wrapper).map((root, index) => flattenSlideEl(root, index));
    return deck;
  } finally {
    host.remove();
  }
}

/**
 * Make a deck's font CSS available in this document (idempotent). The editor
 * calls this for whatever deck it shows; the import calls it so measuring
 * and rendering use the same fonts.
 */
export function ensureFontStyles(fontCss: string | undefined) {
  const css = fontCss ?? "";
  let style = document.getElementById("deck-fonts") as HTMLStyleElement | null;
  if (!style) {
    if (!css) return;
    style = document.createElement("style");
    style.id = "deck-fonts";
    document.head.append(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

export async function flattenHtmlDocument(html: string): Promise<Deck> {
  const viaIframe = await flattenViaIframe(html).catch(() => null);
  const deck = viaIframe ?? (await flattenViaShadow(html));
  ensureFontStyles(deck.fontCss);
  if (!deck.slides.length) deck.slides = [emptySlide("Slide 1")];
  return deck;
}

export function needsFlatten(deck: Deck): boolean {
  return Boolean(deck.rawHtml) ||
    deck.slides.some(
      (slide) =>
        slide.components.length === 1 && slide.components[0]?.type === "html",
    );
}
