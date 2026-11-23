import { animationValue } from "./html.ts";
import { componentNode, ensureAnimationKeyframes } from "./render.ts";
import type { Deck, Slide, SlideComponent } from "./types.ts";
import { SLIDE_HEIGHT, SLIDE_WIDTH } from "./types.ts";
import "./presenter.css";

export type PresenterOptions = {
  deck: Deck;
  /** Slide to start on. */
  index: number;
  /** Called once when the presentation ends, with the slide it ended on. */
  onClose: (index: number) => void;
  /** Text was typed into input fields; called with what changed since the last call. */
  onFill?: (edits: FieldEdit[]) => void;
};

export type FieldEdit = { slideId: string; componentId: string; text: string };

const HUD_MS = 2500;
const SWIPE_PX = 40;
/** Pause in typing after which field text is handed to the editor (and saved). */
const FILL_FLUSH_MS = 1200;

function fieldOf(target: EventTarget | null): HTMLTextAreaElement | null {
  return target instanceof HTMLTextAreaElement ? target : null;
}

const ICON = {
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>',
  full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg>',
  exit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>',
};

/**
 * Presenter mode: the deck one slide at a time over the whole app, scaled to
 * the window. Same behaviour as the exported file (keys, click zones, swipe,
 * click-revealed build steps, entrance animations), but it runs on the live
 * deck inside the editor, so nothing has to be downloaded to present.
 *
 * Slides are read-only here except for input fields: those are typed into,
 * and what is typed goes back to the editor through `onFill`. While a field
 * has focus, keys and clicks belong to it and never change the slide.
 *
 * Rendered with the editor's own layer renderer rather than the export in an
 * iframe: MCP hosts sandbox the app, and a nested frame is not reliable there.
 */
export class Presenter {
  private readonly root: HTMLElement;
  private readonly slideEl: HTMLElement;
  private readonly counter: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly deck: Deck;
  private index: number;
  /** How many of the current slide's build steps are showing. */
  private revealed = 0;
  private closed = false;
  private hudTimer: number | undefined;
  private touchX: number | null = null;
  /** Set while we leave full screen on purpose (F), so that is not read as "stop presenting". */
  private keepOpen = false;
  private wasFullscreen = false;
  private readonly observer: ResizeObserver;
  /** Field text typed since the last `onFill`, by component id. */
  private readonly edits = new Map<string, FieldEdit>();
  private fillTimer: number | undefined;
  /** The press that started this click took focus out of a field. */
  private leftField = false;

  constructor(private readonly options: PresenterOptions) {
    this.deck = options.deck;
    this.index = Math.max(0, Math.min(options.index, this.deck.slides.length - 1));
    ensureAnimationKeyframes();

    this.root = document.createElement("div");
    this.root.className = "presenter";
    this.root.tabIndex = -1;
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "Presentation");
    this.root.innerHTML = `
      <div class="presenter-slide" aria-live="polite"></div>
      <div class="presenter-progress"></div>
      <div class="presenter-hint">← → to navigate · F full screen · Esc to exit</div>
      <div class="presenter-hud">
        <button type="button" data-action="prev" title="Previous (←)" aria-label="Previous">${ICON.prev}</button>
        <span class="presenter-counter"></span>
        <button type="button" data-action="next" title="Next (→)" aria-label="Next">${ICON.next}</button>
        <i></i>
        <button type="button" data-action="fullscreen" title="Full screen (F)" aria-label="Full screen">${ICON.full}</button>
        <button type="button" data-action="exit" title="Exit (Esc)" aria-label="Exit presentation">${ICON.exit}</button>
      </div>`;
    this.slideEl = this.root.querySelector(".presenter-slide")!;
    this.counter = this.root.querySelector(".presenter-counter")!;
    this.bar = this.root.querySelector(".presenter-progress")!;
    if (!document.fullscreenEnabled) {
      this.root.querySelector<HTMLElement>('[data-action="fullscreen"]')!.hidden = true;
    }
    document.body.append(this.root);

    this.root.addEventListener("click", this.onClick);
    this.root.addEventListener("pointerdown", this.onPointerDown);
    this.slideEl.addEventListener("input", this.onFieldInput);
    this.slideEl.addEventListener("change", this.flushFields);
    this.root.addEventListener("mousemove", this.showHud);
    this.root.addEventListener("touchstart", this.onTouchStart, { passive: true });
    this.root.addEventListener("touchend", this.onTouchEnd);
    // Capture phase on window: while presenting, no key may reach the editor
    // underneath (Delete, ⌘Z and arrow nudges would edit the deck unseen).
    window.addEventListener("keydown", this.onKey, true);
    document.addEventListener("fullscreenchange", this.onFullscreenChange);
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(this.root);

    this.fit();
    this.show(this.index);
    this.showHud();
    this.root.focus({ preventScroll: true });
    window.setTimeout(() => this.root.querySelector(".presenter-hint")?.remove(), 5000);
    // Must run inside the click that started the presentation.
    this.enterFullscreen();
  }

  /** Slide currently on screen. */
  get slideIndex(): number {
    return this.index;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.flushFields();
    window.clearTimeout(this.hudTimer);
    window.removeEventListener("keydown", this.onKey, true);
    document.removeEventListener("fullscreenchange", this.onFullscreenChange);
    this.observer.disconnect();
    if (document.fullscreenElement === this.root) void document.exitFullscreen().catch(() => undefined);
    this.root.remove();
    this.options.onClose(this.index);
  }

  private slide(): Slide {
    return this.deck.slides[this.index]!;
  }

  /** Build steps of a slide, in the order they are revealed. */
  private steps(slide: Slide): number[] {
    const steps = new Set<number>();
    for (const component of slide.components) {
      if (component.animation?.step) steps.add(component.animation.step);
    }
    return [...steps].sort((a, b) => a - b);
  }

  private fit() {
    const scale = Math.min(this.root.clientWidth / SLIDE_WIDTH, this.root.clientHeight / SLIDE_HEIGHT);
    if (scale > 0) this.slideEl.style.transform = `translate(-50%, -50%) scale(${scale})`;
  }

  /**
   * Put a slide on screen. Going forward it starts before its first build
   * step and plays its entrance; coming back to it, it shows complete and
   * still, so stepping backwards never replays what was just watched.
   */
  private show(index: number, fromBack = false) {
    // The focused field is about to be removed, which fires no `change`.
    this.flushFields();
    const hadFocus = this.slideEl.contains(document.activeElement);
    this.index = Math.max(0, Math.min(index, this.deck.slides.length - 1));
    const slide = this.slide();
    this.revealed = fromBack ? this.steps(slide).length : 0;
    this.slideEl.style.background = slide.background;
    this.slideEl.replaceChildren(
      ...slide.components.map((component) => {
        const node = componentNode(component, true);
        if (fromBack) return node;
        if (component.animation?.step) node.classList.add("pending");
        else node.style.animation = animationValue(component, false);
        return node;
      }),
    );
    const total = this.deck.slides.length;
    this.counter.textContent = `${this.index + 1} / ${total}`;
    this.bar.style.width = `${((this.index + 1) / total) * 100}%`;
    this.root.querySelector<HTMLButtonElement>('[data-action="prev"]')!.disabled = this.index === 0;
    this.updateNext();
    if (hadFocus) this.root.focus({ preventScroll: true });
  }

  private readonly onFieldInput = (event: Event) => {
    const field = fieldOf(event.target);
    const id = field?.closest<HTMLElement>(".el")?.dataset.id;
    const slide = this.slide();
    const component = slide.components.find((item) => item.id === id);
    if (!field || !component) return;
    // Keep our copy current too, so the text is there when coming back to this slide.
    component.text = field.value;
    this.edits.set(component.id, { slideId: slide.id, componentId: component.id, text: field.value });
    window.clearTimeout(this.fillTimer);
    this.fillTimer = window.setTimeout(this.flushFields, FILL_FLUSH_MS);
  };

  /** Hand typed field text to the editor: on a pause, on leaving the field, the slide or the presentation. */
  private readonly flushFields = () => {
    window.clearTimeout(this.fillTimer);
    if (!this.edits.size) return;
    const edits = [...this.edits.values()];
    this.edits.clear();
    this.options.onFill?.(edits);
  };

  private updateNext() {
    const atEnd = this.index === this.deck.slides.length - 1 && this.revealed >= this.steps(this.slide()).length;
    this.root.querySelector<HTMLButtonElement>('[data-action="next"]')!.disabled = atEnd;
  }

  private nodesOfStep(step: number): Array<{ node: HTMLElement; component: SlideComponent }> {
    const found: Array<{ node: HTMLElement; component: SlideComponent }> = [];
    for (const component of this.slide().components) {
      if (component.animation?.step !== step) continue;
      const node = [...this.slideEl.children].find((child) => (child as HTMLElement).dataset.id === component.id);
      if (node) found.push({ node: node as HTMLElement, component });
    }
    return found;
  }

  private next() {
    const steps = this.steps(this.slide());
    if (this.revealed < steps.length) {
      for (const { node, component } of this.nodesOfStep(steps[this.revealed]!)) {
        node.classList.remove("pending");
        node.style.animation = animationValue(component, false);
      }
      this.revealed += 1;
      this.updateNext();
      return;
    }
    if (this.index < this.deck.slides.length - 1) this.show(this.index + 1);
    // Last slide: stay, but show where we are instead of doing nothing.
    else this.showHud();
  }

  private prev() {
    const steps = this.steps(this.slide());
    if (this.revealed > 0) {
      this.revealed -= 1;
      for (const { node } of this.nodesOfStep(steps[this.revealed]!)) {
        node.style.animation = "";
        node.classList.add("pending");
      }
      this.updateNext();
      return;
    }
    if (this.index > 0) this.show(this.index - 1, true);
    else this.showHud();
  }

  private enterFullscreen() {
    if (!document.fullscreenEnabled || document.fullscreenElement) return;
    // Refused in a sandboxed host frame without the permission; the host's
    // own full screen mode covers that case.
    void this.root.requestFullscreen().catch(() => undefined);
  }

  private toggleFullscreen() {
    if (document.fullscreenElement) {
      this.keepOpen = true;
      void document.exitFullscreen().catch(() => undefined);
    } else {
      this.enterFullscreen();
    }
  }

  private readonly onFullscreenChange = () => {
    const now = document.fullscreenElement === this.root;
    const left = this.wasFullscreen && !now;
    this.wasFullscreen = now;
    if (!left) return;
    // Esc in full screen never reaches the page: the browser just leaves full
    // screen. Treat that as "stop presenting", unless F asked for a window.
    if (this.keepOpen) this.keepOpen = false;
    else this.close();
  };

  private readonly showHud = () => {
    this.root.classList.remove("idle");
    window.clearTimeout(this.hudTimer);
    this.hudTimer = window.setTimeout(() => this.root.classList.add("idle"), HUD_MS);
  };

  private readonly onKey = (event: KeyboardEvent) => {
    event.stopPropagation();
    // Typing into a field: every key is the field's (Space, arrows, Enter,
    // ⌘Z …). Only Esc is ours, and it leaves the field, not the presentation.
    const field = fieldOf(event.target);
    if (field && this.root.contains(field)) {
      if (event.key === "Escape") {
        event.preventDefault();
        field.blur();
        this.root.focus({ preventScroll: true });
      }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key;
    if (key === "Escape") {
      event.preventDefault();
      this.close();
    } else if (["ArrowRight", "ArrowDown", " ", "PageDown", "Enter"].includes(key)) {
      event.preventDefault();
      this.next();
    } else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(key)) {
      event.preventDefault();
      this.prev();
    } else if (key === "Home") {
      event.preventDefault();
      this.show(0);
    } else if (key === "End") {
      event.preventDefault();
      this.show(this.deck.slides.length - 1);
    } else if (key === "f" || key === "F") {
      event.preventDefault();
      this.toggleFullscreen();
    }
  };

  private readonly onClick = (event: MouseEvent) => {
    const leftField = this.leftField;
    this.leftField = false;
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (button) {
      const action = button.dataset.action;
      if (action === "prev") this.prev();
      else if (action === "next") this.next();
      else if (action === "fullscreen") this.toggleFullscreen();
      else if (action === "exit") this.close();
      // Keep keys on the presentation, not on the button that was clicked.
      if (!this.closed) this.root.focus({ preventScroll: true });
      this.showHud();
      return;
    }
    if ((event.target as HTMLElement).closest(".presenter-hud")) return;
    if (fieldOf(event.target)) return;
    // Clicking out of a field only leaves it; the next click navigates again.
    if (leftField) return;
    const rect = this.root.getBoundingClientRect();
    if (event.clientX - rect.left < rect.width * 0.2) this.prev();
    else this.next();
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    const focused = fieldOf(document.activeElement);
    this.leftField = !!focused && this.root.contains(focused) && event.target !== focused;
  };

  private readonly onTouchStart = (event: TouchEvent) => {
    // A swipe inside a field scrolls or selects its text.
    this.touchX = fieldOf(event.target) ? null : (event.touches[0]?.clientX ?? null);
    this.showHud();
  };

  private readonly onTouchEnd = (event: TouchEvent) => {
    if (this.touchX === null) return;
    const dx = (event.changedTouches[0]?.clientX ?? this.touchX) - this.touchX;
    this.touchX = null;
    if (Math.abs(dx) < SWIPE_PX) return;
    // A swipe is its own gesture; the click that follows must not advance again.
    event.preventDefault();
    if (dx < 0) this.next();
    else this.prev();
  };
}
