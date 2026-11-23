import { ANIMATION_KEYFRAMES } from "./html.ts";
import type { SlideComponent } from "./types.ts";

/**
 * DOM for one layer, shared by the editor canvas and the presenter so a slide
 * looks the same in both. Styling comes from `.el` in editor.css.
 *
 * With `fillable` (presenter mode) an input field is a real textarea the
 * presenter types into; in the editor it is plain text like any other layer,
 * so it can be selected, moved and pre-filled without stealing the pointer.
 */
export function componentNode(component: SlideComponent, fillable = false): HTMLElement {
  const el = document.createElement("div");
  el.className = "el";
  el.dataset.id = component.id;
  el.dataset.type = component.type;
  el.style.left = `${component.x}px`;
  el.style.top = `${component.y}px`;
  el.style.width = `${component.width}px`;
  el.style.height = `${component.height}px`;
  el.style.opacity = String(component.opacity);
  el.style.borderRadius = component.borderRadius != null ? `${component.borderRadius}px` : "";
  el.style.background = component.background ?? "";
  el.style.border = component.border ?? "";
  el.style.padding = component.padding != null ? `${component.padding}px` : "";

  if (component.type === "text" || component.type === "input") {
    const isInput = component.type === "input";
    const text = document.createElement(isInput && fillable ? "textarea" : "div");
    text.className = "text";
    if (text instanceof HTMLTextAreaElement) {
      text.value = component.text ?? "";
      text.placeholder = component.placeholder ?? "";
      text.spellcheck = false;
      text.setAttribute("aria-label", component.name);
    } else {
      text.textContent = component.text ?? "";
      if (isInput) text.dataset.placeholder = component.placeholder ?? "";
    }
    text.style.fontSize = `${component.fontSize ?? 32}px`;
    text.style.fontWeight = String(component.fontWeight ?? 500);
    text.style.fontFamily = component.fontFamily ?? "Inter, system-ui, sans-serif";
    text.style.color = component.color ?? "#111827";
    text.style.textAlign = component.textAlign ?? "left";
    text.style.lineHeight = String(component.lineHeight ?? 1.25);
    text.style.letterSpacing = component.letterSpacing != null ? `${component.letterSpacing}px` : "";
    el.append(text);
  } else if (component.type === "image") {
    if (component.src) {
      const img = document.createElement("img");
      img.src = component.src;
      img.alt = component.name;
      img.style.objectFit = component.objectFit ?? "cover";
      el.append(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "image-ph";
      ph.textContent = "Drop an image";
      el.append(ph);
    }
  } else if (component.type === "html") {
    el.innerHTML = component.html ?? "";
  }
  return el;
}

/** The `ld-*` entrance keyframes, once per document. */
export function ensureAnimationKeyframes() {
  if (document.getElementById("ld-anim-keyframes")) return;
  const style = document.createElement("style");
  style.id = "ld-anim-keyframes";
  style.textContent = ANIMATION_KEYFRAMES;
  document.head.append(style);
}
