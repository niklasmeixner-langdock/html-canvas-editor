import { cssColorToHex } from "./color.ts";
import { ensureFontStyles, flattenHtmlDocument, needsFlatten } from "./flatten.ts";
import { ANIMATION_KEYFRAMES, animationValue, deckToHtml } from "./html.ts";
import type { LayerAnimation } from "./types.ts";
import type { Deck, Slide, SlideComponent } from "./types.ts";
import {
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  clampComponent,
  defaultComponent,
  emptySlide,
  uid,
} from "./types.ts";
import "./editor.css";

export type Tool = "select" | "text" | "image" | "container";
type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const HANDLES: Handle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const GRID = 8;
const DRAG_THRESHOLD = 4;

function snap(value: number, enabled: boolean): number {
  return enabled ? Math.round(value / GRID) * GRID : value;
}

function slideAt(deck: Deck, index: number): Slide {
  return deck.slides[index] ?? deck.slides[0]!;
}

/**
 * Snapshot for history/save. Decks carry megabytes of base64 (embedded
 * fonts, images); cloning that on every edit is what made big decks stall.
 * Slides are cloned (they are what changes), the heavy strings are shared:
 * `fontCss`/`rawHtml` never change, and image `src` is replaced, never
 * mutated, so sharing is safe.
 */
function snapshot(deck: Deck): Deck {
  return {
    ...deck,
    slides: deck.slides.map((slide) => ({
      ...slide,
      components: slide.components.map((component) => ({ ...component, animation: component.animation && { ...component.animation } })),
    })),
  };
}

const HISTORY_LIMIT = 40;

export class SlideEditor {
  deck: Deck;
  slideIndex = 0;
  /** Selected layer ids, in selection order. The last one drives the props panel. */
  selectedIds: string[] = [];
  tool: Tool = "select";
  zoom = 0.4;
  panX = 48;
  panY = 36;
  status = "Ready";
  onChange: ((deck: Deck) => void) | null = null;

  private history: Deck[] = [];
  private future: Deck[] = [];
  /** Deck as of the last commit. Mutations happen in place on `deck`, so this
   *  is what undo must restore. */
  private committed: Deck;
  private editing = false;
  private spaceDown = false;
  private userZoomed = false;
  /** Whether plain wheel/trackpad scroll pans the canvas (off for inline cards). */
  wheelPans = true;
  private pendingImageId: string | null = null;
  private flattening = false;
  /** Manual double-click tracking: re-rendering the slide between clicks
   *  swaps DOM nodes, so the browser's own dblclick never fires. */
  private lastClick: { id: string; at: number } | null = null;
  private drag:
    | {
        kind: "move" | "resize" | "pan" | "marquee";
        handle?: Handle;
        startX: number;
        startY: number;
        origin: SlideComponent;
        /** Every selected layer as it was when the drag started (move). */
        origins?: SlideComponent[];
        /** Marquee: selection to keep when Shift was held. */
        keep?: string[];
        moved: boolean;
      }
    | null = null;

  /** Primary selection: the most recently selected layer. */
  get selectedId(): string | null {
    return this.selectedIds[this.selectedIds.length - 1] ?? null;
  }

  set selectedId(id: string | null) {
    this.selectedIds = id ? [id] : [];
  }

  private isSelected(id: string): boolean {
    return this.selectedIds.includes(id);
  }

  private selectedAll(): SlideComponent[] {
    return this.current().components.filter((component) => this.isSelected(component.id));
  }

  constructor(private readonly root: HTMLElement, deck: Deck) {
    this.deck = snapshot(deck);
    ensureFontStyles(this.deck.fontCss);
    this.committed = snapshot(deck);
    this.bind();
    this.fit();
    this.render();
    void this.flattenImported();
  }

  setDeck(deck: Deck, status = "Loaded") {
    this.finishTextEdit();
    this.deck = snapshot(deck);
    ensureFontStyles(this.deck.fontCss);
    this.committed = snapshot(deck);
    this.slideIndex = 0;
    this.selectedId = null;
    this.history = [];
    this.future = [];
    this.status = status;
    this.render();
    void this.flattenImported();
  }

  getDeck(): Deck {
    this.finishTextEdit();
    return snapshot(this.deck);
  }

  /** The surface changed (display mode, panels): fit the slide again. */
  refit() {
    this.userZoomed = false;
    requestAnimationFrame(() => this.fit());
  }

  /** Server assigned (or confirmed) the id this deck is stored under. */
  adoptId(id: string) {
    this.deck.id = id;
    this.committed.id = id;
  }

  exportHtml(): string {
    return deckToHtml(this.getDeck());
  }

  private async flattenImported() {
    if (this.flattening || !needsFlatten(this.deck)) return;
    this.flattening = true;
    try {
      const source = this.deck.rawHtml;
      const flattened = source
        ? await flattenHtmlDocument(source)
        : await flattenHtmlDocument(deckToHtml(this.deck));
      flattened.title = this.deck.title || flattened.title;
      flattened.id = this.deck.id;
      this.deck = flattened;
      this.committed = snapshot(flattened);
      this.history = [];
      this.future = [];
      this.status = "Imported slide is editable";
      this.render();
      this.onChange?.(this.committed);
    } catch (error) {
      this.status = error instanceof Error ? error.message : "Import failed";
      this.renderStatus();
    } finally {
      this.flattening = false;
    }
  }

  private current(): Slide {
    return slideAt(this.deck, this.slideIndex);
  }

  private selected(): SlideComponent | undefined {
    return this.current().components.find((component) => component.id === this.selectedId);
  }

  private commit(label?: string, redraw = true) {
    // An inline text edit may still be open (e.g. user clicked straight into
    // the props panel). Close it first so this change is never dropped.
    if (this.editing) this.finishTextEdit(false);
    this.history.push(this.committed);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.future = [];
    this.deck.updatedAt = new Date().toISOString();
    this.deck.source = "user";
    delete this.deck.rawHtml;
    this.committed = snapshot(this.deck);
    if (label) this.status = label;
    // The committed snapshot is never mutated, so it can go out as-is.
    this.onChange?.(this.committed);
    if (redraw) this.render();
  }

  private mutateSelected(patch: Partial<SlideComponent>, label?: string, redraw = true) {
    const slide = this.current();
    const index = slide.components.findIndex((component) => component.id === this.selectedId);
    if (index < 0) return;
    slide.components[index] = clampComponent({
      ...slide.components[index]!,
      ...patch,
    });
    this.commit(label, redraw);
  }

  private bind() {
    this.root.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((button) => {
      button.addEventListener("click", () => {
        this.tool = button.dataset.tool as Tool;
        this.status = this.tool === "select" ? "Select" : `Click the slide to add ${this.tool}`;
        this.renderTools();
        this.renderStatus();
      });
    });

    this.el("fit-btn").addEventListener("click", () => {
      this.userZoomed = false;
      this.fit();
    });
    this.el("add-slide").addEventListener("click", () => this.addSlide());
    this.el("delete-btn").addEventListener("click", () => this.removeSelected());
    this.el("front-btn").addEventListener("click", () => this.nudgeLayer(1));
    this.el("back-btn").addEventListener("click", () => this.nudgeLayer(-1));

    const viewport = this.el("viewport");
    viewport.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    window.addEventListener("pointermove", (event) => this.onPointerMove(event));
    window.addEventListener("pointerup", () => this.onPointerUp());
    viewport.addEventListener(
      "wheel",
      (event) => {
        // Inline in a chat the card must not swallow the page scroll (and a
        // stray wheel would pan the slide out of view); only zoom gestures act.
        if (!this.wheelPans && !(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        this.userZoomed = true;
        // Figma conventions: scroll/two-finger pans, ⌘/Ctrl+scroll and pinch
        // (which browsers report as ctrlKey wheel) zoom around the cursor.
        if (event.ctrlKey || event.metaKey) {
          // Pinch sends small deltas, a mouse wheel notch ~100: clamp so one
          // notch is at most ~1.4×.
          const factor = Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.0035);
          this.zoomAt(this.zoom * factor, event.clientX, event.clientY);
        } else {
          this.panX -= event.deltaX;
          this.panY -= event.deltaY;
          this.applyTransform();
        }
      },
      { passive: false },
    );
    viewport.addEventListener("dblclick", (event) => this.onDoubleClick(event));
    viewport.addEventListener("dragover", (event) => event.preventDefault());
    viewport.addEventListener("drop", (event) => void this.onDrop(event));

    this.el<HTMLInputElement>("file").addEventListener("change", () => {
      const file = this.el<HTMLInputElement>("file").files?.[0];
      this.el<HTMLInputElement>("file").value = "";
      if (file) void this.assignImage(file);
    });

    window.addEventListener("keydown", (event) => this.onKey(event));
    window.addEventListener("keyup", (event) => {
      if (event.code === "Space") this.spaceDown = false;
    });
    new ResizeObserver(() => {
      if (!this.userZoomed) this.fit();
    }).observe(viewport);
  }

  private el<T extends HTMLElement = HTMLElement>(id: string): T {
    const node = this.root.querySelector<T>(`#${id}`);
    if (!node) throw new Error(`Missing #${id}`);
    return node;
  }

  private fit() {
    const viewport = this.el("viewport");
    const pad = 40;
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (width < 40 || height < 40) return;
    this.zoom = Math.max(0.08, Math.min((width - pad) / SLIDE_WIDTH, (height - pad) / SLIDE_HEIGHT));
    this.panX = (width - SLIDE_WIDTH * this.zoom) / 2;
    this.panY = (height - SLIDE_HEIGHT * this.zoom) / 2;
    this.applyTransform();
    this.renderStatus();
  }

  private applyTransform() {
    this.el("stage").style.transform =
      `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
  }

  /** Change zoom keeping the slide point under (clientX, clientY) fixed. */
  private zoomAt(next: number, clientX: number, clientY: number) {
    const zoom = Math.min(1.8, Math.max(0.08, next));
    const rect = this.el("viewport").getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const ratio = zoom / this.zoom;
    this.panX = px - (px - this.panX) * ratio;
    this.panY = py - (py - this.panY) * ratio;
    this.zoom = zoom;
    this.applyTransform();
    this.renderStatus();
  }

  private startPan(event: PointerEvent) {
    this.drag = {
      kind: "pan",
      startX: event.clientX - this.panX,
      startY: event.clientY - this.panY,
      origin: this.selected() ?? defaultComponent("container", 0, 0),
      moved: false,
    };
    this.userZoomed = true;
    this.el("viewport").classList.add("panning");
  }

  private clientToSlide(event: PointerEvent | MouseEvent | DragEvent): { x: number; y: number } {
    const rect = this.el("slide").getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - rect.left) / rect.width) * SLIDE_WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * SLIDE_HEIGHT,
    };
  }

  private hit(x: number, y: number): SlideComponent | undefined {
    return [...this.current().components]
      .reverse()
      .find(
        (component) =>
          x >= component.x &&
          y >= component.y &&
          x <= component.x + component.width &&
          y <= component.y + component.height,
      );
  }

  private onPointerDown(event: PointerEvent) {
    if (this.editing) {
      const target = event.target as HTMLElement;
      if (!target.closest(".el.editing")) this.finishTextEdit();
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest(".handle")) {
      const origin = this.selected();
      if (!origin) return;
      this.drag = {
        kind: "resize",
        handle: target.dataset.handle as Handle,
        startX: event.clientX,
        startY: event.clientY,
        origin: structuredClone(origin),
        moved: false,
      };
      event.preventDefault();
      return;
    }

    if (event.button === 1 || this.spaceDown) {
      this.startPan(event);
      return;
    }

    const point = this.clientToSlide(event);
    if (this.tool !== "select") {
      this.placeComponent(this.tool, point.x, point.y);
      return;
    }

    const hit = this.hit(point.x, point.y);
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    const now = performance.now();
    const isDouble =
      !additive && !!hit && !!this.lastClick && this.lastClick.id === hit.id && now - this.lastClick.at < 450;
    this.lastClick = hit ? { id: hit.id, at: now } : null;

    if (hit && isDouble && hit.type === "text") {
      this.selectedId = hit.id;
      this.lastClick = null;
      event.preventDefault();
      this.startTextEdit();
      this.renderLayers();
      this.renderProps();
      return;
    }

    const before = this.selectedIds.join(" ");
    if (hit) {
      if (additive) {
        // Shift/⌘-click toggles membership; nothing moves on this press.
        this.selectedIds = this.isSelected(hit.id)
          ? this.selectedIds.filter((id) => id !== hit.id)
          : [...this.selectedIds, hit.id];
      } else {
        // Pressing a layer that is already part of the selection keeps the
        // group, so a multi-selection can be dragged as one.
        if (!this.isSelected(hit.id)) this.selectedId = hit.id;
        this.drag = {
          kind: "move",
          startX: event.clientX,
          startY: event.clientY,
          origin: structuredClone(hit),
          origins: this.selectedAll().map((component) => structuredClone(component)),
          moved: false,
        };
      }
    } else if (this.insideSlide(point)) {
      // Empty slide area: drag a marquee to select several layers. Shift
      // adds to the current selection; a plain click clears it.
      this.drag = {
        kind: "marquee",
        startX: point.x,
        startY: point.y,
        origin: defaultComponent("container", point.x, point.y),
        keep: additive ? [...this.selectedIds] : [],
        moved: false,
      };
      if (!additive) this.selectedIds = [];
    } else {
      // Grey canvas around the slide: drag pans, like every other canvas tool.
      this.startPan(event);
    }
    this.renderOverlay();
    if (before !== this.selectedIds.join(" ")) {
      this.renderLayers();
      this.renderProps();
    }
  }

  private insideSlide(point: { x: number; y: number }): boolean {
    return point.x >= 0 && point.y >= 0 && point.x <= SLIDE_WIDTH && point.y <= SLIDE_HEIGHT;
  }

  /** Marquee rectangle in slide coordinates, from the drag start to `point`. */
  private marqueeRect(point: { x: number; y: number }) {
    const drag = this.drag!;
    const x = Math.min(drag.startX, point.x);
    const y = Math.min(drag.startY, point.y);
    return { x, y, width: Math.abs(point.x - drag.startX), height: Math.abs(point.y - drag.startY) };
  }

  private onPointerMove(event: PointerEvent) {
    if (!this.drag) return;
    if (this.drag.kind === "pan") {
      this.panX = event.clientX - this.drag.startX;
      this.panY = event.clientY - this.drag.startY;
      this.applyTransform();
      return;
    }

    if (this.drag.kind === "marquee") {
      const point = this.clientToSlide(event);
      const rect = this.marqueeRect(point);
      if (rect.width > DRAG_THRESHOLD || rect.height > DRAG_THRESHOLD) this.drag.moved = true;
      const keep = this.drag.keep ?? [];
      const inside = this.current()
        .components.filter((c) => intersects(rect, c) && !keep.includes(c.id))
        .map((c) => c.id);
      this.selectedIds = [...keep, ...inside];
      this.renderOverlay();
      this.renderMarquee(rect);
      return;
    }

    const dist = Math.hypot(event.clientX - this.drag.startX, event.clientY - this.drag.startY);
    if (dist > DRAG_THRESHOLD) this.drag.moved = true;
    if (!this.drag.moved && this.drag.kind === "move") return;

    const useGrid = !event.altKey;
    const rect = this.el("slide").getBoundingClientRect();
    const dx = ((event.clientX - this.drag.startX) / rect.width) * SLIDE_WIDTH;
    const dy = ((event.clientY - this.drag.startY) / rect.height) * SLIDE_HEIGHT;
    const slide = this.current();

    if (this.drag.kind === "move") {
      // Snap the primary layer; the rest keep their offsets so the group
      // does not drift apart.
      const origin = this.drag.origin;
      const sx = snap(origin.x + dx, useGrid) - origin.x;
      const sy = snap(origin.y + dy, useGrid) - origin.y;
      // Clamp as a group: nobody moves further than the tightest layer allows.
      let gx = sx;
      let gy = sy;
      for (const o of this.drag.origins ?? [origin]) {
        gx = Math.max(-o.x, Math.min(gx, SLIDE_WIDTH - o.width - o.x));
        gy = Math.max(-o.y, Math.min(gy, SLIDE_HEIGHT - o.height - o.y));
      }
      for (const o of this.drag.origins ?? [origin]) {
        const index = slide.components.findIndex((component) => component.id === o.id);
        if (index < 0) continue;
        slide.components[index] = { ...slide.components[index]!, x: o.x + gx, y: o.y + gy };
        this.positionNode(slide.components[index]!);
      }
    } else {
      const origin = this.drag.origin;
      const index = slide.components.findIndex((component) => component.id === origin.id);
      if (index < 0) return;
      slide.components[index] = clampComponent(resizeBox(origin, this.drag.handle!, dx, dy, useGrid));
      this.positionNode(slide.components[index]!);
    }
    this.renderOverlay();
  }

  /** Move/resize the existing DOM node instead of rebuilding the slide (images
   *  and fonts would otherwise be re-created on every pointer move). */
  private positionNode(component: SlideComponent) {
    const el = this.root.querySelector<HTMLElement>(`#slide .el[data-id="${component.id}"]`);
    if (!el) return;
    el.style.left = `${component.x}px`;
    el.style.top = `${component.y}px`;
    el.style.width = `${component.width}px`;
    el.style.height = `${component.height}px`;
  }

  private renderMarquee(rect: { x: number; y: number; width: number; height: number } | null) {
    const overlay = this.el("overlay");
    let box = overlay.querySelector<HTMLElement>(".marquee");
    if (!rect) {
      box?.remove();
      return;
    }
    if (!box) {
      box = document.createElement("div");
      box.className = "marquee";
      overlay.append(box);
    }
    box.style.left = `${rect.x}px`;
    box.style.top = `${rect.y}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  }

  private onPointerUp() {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    if (drag.kind === "pan") {
      this.el("viewport").classList.remove("panning");
      return;
    }
    if (drag.kind === "marquee") {
      this.renderMarquee(null);
      this.renderOverlay();
      this.renderLayers();
      this.renderProps();
      const n = this.selectedIds.length;
      this.status = n ? `${n} layer${n === 1 ? "" : "s"} selected` : "Select";
      this.renderStatus();
      return;
    }
    if (drag.moved) {
      this.commit(drag.kind === "resize" ? "Resized" : (drag.origins?.length ?? 1) > 1 ? `Moved ${drag.origins!.length} layers` : "Moved");
    }
    // Plain clicks only select. Text editing starts on double-click or Enter
    // so users never end up in edit mode without noticing.
  }

  /** Native fallback (fires when nothing re-rendered between the clicks). */
  private onDoubleClick(event: MouseEvent) {
    if (this.editing) return;
    const hit = this.hit(this.clientToSlide(event).x, this.clientToSlide(event).y);
    if (hit?.type === "text") {
      this.selectedId = hit.id;
      this.startTextEdit();
    }
  }

  private async onDrop(event: DragEvent) {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (!file?.type.startsWith("image/")) return;
    const point = this.clientToSlide(event);
    const created = this.placeComponent("image", point.x, point.y, false);
    this.pendingImageId = created.id;
    await this.assignImage(file);
  }

  private placeComponent(type: Exclude<Tool, "select">, x: number, y: number, pickImage = true) {
    const created = defaultComponent(type, 0, 0);
    created.x = snap(x - created.width / 2, true);
    created.y = snap(y - created.height / 2, true);
    this.current().components.push(clampComponent(created));
    this.selectedId = created.id;
    this.tool = "select";
    if (type === "image" && pickImage) {
      this.pendingImageId = created.id;
      this.el<HTMLInputElement>("file").click();
    }
    this.commit(type === "text" ? "Added text" : `Added ${type}`);
    if (type === "text") this.startTextEdit();
    return created;
  }

  private async assignImage(file: File) {
    const id = this.pendingImageId ?? this.selectedId;
    this.pendingImageId = null;
    if (!id) return;
    const src = await readFile(file);
    const slide = this.current();
    const index = slide.components.findIndex((component) => component.id === id);
    if (index < 0) return;
    slide.components[index] = {
      ...slide.components[index]!,
      src,
      name: file.name || "Image",
    };
    this.selectedId = id;
    this.commit("Image added");
  }

  private textNode(): HTMLElement | null {
    return this.root.querySelector(`.el[data-id="${this.selectedId}"] .text`);
  }

  private startTextEdit() {
    if (this.selected()?.type !== "text") return;
    this.editing = true;
    this.renderSlide();
    this.renderOverlay();
    const node = this.textNode();
    const wrap = this.root.querySelector(`.el[data-id="${this.selectedId}"]`);
    if (!node || !wrap) {
      this.editing = false;
      return;
    }
    wrap.classList.add("editing");
    node.contentEditable = "true";
    node.spellcheck = false;
    // Defer: during `blur` the new target is not focused yet, so a synchronous
    // commit would rebuild the props panel and swallow the field the user just
    // clicked. One tick later focus has settled and renderProps syncs in place.
    node.addEventListener("blur", () => window.setTimeout(() => this.finishTextEdit(), 0), { once: true });
    node.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  /**
   * Leave inline text edit mode. With `commitChange` the new text is written
   * as its own history step; without it the text is applied in place so the
   * caller's pending commit picks it up.
   */
  private finishTextEdit(commitChange = true) {
    if (!this.editing) return;
    const node = this.textNode();
    const text = node?.innerText.replace(/\u00a0/g, " ") ?? this.selected()?.text ?? "";
    this.editing = false;
    node?.removeAttribute("contenteditable");
    this.root.querySelector(".el.editing")?.classList.remove("editing");
    const selected = this.selected();
    if (!selected || selected.type !== "text") return;
    if (selected.text === text) {
      if (commitChange) this.renderOverlay();
      return;
    }
    if (commitChange) {
      this.mutateSelected({ text }, "Edited text");
    } else {
      selected.text = text;
    }
  }

  private removeSelected() {
    const n = this.selectedIds.length;
    if (!n) return;
    this.current().components = this.current().components.filter((component) => !this.isSelected(component.id));
    this.selectedIds = [];
    this.commit(n > 1 ? `Deleted ${n} layers` : "Deleted");
  }

  /** Move the selection one step in z-order, keeping its internal order. */
  private nudgeLayer(direction: 1 | -1) {
    const slide = this.current();
    const items = slide.components;
    const indices = items.map((c, i) => (this.isSelected(c.id) ? i : -1)).filter((i) => i >= 0);
    if (!indices.length) return;
    if (direction > 0) {
      if (indices[indices.length - 1] === items.length - 1) return;
      for (const i of [...indices].reverse()) [items[i], items[i + 1]] = [items[i + 1]!, items[i]!];
    } else {
      if (indices[0] === 0) return;
      for (const i of indices) [items[i], items[i - 1]] = [items[i - 1]!, items[i]!];
    }
    this.commit(direction > 0 ? "Brought forward" : "Sent back");
  }

  private addSlide() {
    this.deck.slides.push(emptySlide(`Slide ${this.deck.slides.length + 1}`));
    this.slideIndex = this.deck.slides.length - 1;
    this.selectedId = null;
    this.commit("Added slide");
  }

  private onKey(event: KeyboardEvent) {
    if (event.code === "Space") {
      this.spaceDown = true;
    }
    const target = event.target as HTMLElement;
    const inField = target.matches("input, textarea, [contenteditable='true']");
    if (this.editing || inField) {
      if (event.key === "Escape") {
        event.preventDefault();
        this.finishTextEdit();
        (target as HTMLElement).blur();
      }
      if (event.key === "Enter" && !event.shiftKey && target.matches("[contenteditable='true']")) {
        return;
      }
      return;
    }
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (meta && event.key.toLowerCase() === "d") {
      event.preventDefault();
      this.duplicate();
      return;
    }
    if (meta && event.key.toLowerCase() === "a") {
      event.preventDefault();
      this.selectAll();
      return;
    }
    if (event.key === "Enter" && this.selected()?.type === "text") {
      event.preventDefault();
      this.startTextEdit();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      this.removeSelected();
      return;
    }
    if (event.key === "Escape") {
      this.selectedId = null;
      this.tool = "select";
      this.render();
      return;
    }
    if (!this.selectedIds.length) return;
    const step = event.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[event.key];
    if (d) {
      event.preventDefault();
      this.mutateAll((c) => ({ x: c.x + d[0], y: c.y + d[1] }), "Nudged");
    }
  }

  private duplicate() {
    const selected = this.selectedAll();
    if (!selected.length) return;
    const copies = selected.map((component) =>
      clampComponent({
        ...structuredClone(component),
        id: uid(component.type),
        x: component.x + 24,
        y: component.y + 24,
        name: `${component.name} copy`,
      }),
    );
    this.current().components.push(...copies);
    this.selectedIds = copies.map((copy) => copy.id);
    this.commit(copies.length > 1 ? `Duplicated ${copies.length} layers` : "Duplicated");
  }

  private selectAll() {
    this.selectedIds = this.current().components.map((component) => component.id);
    this.status = `${this.selectedIds.length} layers selected`;
    this.renderOverlay();
    this.renderLayers();
    this.renderProps();
    this.renderStatus();
  }

  /** Apply a patch to every selected layer, as one history step. */
  private mutateAll(patch: (component: SlideComponent) => Partial<SlideComponent>, label?: string) {
    const slide = this.current();
    let changed = false;
    slide.components = slide.components.map((component) => {
      if (!this.isSelected(component.id)) return component;
      changed = true;
      return clampComponent({ ...component, ...patch(component) });
    });
    if (changed) this.commit(label);
  }

  private undo() {
    this.finishTextEdit();
    const previous = this.history.pop();
    if (!previous) return;
    this.future.push(this.committed);
    this.deck = snapshot(previous);
    this.committed = previous;
    this.clampSelection();
    this.status = "Undo";
    this.onChange?.(this.committed);
    this.render();
  }

  private redo() {
    const next = this.future.pop();
    if (!next) return;
    this.history.push(this.committed);
    this.deck = snapshot(next);
    this.committed = next;
    this.clampSelection();
    this.status = "Redo";
    this.onChange?.(this.committed);
    this.render();
  }

  /** After undo/redo the current slide or selected component may be gone. */
  private clampSelection() {
    this.slideIndex = Math.min(this.slideIndex, this.deck.slides.length - 1);
    const ids = new Set(this.current().components.map((component) => component.id));
    this.selectedIds = this.selectedIds.filter((id) => ids.has(id));
  }

  render() {
    this.el<HTMLElement>("deck-title").textContent = this.deck.title;
    this.renderTools();
    this.applyTransform();
    this.renderSlide();
    this.renderOverlay();
    this.renderLayers();
    this.renderProps();
    this.renderThumbs();
    this.renderStatus();
  }

  private renderTools() {
    this.root.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((button) => {
      button.classList.toggle("active", button.dataset.tool === this.tool);
    });
  }

  private renderStatus() {
    this.el("status").textContent =
      `${this.status} · ${Math.round(this.zoom * 100)}% · 16:9 · ${this.slideIndex + 1}/${this.deck.slides.length}`;
  }

  private renderSlide() {
    const slide = this.current();
    const node = this.el("slide");
    node.style.background = slide.background;
    node.replaceChildren(...slide.components.map((component) => this.componentNode(component)));
  }

  private componentNode(component: SlideComponent): HTMLElement {
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

    if (component.type === "text") {
      const text = document.createElement("div");
      text.className = "text";
      text.textContent = component.text ?? "";
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

  private renderOverlay() {
    const overlay = this.el("overlay");
    const marquee = overlay.querySelector(".marquee");
    overlay.replaceChildren(...(marquee ? [marquee] : []));
    if (this.editing) return;
    const selected = this.selectedAll();
    if (!selected.length) return;
    const single = selected.length === 1;
    for (const component of selected) {
      const box = document.createElement("div");
      box.className = single ? "sel" : "sel multi";
      box.style.left = `${component.x}px`;
      box.style.top = `${component.y}px`;
      box.style.width = `${component.width}px`;
      box.style.height = `${component.height}px`;
      if (single) {
        for (const handle of HANDLES) {
          const node = document.createElement("div");
          node.className = `handle ${handle}`;
          node.dataset.handle = handle;
          box.append(node);
        }
      }
      overlay.append(box);
    }
    if (!single) {
      const bounds = groupBounds(selected);
      const group = document.createElement("div");
      group.className = "sel group";
      group.style.left = `${bounds.x}px`;
      group.style.top = `${bounds.y}px`;
      group.style.width = `${bounds.width}px`;
      group.style.height = `${bounds.height}px`;
      overlay.append(group);
    }
  }

  private renderLayers() {
    const layers = this.el("layers");
    layers.replaceChildren();
    for (const component of [...this.current().components].reverse()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "layer";
      button.dataset.active = String(this.isSelected(component.id));
      const anim = component.animation;
      const badge = anim
        ? `<i class="anim-badge" title="${escape(describeAnimation(anim))}">${anim.step ? `▶${anim.step}` : "▶"}</i>`
        : "";
      button.innerHTML = `<small>${component.type}</small><span>${escape(component.name)}</span>${badge}`;
      button.addEventListener("click", (event) => {
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
          this.selectedIds = this.isSelected(component.id)
            ? this.selectedIds.filter((id) => id !== component.id)
            : [...this.selectedIds, component.id];
        } else {
          this.selectedId = component.id;
        }
        this.renderOverlay();
        this.renderLayers();
        this.renderProps();
      });
      layers.append(button);
    }
  }

  private renderThumbs() {
    const thumbs = this.el("thumbs");
    thumbs.replaceChildren();
    this.deck.slides.forEach((slide, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "thumb";
      button.dataset.active = String(index === this.slideIndex);
      button.style.background = slide.background;
      const label = document.createElement("span");
      label.textContent = `${index + 1}. ${slide.name}`;
      button.append(label);
      button.addEventListener("click", () => {
        this.finishTextEdit();
        this.slideIndex = index;
        this.selectedId = null;
        this.render();
      });
      thumbs.append(button);
    });
  }

  private renderProps() {
    const props = this.el("props");
    const selected = this.selected();
    if (props.contains(document.activeElement) && document.activeElement?.matches("input, textarea, select")) {
      // Keep the focused field alive; just refresh the other values in place.
      if (selected) this.syncPropValues(selected);
      return;
    }
    if (!selected) {
      props.innerHTML = `
        <h2>Slide</h2>
        <div class="field"><label>Name</label><input id="slide-name" value="${escape(this.current().name)}" /></div>
        <div class="field"><label>Background</label><input id="slide-bg" type="color" value="${cssColorToHex(this.current().background)}" /></div>
        <div class="field"><label>Deck title</label><input id="deck-name" value="${escape(this.deck.title)}" /></div>
        <p class="empty-props">Click a layer to edit. Double-click or press Enter to change text. Attach an .html or .pptx deck in chat to edit it here.</p>
      `;
      this.bindField("slide-name", (value) => {
        this.current().name = value;
        this.commit("Renamed slide");
      });
      this.bindField("slide-bg", (value) => {
        this.current().background = value;
        this.commit("Slide fill");
      }, "input");
      this.bindField("deck-name", (value) => {
        this.deck.title = value;
        this.commit("Renamed deck");
      });
      return;
    }

    if (this.selectedIds.length > 1) {
      const group = this.selectedAll();
      const bounds = groupBounds(group);
      props.innerHTML = `
        <h2>${group.length} layers</h2>
        <div class="xywh">
          ${numField("X", "group-x", bounds.x)}
          ${numField("Y", "group-y", bounds.y)}
        </div>
        <div class="prop-row">
          <button class="btn" id="group-dup" type="button">Duplicate</button>
          <button class="btn" id="group-del" type="button">Delete</button>
        </div>
        <p class="empty-props">Drag to move them together, arrow keys to nudge. Shift-click adds or removes a layer; click empty slide space to start over.</p>
      `;
      this.bindField("group-x", (value) => {
        const dx = Number(value) - bounds.x;
        this.mutateAll((c) => ({ x: c.x + dx }), "Moved");
      });
      this.bindField("group-y", (value) => {
        const dy = Number(value) - bounds.y;
        this.mutateAll((c) => ({ y: c.y + dy }), "Moved");
      });
      props.querySelector("#group-dup")?.addEventListener("click", () => this.duplicate());
      props.querySelector("#group-del")?.addEventListener("click", () => this.removeSelected());
      return;
    }

    props.innerHTML = `
      <h2>${escape(selected.type)}</h2>
      <div class="xywh">
        ${numField("X", "prop-x", selected.x)}
        ${numField("Y", "prop-y", selected.y)}
        ${numField("W", "prop-w", selected.width)}
        ${numField("H", "prop-h", selected.height)}
      </div>
      <div class="field"><label>Name</label><input id="prop-name" value="${escape(selected.name)}" /></div>
      ${
        selected.type === "text"
          ? `
        <div class="field"><label>Text</label><textarea id="prop-text">${escape(selected.text ?? "")}</textarea></div>
        ${numField("Size", "prop-size", selected.fontSize ?? 32)}
        <div class="field"><label>Color</label><input id="prop-color" type="color" value="${cssColorToHex(selected.color ?? "#111827")}" /></div>
        <div class="field"><label>Align</label>
          <select id="prop-align">
            <option value="left" ${selected.textAlign === "left" ? "selected" : ""}>Left</option>
            <option value="center" ${selected.textAlign === "center" ? "selected" : ""}>Center</option>
            <option value="right" ${selected.textAlign === "right" ? "selected" : ""}>Right</option>
          </select>
        </div>`
          : ""
      }
      ${
        selected.type === "image"
          ? `
        <div class="field"><label>Image URL</label><input id="prop-src" value="${escape(selected.src && selected.src.startsWith("data:") ? "" : (selected.src ?? ""))}" placeholder="https://…" /></div>
        <div class="field"><label>Fit</label>
          <select id="prop-fit">
            <option value="cover" ${selected.objectFit === "cover" ? "selected" : ""}>Cover</option>
            <option value="contain" ${selected.objectFit === "contain" ? "selected" : ""}>Contain</option>
            <option value="fill" ${selected.objectFit === "fill" ? "selected" : ""}>Fill</option>
          </select>
        </div>
        <button class="btn" id="prop-file" type="button">Replace image</button>`
          : ""
      }
      ${
        selected.type === "container" || selected.type === "html"
          ? `
        <div class="field"><label>Fill</label><input id="prop-bg" type="color" value="${cssColorToHex(selected.background ?? "#ffffff")}" /></div>
        ${numField("Radius", "prop-radius", selected.borderRadius ?? 0)}`
          : ""
      }
      ${
        selected.animation
          ? `
        <h2 class="props-sub">Animation</h2>
        <p class="anim-summary">${escape(describeAnimation(selected.animation))}</p>
        <p class="hint">Preserved from the imported deck and kept in the export. Press Play to preview.</p>
        <button class="btn" id="prop-anim-remove" type="button">Remove animation</button>`
          : ""
      }
    `;

    const bindNum = (id: string, key: keyof SlideComponent) => {
      this.bindField(id, (value) => {
        this.mutateSelected({ [key]: Number(value) } as Partial<SlideComponent>, undefined, true);
      });
    };
    bindNum("prop-x", "x");
    bindNum("prop-y", "y");
    bindNum("prop-w", "width");
    bindNum("prop-h", "height");
    this.bindField("prop-name", (value) => this.mutateSelected({ name: value }));
    this.bindField("prop-text", (value) => {
      this.mutateSelected({ text: value }, "Edited text", false);
      const node = this.textNode();
      if (node) node.textContent = value;
    }, "input");
    bindNum("prop-size", "fontSize");
    this.bindField("prop-color", (value) => this.mutateSelected({ color: value }), "input");
    this.bindField("prop-align", (value) => {
      this.mutateSelected({ textAlign: value as SlideComponent["textAlign"] });
    });
    this.bindField("prop-src", (value) => this.mutateSelected({ src: value }, "Image URL"));
    this.bindField("prop-fit", (value) => {
      this.mutateSelected({ objectFit: value as SlideComponent["objectFit"] });
    });
    this.bindField("prop-bg", (value) => this.mutateSelected({ background: value }), "input");
    bindNum("prop-radius", "borderRadius");
    props.querySelector("#prop-file")?.addEventListener("click", () => {
      this.pendingImageId = selected.id;
      this.el<HTMLInputElement>("file").click();
    });
    props.querySelector("#prop-anim-remove")?.addEventListener("click", () => {
      this.mutateSelected({ animation: undefined }, "Animation removed");
    });
  }

  /**
   * Replay the current slide's entrance once, the way the export plays it:
   * same keyframes, same timing. Purely visual; nothing is committed.
   */
  playAnimations() {
    this.finishTextEdit();
    if (!document.getElementById("ld-anim-keyframes")) {
      const style = document.createElement("style");
      style.id = "ld-anim-keyframes";
      style.textContent = ANIMATION_KEYFRAMES;
      document.head.append(style);
    }
    const nodes = this.root.querySelectorAll<HTMLElement>("#slide .el");
    let any = false;
    for (const node of nodes) {
      const component = this.current().components.find((c) => c.id === node.dataset.id);
      const value = component ? animationValue(component) : "";
      node.style.animation = "";
      if (!value) continue;
      any = true;
      // Restart: a reflow between clearing and setting re-triggers it.
      void node.offsetWidth;
      node.style.animation = value;
      node.addEventListener("animationend", () => (node.style.animation = ""), { once: true });
    }
    this.status = any ? "Playing entrance" : "No animations on this slide";
    this.renderStatus();
  }

  private syncPropValues(selected: SlideComponent) {
    const values: Record<string, string | undefined> = {
      "prop-x": String(Math.round(selected.x)),
      "prop-y": String(Math.round(selected.y)),
      "prop-w": String(Math.round(selected.width)),
      "prop-h": String(Math.round(selected.height)),
      "prop-name": selected.name,
      "prop-text": selected.text,
      "prop-size": selected.fontSize != null ? String(Math.round(selected.fontSize)) : undefined,
      "prop-radius": selected.borderRadius != null ? String(Math.round(selected.borderRadius)) : undefined,
    };
    for (const [id, value] of Object.entries(values)) {
      const field = this.root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
      if (!field || field === document.activeElement || value == null) continue;
      if (field.value !== value) field.value = value;
    }
  }

  private bindField(id: string, apply: (value: string) => void, eventName: "change" | "input" = "change") {
    const field = this.root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`#${id}`);
    field?.addEventListener(eventName, () => apply(field.value));
  }
}

function describeAnimation(anim: LayerAnimation): string {
  const when = anim.step ? `build step ${anim.step}` : anim.delay ? `after ${anim.delay} ms` : "with the slide";
  return `${anim.effect.replace("-", " ")} · ${anim.duration} ms · ${when}`;
}

function intersects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function groupBounds(items: SlideComponent[]): { x: number; y: number; width: number; height: number } {
  const x = Math.min(...items.map((c) => c.x));
  const y = Math.min(...items.map((c) => c.y));
  return {
    x,
    y,
    width: Math.max(...items.map((c) => c.x + c.width)) - x,
    height: Math.max(...items.map((c) => c.y + c.height)) - y,
  };
}

function numField(label: string, id: string, value: number): string {
  return `<div class="field"><label>${label}</label><input id="${id}" type="number" value="${Math.round(value)}" /></div>`;
}

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function resizeBox(
  origin: SlideComponent,
  handle: Handle,
  dx: number,
  dy: number,
  useGrid: boolean,
): SlideComponent {
  let { x, y, width, height } = origin;
  if (handle.includes("e")) width = origin.width + dx;
  if (handle.includes("s")) height = origin.height + dy;
  if (handle.includes("w")) {
    width = origin.width - dx;
    x = origin.x + dx;
  }
  if (handle.includes("n")) {
    height = origin.height - dy;
    y = origin.y + dy;
  }
  return {
    ...origin,
    x: snap(x, useGrid),
    y: snap(y, useGrid),
    width: Math.max(24, snap(width, useGrid)),
    height: Math.max(24, snap(height, useGrid)),
  };
}
