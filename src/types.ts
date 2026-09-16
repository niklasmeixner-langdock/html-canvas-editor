export const SLIDE_WIDTH = 1920;
export const SLIDE_HEIGHT = 1080;

export type ComponentType = "text" | "image" | "container" | "html";
export type TextAlign = "left" | "center" | "right";
export type ObjectFit = "cover" | "contain" | "fill";
export type DeckSource = "sample" | "user" | "agent";

export type SlideComponent = {
  id: string;
  type: ComponentType;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  text?: string;
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  color?: string;
  textAlign?: TextAlign;
  lineHeight?: number;
  /** px */
  letterSpacing?: number;
  /** Entrance animation, preserved from the imported deck and re-emitted on export. */
  animation?: LayerAnimation;
  src?: string;
  objectFit?: ObjectFit;
  background?: string;
  borderRadius?: number;
  border?: string;
  padding?: number;
  html?: string;
};

/**
 * The small declarative model we keep of an animation. Deliberately not CSS:
 * a handful of entrance effects plus timing is what LLM-written decks use,
 * and it survives the round trip through the canvas. Anything richer
 * (custom keyframes, script-driven motion) is imported in its final state.
 */
export type AnimationEffect = "fade" | "fade-up" | "fade-down" | "fade-left" | "fade-right" | "scale";

export type LayerAnimation = {
  effect: AnimationEffect;
  /** ms after the slide (or the previous build step) starts */
  delay: number;
  /** ms */
  duration: number;
  /** 1-based build step when the source revealed this on click; undefined = with the slide */
  step?: number;
};

export const ANIMATION_EFFECTS: AnimationEffect[] = ["fade", "fade-up", "fade-down", "fade-left", "fade-right", "scale"];

export type Slide = {
  id: string;
  name: string;
  background: string;
  components: SlideComponent[];
};

export type Deck = {
  /** Server-assigned. Every tool call and save is scoped to this id; there is
   *  no global "current deck", so sessions never see each other's work. */
  id?: string;
  title: string;
  width: typeof SLIDE_WIDTH;
  height: typeof SLIDE_HEIGHT;
  slides: Slide[];
  source: DeckSource;
  updatedAt: string;
  rawHtml?: string;
  /** `@import`/`@font-face` CSS the slides' text depends on. Carried along so
   *  the editor and the export wrap text exactly like the original did. */
  fontCss?: string;
};

export function uid(prefix = "id"): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function defaultComponent(
  type: ComponentType,
  x: number,
  y: number,
): SlideComponent {
  const base = {
    id: uid(type),
    type,
    name: type[0].toUpperCase() + type.slice(1),
    x,
    y,
    opacity: 1,
  };

  if (type === "text") {
    return {
      ...base,
      width: 560,
      height: 96,
      text: "Double-click to edit",
      fontSize: 48,
      fontWeight: 600,
      fontFamily: "Inter, system-ui, sans-serif",
      color: "#111827",
      textAlign: "left",
      lineHeight: 1.2,
    };
  }

  if (type === "image") {
    return {
      ...base,
      width: 480,
      height: 320,
      src: "",
      objectFit: "cover",
      background: "#e5e7eb",
      borderRadius: 12,
    };
  }

  if (type === "html") {
    return {
      ...base,
      width: SLIDE_WIDTH,
      height: SLIDE_HEIGHT,
      x: 0,
      y: 0,
      html: "<div>Imported HTML</div>",
    };
  }

  return {
    ...base,
    width: 420,
    height: 260,
    background: "#ffffff",
    borderRadius: 16,
    border: "1px solid #e5e7eb",
  };
}

export function emptySlide(name = "Slide"): Slide {
  return {
    id: uid("slide"),
    name,
    background: "#ffffff",
    components: [],
  };
}

export function emptyDeck(title = "Untitled deck"): Deck {
  return {
    title,
    width: SLIDE_WIDTH,
    height: SLIDE_HEIGHT,
    slides: [emptySlide("Slide 1")],
    source: "user",
    updatedAt: new Date().toISOString(),
  };
}

export function clampComponent(component: SlideComponent): SlideComponent {
  const width = Math.max(24, Math.min(component.width, SLIDE_WIDTH));
  const height = Math.max(24, Math.min(component.height, SLIDE_HEIGHT));
  return {
    ...component,
    width,
    height,
    x: Math.max(0, Math.min(component.x, SLIDE_WIDTH - width)),
    y: Math.max(0, Math.min(component.y, SLIDE_HEIGHT - height)),
    opacity: Math.max(0, Math.min(component.opacity, 1)),
  };
}
