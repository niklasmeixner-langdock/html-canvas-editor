import { cssColorToHex } from "./color.ts";
import { flattenHtmlDocument, needsFlatten } from "./flatten.ts";
import { deckToHtml } from "./html.ts";
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

export class SlideEditor {
  deck: Deck;
  slideIndex = 0;
  selectedId: string | null = null;
  tool: Tool = "select";
  zoom = 0.4;
  panX = 48;
  panY = 36;
  status = "Ready";
  onChange: ((deck: Deck) => void) | null = null;

  private history: Deck[] = [];
  private future: Deck[] = [];
  private editing = false;
  private spaceDown = false;
  private userZoomed = false;
  private pendingImageId: string | null = null;
  private flattening = false;
  private drag:
    | {
        kind: "move" | "resize" | "pan";
        handle?: Handle;
        startX: number;
        startY: number;
        origin: SlideComponent;
        moved: boolean;
        already?: boolean;
      }
    | null = null;

  constructor(private readonly root: HTMLElement, deck: Deck) {
    this.deck = structuredClone(deck);
    this.bind();
    this.fit();
    this.render();
    void this.flattenImported();
  }

  setDeck(deck: Deck, status = "Loaded") {
    this.finishTextEdit();
    this.deck = structuredClone(deck);
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
    return structuredClone(this.deck);
  }

  exportHtml(): string {
    return deckToHtml(this.getDeck());
  }

  async importHtml(html: string) {
    this.status = "Importing…";
    this.renderStatus();
    const flattened = await flattenHtmlDocument(html);
    this.setDeck(flattened, `Imported ${flattened.slides.length} slide${flattened.slides.length === 1 ? "" : "s"}`);
    this.onChange?.(this.getDeck());
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
      this.deck = flattened;
      this.status = "Imported slide is editable";
      this.render();
      this.onChange?.(this.getDeck());
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
    if (this.editing) return;
    this.history.push(structuredClone(this.deck));
    if (this.history.length > 60) this.history.shift();
    this.future = [];
    this.deck.updatedAt = new Date().toISOString();
    this.deck.source = "user";
    delete this.deck.rawHtml;
    if (label) this.status = label;
    this.onChange?.(this.getDeck());
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
        event.preventDefault();
        this.userZoomed = true;
        const factor = event.deltaY > 0 ? 0.92 : 1.08;
        this.zoom = Math.min(1.8, Math.max(0.08, this.zoom * factor));
        this.applyTransform();
        this.renderStatus();
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
      this.drag = {
        kind: "pan",
        startX: event.clientX - this.panX,
        startY: event.clientY - this.panY,
        origin: this.selected() ?? defaultComponent("container", 0, 0),
        moved: false,
      };
      return;
    }

    const point = this.clientToSlide(event);
    if (this.tool !== "select") {
      this.placeComponent(this.tool, point.x, point.y);
      return;
    }

    const hit = this.hit(point.x, point.y);
    const already = hit && hit.id === this.selectedId;
    this.selectedId = hit?.id ?? null;
    if (hit) {
      this.drag = {
        kind: "move",
        startX: event.clientX,
        startY: event.clientY,
        origin: structuredClone(hit),
        moved: false,
        already: Boolean(already),
      };
    }
    this.renderSlide();
    this.renderOverlay();
    this.renderLayers();
    this.renderProps();
  }

  private onPointerMove(event: PointerEvent) {
    if (!this.drag) return;
    if (this.drag.kind === "pan") {
      this.panX = event.clientX - this.drag.startX;
      this.panY = event.clientY - this.drag.startY;
      this.applyTransform();
      return;
    }

    const dist = Math.hypot(event.clientX - this.drag.startX, event.clientY - this.drag.startY);
    if (dist > DRAG_THRESHOLD) this.drag.moved = true;
    if (!this.drag.moved && this.drag.kind === "move") return;

    const useGrid = !event.altKey;
    const rect = this.el("slide").getBoundingClientRect();
    const dx = ((event.clientX - this.drag.startX) / rect.width) * SLIDE_WIDTH;
    const dy = ((event.clientY - this.drag.startY) / rect.height) * SLIDE_HEIGHT;
    const origin = this.drag.origin;
    const next =
      this.drag.kind === "move"
        ? { ...origin, x: snap(origin.x + dx, useGrid), y: snap(origin.y + dy, useGrid) }
        : resizeBox(origin, this.drag.handle!, dx, dy, useGrid);

    const slide = this.current();
    const index = slide.components.findIndex((component) => component.id === origin.id);
    if (index < 0) return;
    slide.components[index] = clampComponent(next);
    this.renderSlide();
    this.renderOverlay();
  }

  private onPointerUp() {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    if (drag.kind === "pan") return;
    if (drag.moved) {
      this.commit("Moved");
      return;
    }
    const already = drag.already;
    if (already && drag.origin.type === "text") {
      this.startTextEdit();
    }
  }

  private onDoubleClick(event: MouseEvent) {
    const hit = this.hit(this.clientToSlide(event).x, this.clientToSlide(event).y);
    if (hit?.type === "text") {
      this.selectedId = hit.id;
      this.startTextEdit();
    }
  }

  private async onDrop(event: DragEvent) {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (file.name.endsWith(".html") || file.name.endsWith(".htm") || file.type === "text/html") {
      await this.importHtml(await file.text());
      return;
    }
    if (!file.type.startsWith("image/")) return;
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
    node.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  private finishTextEdit() {
    if (!this.editing) return;
    const node = this.textNode();
    const text = node?.innerText.replace(/\u00a0/g, " ") ?? this.selected()?.text ?? "";
    this.editing = false;
    node?.removeAttribute("contenteditable");
    this.root.querySelector(".el.editing")?.classList.remove("editing");
    this.mutateSelected({ text }, "Edited text");
  }

  private removeSelected() {
    if (!this.selectedId) return;
    this.current().components = this.current().components.filter(
      (component) => component.id !== this.selectedId,
    );
    this.selectedId = null;
    this.commit("Deleted");
  }

  private nudgeLayer(direction: 1 | -1) {
    const slide = this.current();
    const index = slide.components.findIndex((component) => component.id === this.selectedId);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= slide.components.length) return;
    const [item] = slide.components.splice(index, 1);
    slide.components.splice(next, 0, item!);
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
    const selected = this.selected();
    if (!selected) return;
    const step = event.shiftKey ? 10 : 1;
    const map: Record<string, Partial<SlideComponent>> = {
      ArrowLeft: { x: selected.x - step },
      ArrowRight: { x: selected.x + step },
      ArrowUp: { y: selected.y - step },
      ArrowDown: { y: selected.y + step },
    };
    if (map[event.key]) {
      event.preventDefault();
      this.mutateSelected(map[event.key]!, "Nudged");
    }
  }

  private duplicate() {
    const selected = this.selected();
    if (!selected) return;
    const copy = clampComponent({
      ...structuredClone(selected),
      id: uid(selected.type),
      x: selected.x + 24,
      y: selected.y + 24,
      name: `${selected.name} copy`,
    });
    this.current().components.push(copy);
    this.selectedId = copy.id;
    this.commit("Duplicated");
  }

  private undo() {
    const previous = this.history.pop();
    if (!previous) return;
    this.future.push(structuredClone(this.deck));
    this.deck = previous;
    this.status = "Undo";
    this.render();
  }

  private redo() {
    const next = this.future.pop();
    if (!next) return;
    this.history.push(structuredClone(this.deck));
    this.deck = next;
    this.status = "Redo";
    this.render();
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
    overlay.replaceChildren();
    const selected = this.selected();
    if (!selected || this.editing) return;
    const box = document.createElement("div");
    box.className = "sel";
    box.style.left = `${selected.x}px`;
    box.style.top = `${selected.y}px`;
    box.style.width = `${selected.width}px`;
    box.style.height = `${selected.height}px`;
    for (const handle of HANDLES) {
      const node = document.createElement("div");
      node.className = `handle ${handle}`;
      node.dataset.handle = handle;
      box.append(node);
    }
    overlay.append(box);
  }

  private renderLayers() {
    const layers = this.el("layers");
    layers.replaceChildren();
    for (const component of [...this.current().components].reverse()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "layer";
      button.dataset.active = String(component.id === this.selectedId);
      button.innerHTML = `<small>${component.type}</small><span>${escape(component.name)}</span>`;
      button.addEventListener("click", () => {
        this.selectedId = component.id;
        this.renderSlide();
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
    if (props.contains(document.activeElement) && document.activeElement?.matches("input, textarea")) {
      return;
    }
    const selected = this.selected();
    if (!selected) {
      props.innerHTML = `
        <h2>Slide</h2>
        <div class="field"><label>Name</label><input id="slide-name" value="${escape(this.current().name)}" /></div>
        <div class="field"><label>Background</label><input id="slide-bg" type="color" value="${cssColorToHex(this.current().background)}" /></div>
        <div class="field"><label>Deck title</label><input id="deck-name" value="${escape(this.deck.title)}" /></div>
        <p class="empty-props">Click a layer to edit. Double-click or press Enter to change text. Open HTML to reuse an existing slide.</p>
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
  }

  private bindField(id: string, apply: (value: string) => void, eventName: "change" | "input" = "change") {
    const field = this.root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`#${id}`);
    field?.addEventListener(eventName, () => apply(field.value));
  }
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
