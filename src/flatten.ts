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
        borderRadius: Number.parseFloat(style.borderRadius) || 0,
        border:
          style.borderWidth !== "0px" && style.borderStyle !== "none"
            ? `${style.borderWidth} ${style.borderStyle} ${style.borderColor}`
            : undefined,
      });
    }

    const children = [...el.children];
    const text = children.length === 0 ? visibleText(el) : ownText(el);
    if (text) {
      add({
        id: uid("text"),
        type: "text",
        name: el.getAttribute("data-slot") || el.tagName.toLowerCase(),
        ...box,
        opacity: round(opacity),
        text,
        fontSize: Math.max(12, Math.round(Number.parseFloat(style.fontSize) || 24)),
        fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
        fontFamily: style.fontFamily,
        color: cssColorValue(style.color),
        textAlign: (style.textAlign as SlideComponent["textAlign"]) || "left",
        lineHeight: Number.parseFloat(style.lineHeight) / Math.max(Number.parseFloat(style.fontSize) || 24, 1) || 1.2,
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

/** Slides in "presentation mode" decks are hidden until active; show them all. */
function forceVisible(el: Element) {
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

function collectSlideRoots(scope: ParentNode & { children: HTMLCollection }): Element[] {
  const matches = [...scope.querySelectorAll(SLIDE_SELECTOR)].filter(
    (el) => !el.matches(CHROME_SELECTOR) && !el.closest(CHROME_SELECTOR),
  );
  // Outermost matches only: a `.slide` wrapper often contains `.slide-content`.
  const outermost = matches.filter((el) => !matches.some((other) => other !== el && other.contains(el)));
  if (outermost.length) {
    outermost.forEach(forceVisible);
    return outermost;
  }
  const children = [...scope.children].filter(
    (el) => !["SCRIPT", "STYLE", "LINK", "TEMPLATE"].includes(el.tagName) && !el.matches(CHROME_SELECTOR),
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
    await settle();
    let imported: Document | null = null;
    try {
      imported = iframe.contentDocument;
    } catch {
      imported = null;
    }
    if (!imported?.body) return null;
    const deck = emptyDeck(imported.title || "Imported deck");
    deck.source = "user";
    deck.slides = collectSlideRoots(imported.body).map((root, index) => flattenSlideEl(root, index));
    return deck;
  } finally {
    iframe.remove();
  }
}

/** Scope `html`/`body` selectors to the wrapper and pin viewport units to 1920×1080. */
function rewriteCss(css: string): string {
  return css
    .replace(/(^|[\s,}>~+])(html|body)(?=[\s,{.:#[>~+])/g, "$1.__body")
    .replace(/(\d*\.?\d+)vw\b/g, (_, n: string) => `${(Number(n) * 19.2).toFixed(2)}px`)
    .replace(/(\d*\.?\d+)vh\b/g, (_, n: string) => `${(Number(n) * 10.8).toFixed(2)}px`);
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
    reset.textContent =
      ":host{all:initial;display:block}.__body{position:relative;width:1920px;min-height:1080px;margin:0;font-family:Inter,system-ui,sans-serif}";
    shadow.append(reset);

    parsed.querySelectorAll('link[rel~="stylesheet"]').forEach((link) => {
      const clone = document.createElement("link");
      clone.rel = "stylesheet";
      clone.href = (link as HTMLLinkElement).href;
      shadow.append(clone);
    });
    parsed.querySelectorAll("style").forEach((style) => {
      const clone = document.createElement("style");
      clone.textContent = rewriteCss(style.textContent ?? "");
      shadow.append(clone);
    });

    const wrapper = document.createElement("div");
    wrapper.className = `__body ${parsed.body.className}`.trim();
    const bodyStyle = parsed.body.getAttribute("style");
    if (bodyStyle) wrapper.setAttribute("style", rewriteCss(bodyStyle));
    wrapper.innerHTML = parsed.body.innerHTML;
    // Inline vw/vh on elements too.
    wrapper.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
      const inline = el.getAttribute("style") ?? "";
      if (/\d(vw|vh)\b/.test(inline)) el.setAttribute("style", rewriteCss(inline));
    });
    shadow.append(wrapper);

    await settle();
    const deck = emptyDeck(parsed.title || "Imported deck");
    deck.source = "user";
    deck.slides = collectSlideRoots(wrapper).map((root, index) => flattenSlideEl(root, index));
    return deck;
  } finally {
    host.remove();
  }
}

export async function flattenHtmlDocument(html: string): Promise<Deck> {
  const viaIframe = await flattenViaIframe(html).catch(() => null);
  const deck = viaIframe ?? (await flattenViaShadow(html));
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
