import { cssColorToHex, isTransparent } from "./color.ts";
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
  if (!isTransparent(rootStyle.backgroundColor)) {
    slide.background = cssColorToHex(rootStyle.backgroundColor);
  }

  const add = (component: SlideComponent) => {
    const boxed = clampComponent(component);
    if (boxed.width < 8 || boxed.height < 4) return;
    slide.components.push(boxed);
  };

  const visit = (el: Element) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 2) return;
    const box = mapRect(rect, rootRect);

    if (el instanceof HTMLImageElement && el.src) {
      add({
        id: uid("image"),
        type: "image",
        name: el.alt || "Image",
        ...box,
        opacity: 1,
        src: el.src,
        objectFit: (style.objectFit as SlideComponent["objectFit"]) || "cover",
      });
      return;
    }

    const bgImage = urlFromCss(style.backgroundImage);
    if (bgImage) {
      add({
        id: uid("image"),
        type: "image",
        name: "Background image",
        ...box,
        opacity: 1,
        src: bgImage,
        objectFit: "contain",
      });
    } else if (
      !isTransparent(style.backgroundColor) &&
      cssColorToHex(style.backgroundColor) !== cssColorToHex(slide.background) &&
      el !== root
    ) {
      add({
        id: uid("container"),
        type: "container",
        name: el.className || "Frame",
        ...box,
        opacity: 1,
        background: cssColorToHex(style.backgroundColor),
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
        opacity: 1,
        text,
        fontSize: Math.max(12, Math.round(Number.parseFloat(style.fontSize) || 24)),
        fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
        fontFamily: style.fontFamily,
        color: cssColorToHex(style.color),
        textAlign: (style.textAlign as SlideComponent["textAlign"]) || "left",
        lineHeight: Number.parseFloat(style.lineHeight) / Math.max(Number.parseFloat(style.fontSize) || 24, 1) || 1.2,
      });
    }

    for (const child of children) visit(child);
  };

  for (const child of [...root.children]) visit(child);
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

function collectSlideRoots(doc: Document): Element[] {
  const nodes = [
    ...doc.querySelectorAll(".slide, section.slide, [data-slide], section[class*='slide']"),
  ];
  if (nodes.length) return nodes;
  const bodyChildren = [...doc.body.children].filter((el) => el.tagName !== "SCRIPT");
  return bodyChildren.length ? bodyChildren : [doc.body];
}

export async function flattenHtmlDocument(html: string): Promise<Deck> {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-same-origin");
  iframe.style.cssText =
    "position:fixed;left:-10000px;top:0;width:1920px;height:1080px;border:0;opacity:0;pointer-events:none";
  document.body.append(iframe);

  const doc = iframe.contentDocument;
  if (!doc) {
    iframe.remove();
    throw new Error("Could not open an import frame");
  }

  await new Promise<void>((resolve) => {
    iframe.addEventListener("load", () => resolve(), { once: true });
    iframe.srcdoc = html;
  });
  await new Promise((resolve) => setTimeout(resolve, 60));

  const imported = iframe.contentDocument ?? doc;
  const deck = emptyDeck(imported.title || "Imported deck");
  deck.source = "user";
  deck.slides = collectSlideRoots(imported).map((root, index) =>
    flattenSlideEl(root, index),
  );
  iframe.remove();
  return deck;
}

export function needsFlatten(deck: Deck): boolean {
  return Boolean(deck.rawHtml) ||
    deck.slides.some(
      (slide) =>
        slide.components.length === 1 && slide.components[0]?.type === "html",
    );
}
