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

function snap(value: number, enabled: boolean): number {
  return enabled ? Math.round(value / GRID) * GRID : value;
}

function slideAt(deck: Deck, index: number): Slide {
  return deck.slides[index] ?? deck.slides[0]!;
}

function findComponent(slide: Slide, id: string | null): SlideComponent | undefined {
  return slide.components.find((component) => component.id === id);
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
  private pendingImageId: string | null = null;
  private drag:
    | {
        kind: "move" | "resize" | "pan";
        handle?: Handle;
        startX: number;
        startY: number;
        origin: SlideComponent;
      }
    | null = null;

  constructor(private readonly root: HTMLElement, deck: Deck) {
    this.deck = structuredClone(deck);
    this.bind();
    this.fit();
    this.render();
  }

  setDeck(deck: Deck, status = "Loaded") {
    this.deck = structuredClone(deck);
    this.slideIndex = 0;
    this.selectedId = null;
    this.history = [];
    this.future = [];
    this.status = status;
    this.render();
  }

  getDeck(): Deck {
    return structuredClone(this.deck);
  }

  exportHtml(): string {
    return deckToHtml(this.deck);
  }

  private current(): Slide {
    return slideAt(this.deck, this.slideIndex);
  }

  private selected(): SlideComponent | undefined {
    return findComponent(this.current(), this.selectedId);
  }

  private commit(label?: string) {
    this.history.push(structuredClone(this.deck));
    if (this.history.length > 60) this.history.shift();
    this.future = [];
    this.deck.updatedAt = new Date().toISOString();
    this.deck.source = "user";
    if (label) this.status = label;
    this.onChange?.(this.getDeck());
    this.render();
  }

  private replaceSlide(slide: Slide) {
    this.deck.slides[this.slideIndex] = slide;
  }

  private updateSelected(patch: Partial<SlideComponent>, label?: string) {
    const slide = structuredClone(this.current());
    const index = slide.components.findIndex((component) => component.id === this.selectedId);
    if (index < 0) return;
    slide.components[index] = clampComponent({
      ...slide.components[index]!,
      ...patch,
    });
    this.replaceSlide(slide);
    this.commit(label);
  }

  private bind() {
    this.root.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((button) => {
      button.addEventListener("click", () => {
        this.tool = button.dataset.tool as Tool;
        this.status = this.tool === "select" ? "Select" : `Click the slide to add ${this.tool}`;
        this.render();
      });
    });

    this.el("fit-btn").addEventListener("click", () => this.fit());
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
        const factor = event.deltaY > 0 ? 0.92 : 1.08;
        this.zoom = Math.min(1.6, Math.max(0.12, this.zoom * factor));
        this.applyTransform();
        this.renderStatus();
      },
      { passive: false },
    );

    viewport.addEventListener("dblclick", (event) => this.onDoubleClick(event));
    viewport.addEventListener("dragover", (event) => event.preventDefault());
    viewport.addEventListener("drop", (event) => this.onDrop(event));

    this.el<HTMLInputElement>("file").addEventListener("change", () => {
      const file = this.el<HTMLInputElement>("file").files?.[0];
      this.el<HTMLInputElement>("file").value = "";
      if (file) void this.assignImage(file);
    });

    window.addEventListener("keydown", (event) => this.onKey(event));
    window.addEventListener("keyup", (event) => {
      if (event.code === "Space") this.spaceDown = false;
    });
  }

  private el<T extends HTMLElement = HTMLElement>(id: string): T {
    const node = this.root.querySelector<T>(`#${id}`);
    if (!node) throw new Error(`Missing #${id}`);
    return node;
  }

  private fit() {
    const viewport = this.el("viewport");
    const pad = 56;
    const scale = Math.min(
      (viewport.clientWidth - pad) / SLIDE_WIDTH,
      (viewport.clientHeight - pad) / SLIDE_HEIGHT,
    );
    this.zoom = Math.max(0.12, scale);
    this.panX = (viewport.clientWidth - SLIDE_WIDTH * this.zoom) / 2;
    this.panY = (viewport.clientHeight - SLIDE_HEIGHT * this.zoom) / 2;
    this.applyTransform();
    this.renderStatus();
  }

  private applyTransform() {
    this.el("stage").style.transform =
      `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
  }

  private clientToSlide(event: PointerEvent | MouseEvent | DragEvent): { x: number; y: number } {
    const rect = this.el("slide").getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / this.zoom,
      y: (event.clientY - rect.top) / this.zoom,
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
    if (this.editing) return;
    const target = event.target as HTMLElement;
    if (target.closest(".handle")) {
      const handle = target.dataset.handle as Handle;
      const origin = this.selected();
      if (!origin) return;
      this.drag = {
        kind: "resize",
        handle,
        startX: event.clientX,
        startY: event.clientY,
        origin: structuredClone(origin),
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
      };
      return;
    }

    const point = this.clientToSlide(event);
    if (this.tool !== "select") {
      this.placeComponent(this.tool, point.x, point.y);
      return;
    }

    const hit = this.hit(point.x, point.y);
    this.selectedId = hit?.id ?? null;
    if (hit) {
      this.drag = {
        kind: "move",
        startX: event.clientX,
        startY: event.clientY,
        origin: structuredClone(hit),
      };
    }
    this.render();
  }

  private onPointerMove(event: PointerEvent) {
    if (!this.drag) return;
    if (this.drag.kind === "pan") {
      this.panX = event.clientX - this.drag.startX;
      this.panY = event.clientY - this.drag.startY;
      this.applyTransform();
      return;
    }

    const useGrid = !event.altKey;
    const dx = (event.clientX - this.drag.startX) / this.zoom;
    const dy = (event.clientY - this.drag.startY) / this.zoom;
    const origin = this.drag.origin;
    let next = { ...origin };

    if (this.drag.kind === "move") {
      next.x = snap(origin.x + dx, useGrid);
      next.y = snap(origin.y + dy, useGrid);
    } else {
      next = resizeBox(origin, this.drag.handle!, dx, dy, useGrid);
    }

    const slide = structuredClone(this.current());
    const index = slide.components.findIndex((component) => component.id === origin.id);
    if (index < 0) return;
    slide.components[index] = clampComponent(next);
    this.replaceSlide(slide);
    this.renderSlide();
    this.renderOverlay();
    this.renderProps();
  }

  private onPointerUp() {
    if (!this.drag) return;
    const kind = this.drag.kind;
    this.drag = null;
    if (kind !== "pan") this.commit("Moved");
  }

  private onDoubleClick(event: MouseEvent) {
    const point = this.clientToSlide(event);
    const hit = this.hit(point.x, point.y);
    if (hit?.type === "text") {
      this.selectedId = hit.id;
      this.startTextEdit();
    }
  }

  private onDrop(event: DragEvent) {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    const point = this.clientToSlide(event);
    const created = this.placeComponent("image", point.x, point.y, false);
    this.pendingImageId = created.id;
    void this.assignImage(file);
  }

  private placeComponent(type: Exclude<Tool, "select">, x: number, y: number, pickImage = true) {
    const created = defaultComponent(type, 0, 0);
    created.x = snap(x - created.width / 2, true);
    created.y = snap(y - created.height / 2, true);
    const slide = structuredClone(this.current());
    slide.components.push(clampComponent(created));
    this.replaceSlide(slide);
    this.selectedId = created.id;
    this.tool = "select";
    if (type === "image" && pickImage) {
      this.pendingImageId = created.id;
      this.el<HTMLInputElement>("file").click();
    }
    if (type === "text") {
      this.commit("Added text");
      this.startTextEdit();
      return created;
    }
    this.commit(`Added ${type}`);
    return created;
  }

  private async assignImage(file: File) {
    const id = this.pendingImageId ?? this.selectedId;
    this.pendingImageId = null;
    if (!id) return;
    const src = await readFile(file);
    const slide = structuredClone(this.current());
    const index = slide.components.findIndex((component) => component.id === id);
    if (index < 0) return;
    slide.components[index] = {
      ...slide.components[index]!,
      src,
      name: file.name || "Image",
    };
    this.replaceSlide(slide);
    this.selectedId = id;
    this.commit("Image added");
  }

  private startTextEdit() {
    this.editing = true;
    this.render();
    const node = this.root.querySelector<HTMLElement>(`.el[data-id="${this.selectedId}"] .text`);
    if (!node) {
      this.editing = false;
      return;
    }
    node.contentEditable = "true";
    node.focus();
    const finish = () => {
      node.contentEditable = "false";
      this.editing = false;
      this.updateSelected({ text: node.innerText }, "Edited text");
    };
    node.addEventListener("blur", finish, { once: true });
    node.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        node.blur();
      }
    });
  }

  private removeSelected() {
    if (!this.selectedId) return;
    const slide = structuredClone(this.current());
    slide.components = slide.components.filter((component) => component.id !== this.selectedId);
    this.replaceSlide(slide);
    this.selectedId = null;
    this.commit("Deleted");
  }

  private nudgeLayer(direction: 1 | -1) {
    const slide = structuredClone(this.current());
    const index = slide.components.findIndex((component) => component.id === this.selectedId);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= slide.components.length) return;
    const [item] = slide.components.splice(index, 1);
    slide.components.splice(next, 0, item!);
    this.replaceSlide(slide);
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
      if (!this.editing && !(event.target as HTMLElement).matches("input, textarea, [contenteditable='true']")) {
        event.preventDefault();
      }
    }
    const target = event.target as HTMLElement;
    if (this.editing || target.matches("input, textarea, [contenteditable='true']")) {
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
      this.updateSelected(map[event.key]!, "Nudged");
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
    const slide = structuredClone(this.current());
    slide.components.push(copy);
    this.replaceSlide(slide);
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
    this.root.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((button) => {
      button.classList.toggle("active", button.dataset.tool === this.tool);
    });
    this.applyTransform();
    this.renderSlide();
    this.renderOverlay();
    this.renderLayers();
    this.renderProps();
    this.renderThumbs();
    this.renderStatus();
  }

  private renderStatus() {
    this.el("status").textContent =
      `${this.status} · ${Math.round(this.zoom * 100)}% · 16:9 · ${this.slideIndex + 1}/${this.deck.slides.length}`;
  }

  private renderSlide() {
    const slide = this.current();
    const node = this.el("slide");
    node.style.background = slide.background;
    node.replaceChildren(
      ...slide.components.map((component) => this.componentNode(component)),
    );
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
    if (!selected) return;
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
        this.render();
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
      const preview = document.createElement("div");
      preview.className = "thumb-preview";
      preview.style.background = slide.background;
      preview.style.width = `${SLIDE_WIDTH}px`;
      preview.style.height = `${SLIDE_HEIGHT}px`;
      slide.components.forEach((component) => preview.append(this.componentNode(component)));
      const label = document.createElement("span");
      label.textContent = `${index + 1}. ${slide.name}`;
      button.append(preview, label);
      button.addEventListener("click", () => {
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
    if (!selected) {
      props.innerHTML = `
        <h2>Slide</h2>
        <div class="field"><label>Name</label><input id="slide-name" value="${escape(this.current().name)}" /></div>
        <div class="field"><label>Background</label><input id="slide-bg" type="color" value="${toColor(this.current().background)}" /></div>
        <div class="field"><label>Deck title</label><input id="deck-name" value="${escape(this.deck.title)}" /></div>
        <p class="empty-props">Select a layer or click the slide with Text, Image, or Frame.</p>
      `;
      this.el<HTMLInputElement>("slide-name").addEventListener("change", (event) => {
        this.current().name = (event.target as HTMLInputElement).value;
        this.commit("Renamed slide");
      });
      this.el<HTMLInputElement>("slide-bg").addEventListener("input", (event) => {
        this.current().background = (event.target as HTMLInputElement).value;
        this.commit("Slide fill");
      });
      this.el<HTMLInputElement>("deck-name").addEventListener("change", (event) => {
        this.deck.title = (event.target as HTMLInputElement).value;
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
        <div class="field"><label>Color</label><input id="prop-color" type="color" value="${toColor(selected.color ?? "#111827")}" /></div>
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
        selected.type === "container"
          ? `
        <div class="field"><label>Fill</label><input id="prop-bg" type="color" value="${toColor(selected.background ?? "#ffffff")}" /></div>
        ${numField("Radius", "prop-radius", selected.borderRadius ?? 0)}`
          : ""
      }
    `;

    const bindNum = (id: string, key: keyof SlideComponent) => {
      const input = props.querySelector<HTMLInputElement>(`#${id}`);
      input?.addEventListener("change", () => {
        this.updateSelected({ [key]: Number(input.value) } as Partial<SlideComponent>);
      });
    };
    bindNum("prop-x", "x");
    bindNum("prop-y", "y");
    bindNum("prop-w", "width");
    bindNum("prop-h", "height");
    props.querySelector("#prop-name")?.addEventListener("change", (event) => {
      this.updateSelected({ name: (event.target as HTMLInputElement).value });
    });
    props.querySelector("#prop-text")?.addEventListener("change", (event) => {
      this.updateSelected({ text: (event.target as HTMLTextAreaElement).value }, "Edited text");
    });
    bindNum("prop-size", "fontSize");
    props.querySelector("#prop-color")?.addEventListener("input", (event) => {
      this.updateSelected({ color: (event.target as HTMLInputElement).value });
    });
    props.querySelector("#prop-align")?.addEventListener("change", (event) => {
      this.updateSelected({
        textAlign: (event.target as HTMLSelectElement).value as SlideComponent["textAlign"],
      });
    });
    props.querySelector("#prop-src")?.addEventListener("change", (event) => {
      this.updateSelected({ src: (event.target as HTMLInputElement).value }, "Image URL");
    });
    props.querySelector("#prop-fit")?.addEventListener("change", (event) => {
      this.updateSelected({
        objectFit: (event.target as HTMLSelectElement).value as SlideComponent["objectFit"],
      });
    });
    props.querySelector("#prop-file")?.addEventListener("click", () => {
      this.pendingImageId = selected.id;
      this.el<HTMLInputElement>("file").click();
    });
    props.querySelector("#prop-bg")?.addEventListener("input", (event) => {
      this.updateSelected({ background: (event.target as HTMLInputElement).value });
    });
    bindNum("prop-radius", "borderRadius");
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

function toColor(value: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  return "#ffffff";
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

