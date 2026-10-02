import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import type { AnimationEffect, Deck, LayerAnimation, Slide, SlideComponent, TextAlign } from "./types.ts";
import { SLIDE_HEIGHT, SLIDE_WIDTH, emptyDeck, uid } from "./types.ts";

/**
 * .pptx → Deck. The inverse of pptx.ts.
 *
 * Every shape on a slide becomes a layer on the 1920×1080 canvas: text boxes
 * keep their type, pictures their bitmap, rectangles their fill and corner
 * radius. Placeholders are resolved through layout and master, so a deck
 * built on a template comes in where PowerPoint shows it. Master and layout
 * decoration (logos, footers) is flattened onto each slide. Entrance
 * animations in the main sequence become the deck's animation model, and so
 * survive into both the HTML and the PPTX export.
 *
 * Lossy by design: charts, tables, SmartArt and connectors are skipped,
 * rotation is dropped, and text takes the style of its first run.
 */

const EMU_PER_PX = 6350;
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_TYPES = {
  slide: "/slide",
  layout: "/slideLayout",
  master: "/slideMaster",
  theme: "/theme",
  image: "/image",
};

type Rel = { id: string; type: string; target: string };
type Theme = { colors: Map<string, string>; major: string; minor: string };
type Part = { doc: Document; path: string; rels: Map<string, Rel> };

type Ctx = {
  zip: JSZip;
  scale: number;
  offsetX: number;
  offsetY: number;
  theme: Theme;
  clrMap: Map<string, string>;
  /** Master/layout/slide spTrees, outermost first, for placeholder lookup. */
  chain: Part[];
  slide: Part;
  master: Part;
  layout: Part | null;
  media: Map<string, Promise<string | null>>;
};

export function isPptx(bytes: Uint8Array, fileName = "", mimeType = ""): boolean {
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  return zip && (/\.pptx$/i.test(fileName) || /presentationml|officedocument\.presentation/i.test(mimeType) || !fileName);
}

export async function pptxToDeck(bytes: Uint8Array, fallbackTitle = "Imported deck"): Promise<Deck> {
  const zip = await JSZip.loadAsync(bytes);
  const presentation = await part(zip, "ppt/presentation.xml");
  if (!presentation) throw new Error("Not a PowerPoint file (no ppt/presentation.xml)");

  const size = first(presentation.doc, P, "sldSz");
  const cx = Number(size?.getAttribute("cx")) || 12192000;
  const cy = Number(size?.getAttribute("cy")) || 6858000;
  // Letterbox decks that are not 16:9 instead of distorting them.
  const scale = Math.min(SLIDE_WIDTH / (cx / EMU_PER_PX), SLIDE_HEIGHT / (cy / EMU_PER_PX));
  const offsetX = (SLIDE_WIDTH - (cx / EMU_PER_PX) * scale) / 2;
  const offsetY = (SLIDE_HEIGHT - (cy / EMU_PER_PX) * scale) / 2;

  const deck = emptyDeck(await title(zip, fallbackTitle));
  deck.slides = [];
  const parts = new Map<string, Part>();
  const themes = new Map<string, Theme>();
  const media = new Map<string, Promise<string | null>>();

  const load = async (path: string): Promise<Part | null> => {
    if (parts.has(path)) return parts.get(path)!;
    const loaded = await part(zip, path);
    if (loaded) parts.set(path, loaded);
    return loaded;
  };

  for (const id of all(presentation.doc, P, "sldId")) {
    const rel = presentation.rels.get(id.getAttributeNS(R, "id") ?? "");
    if (!rel) continue;
    const slidePart = await load(resolve(presentation.path, rel.target));
    if (!slidePart) continue;
    const sld = slidePart.doc.documentElement;
    if (sld.getAttribute("show") === "0") continue;

    const layoutRel = [...slidePart.rels.values()].find((r) => r.type.endsWith(REL_TYPES.layout));
    const layout = layoutRel ? await load(resolve(slidePart.path, layoutRel.target)) : null;
    const masterRel = layout ? [...layout.rels.values()].find((r) => r.type.endsWith(REL_TYPES.master)) : undefined;
    const master = masterRel && layout ? await load(resolve(layout.path, masterRel.target)) : null;
    if (!master) continue;
    const themeRel = [...master.rels.values()].find((r) => r.type.endsWith(REL_TYPES.theme));
    const themePath = themeRel ? resolve(master.path, themeRel.target) : "";
    if (themePath && !themes.has(themePath)) {
      const themePart = await load(themePath);
      themes.set(themePath, themePart ? parseTheme(themePart.doc) : defaultTheme());
    }
    const theme = themes.get(themePath) ?? defaultTheme();

    const ctx: Ctx = {
      zip,
      scale,
      offsetX,
      offsetY,
      theme,
      clrMap: parseClrMap(master.doc, layout?.doc, slidePart.doc),
      chain: [master, ...(layout ? [layout] : []), slidePart],
      slide: slidePart,
      master,
      layout,
      media,
    };
    deck.slides.push(await buildSlide(ctx, deck.slides.length));
  }

  if (!deck.slides.length) throw new Error("The PowerPoint file has no visible slides");
  return deck;
}

// ---- slide ------------------------------------------------------------------

async function buildSlide(ctx: Ctx, index: number): Promise<Slide> {
  const cSld = first(ctx.slide.doc, P, "cSld");
  const name = cSld?.getAttribute("name") || `Slide ${index + 1}`;
  const background = slideBackground(ctx);
  const components: SlideComponent[] = [];

  // Master and layout decoration first (bottom of the z-order), then the
  // slide. Placeholders on master/layout are prompts, not content: skipped.
  const showMaster = first(ctx.slide.doc, P, "cSld")?.getAttribute("showMasterSp") !== "0";
  const layoutShowsMaster = ctx.layout ? first(ctx.layout.doc, P, "cSld")?.getAttribute("showMasterSp") !== "0" : true;
  if (showMaster && layoutShowsMaster) {
    const tree = first(ctx.master.doc, P, "spTree");
    if (tree) await walkTree(ctx, ctx.master, tree, components, null, true);
  }
  if (ctx.layout && showMaster) {
    const tree = first(ctx.layout.doc, P, "spTree");
    if (tree) await walkTree(ctx, ctx.layout, tree, components, null, true);
  }
  const spids = new Map<string, SlideComponent>();
  const tree = first(ctx.slide.doc, P, "spTree");
  if (tree) await walkTree(ctx, ctx.slide, tree, components, null, false, spids);

  applyAnimations(ctx, spids);
  return { id: uid("slide"), name, background, components };
}

function slideBackground(ctx: Ctx): string {
  for (const partDoc of [ctx.slide.doc, ctx.layout?.doc, ctx.master.doc]) {
    if (!partDoc) continue;
    const bg = first(partDoc, P, "bg");
    if (!bg) continue;
    const bgPr = first(bg, P, "bgPr");
    if (bgPr) {
      const fill = fillOf(ctx, bgPr);
      if (fill) return fill;
    }
    const ref = first(bg, P, "bgRef");
    if (ref) {
      const color = colorOf(ctx, ref);
      if (color) return color;
    }
  }
  return "#ffffff";
}

type GroupTransform = { x: number; y: number; sx: number; sy: number; chX: number; chY: number } | null;

async function walkTree(
  ctx: Ctx,
  owner: Part,
  tree: Element,
  out: SlideComponent[],
  group: GroupTransform,
  decoration: boolean,
  spids?: Map<string, SlideComponent>,
) {
  for (const node of children(tree)) {
    const tag = node.localName;
    let made: SlideComponent | SlideComponent[] | null = null;
    if (tag === "sp") {
      made = await shapeComponent(ctx, owner, node, group, decoration);
    } else if (tag === "pic") {
      made = await pictureComponent(ctx, owner, node, group);
    } else if (tag === "grpSp") {
      const xfrm = first(first(node, P, "grpSpPr"), A, "xfrm");
      const inner = groupTransform(xfrm, group);
      await walkTree(ctx, owner, node, out, inner, decoration, spids);
    }
    if (made) {
      const layers = Array.isArray(made) ? made : [made];
      out.push(...layers);
      const spid = all(node, P, "cNvPr")[0]?.getAttribute("id");
      // Animations target the shape; for shape + text, the text layer carries it
      // (the frame is animated too, see applyAnimations).
      if (spid && spids) for (const layer of layers) spids.set(layers.length > 1 && layer === layers[0] ? `${spid}#frame` : spid, layer);
    }
    // graphicFrame (tables, charts, SmartArt) and cxnSp (connectors): skipped.
  }
}

function groupTransform(xfrm: Element | null, parent: GroupTransform): GroupTransform {
  if (!xfrm) return parent;
  const off = first(xfrm, A, "off");
  const ext = first(xfrm, A, "ext");
  const chOff = first(xfrm, A, "chOff");
  const chExt = first(xfrm, A, "chExt");
  const x = Number(off?.getAttribute("x")) || 0;
  const y = Number(off?.getAttribute("y")) || 0;
  const w = Number(ext?.getAttribute("cx")) || 0;
  const h = Number(ext?.getAttribute("cy")) || 0;
  const cw = Number(chExt?.getAttribute("cx")) || w || 1;
  const chh = Number(chExt?.getAttribute("cy")) || h || 1;
  const own = { x, y, sx: w / cw, sy: h / chh, chX: Number(chOff?.getAttribute("x")) || 0, chY: Number(chOff?.getAttribute("y")) || 0 };
  if (!parent) return own;
  // Compose: child coords → own group space → parent space.
  return {
    x: parent.x + (own.x - parent.chX) * parent.sx,
    y: parent.y + (own.y - parent.chY) * parent.sy,
    sx: own.sx * parent.sx,
    sy: own.sy * parent.sy,
    chX: own.chX,
    chY: own.chY,
  };
}

type Box = { x: number; y: number; width: number; height: number };

function boxOf(ctx: Ctx, xfrm: Element | null, group: GroupTransform): Box | null {
  const off = first(xfrm, A, "off");
  const ext = first(xfrm, A, "ext");
  if (!off || !ext) return null;
  let x = Number(off.getAttribute("x")) || 0;
  let y = Number(off.getAttribute("y")) || 0;
  let w = Number(ext.getAttribute("cx")) || 0;
  let h = Number(ext.getAttribute("cy")) || 0;
  if (group) {
    x = group.x + (x - group.chX) * group.sx;
    y = group.y + (y - group.chY) * group.sy;
    w *= group.sx;
    h *= group.sy;
  }
  const k = ctx.scale / EMU_PER_PX;
  return { x: ctx.offsetX + x * k, y: ctx.offsetY + y * k, width: w * k, height: h * k };
}

// ---- placeholders -----------------------------------------------------------

function placeholder(sp: Element): { type: string; idx: string } | null {
  const ph = first(first(first(sp, P, "nvSpPr"), P, "nvPr"), P, "ph");
  if (!ph) return null;
  return { type: ph.getAttribute("type") || "body", idx: ph.getAttribute("idx") || "" };
}

/** Same placeholder on layout then master: by idx, then by (compatible) type. */
function inheritedShapes(ctx: Ctx, owner: Part, ph: { type: string; idx: string }): Element[] {
  const found: Element[] = [];
  const index = ctx.chain.indexOf(owner);
  const ancestors = ctx.chain.slice(0, index < 0 ? ctx.chain.length - 1 : index).reverse();
  for (const ancestor of ancestors) {
    const shapes = all(ancestor.doc, P, "sp").filter((sp) => placeholder(sp));
    let match = ph.idx ? shapes.find((sp) => placeholder(sp)!.idx === ph.idx) : undefined;
    if (!match) {
      const kinds = compatibleTypes(ph.type);
      match = shapes.find((sp) => kinds.includes(placeholder(sp)!.type));
    }
    if (match) found.push(match);
  }
  return found;
}

function compatibleTypes(type: string): string[] {
  if (type === "ctrTitle" || type === "title") return ["title", "ctrTitle"];
  if (type === "subTitle" || type === "body" || type === "obj") return ["body", "subTitle", "obj"];
  return [type];
}

// ---- shapes -----------------------------------------------------------------

async function shapeComponent(ctx: Ctx, owner: Part, sp: Element, group: GroupTransform, decoration: boolean): Promise<SlideComponent | SlideComponent[] | null> {
  const ph = placeholder(sp);
  // Date/footer/slide-number placeholders on layouts only show when the
  // slide opts in; and prompts on master/layout never render.
  if (decoration && ph) return null;
  const inherited = ph ? inheritedShapes(ctx, owner, ph) : [];
  const spPr = first(sp, P, "spPr");
  let box = boxOf(ctx, first(spPr, A, "xfrm"), group);
  for (const parent of inherited) {
    if (box) break;
    box = boxOf(ctx, first(first(parent, P, "spPr"), A, "xfrm"), null);
  }
  if (!box || box.width <= 0 || box.height <= 0) return null;

  const txBody = first(sp, P, "txBody");
  const text = txBody ? textOf(ctx, txBody, [sp, ...inherited], ph) : null;
  const name = first(first(sp, P, "nvSpPr"), P, "cNvPr")?.getAttribute("name") || "Shape";

  // Fill and line: own, then inherited placeholder, then style refs.
  let fill: string | null = null;
  let line: string | null = null;
  let geom = first(spPr, A, "prstGeom")?.getAttribute("prst") ?? (first(spPr, A, "custGeom") ? "custom" : "rect");
  for (const el of [sp, ...inherited]) {
    const pr = first(el, P, "spPr");
    if (!pr) continue;
    if (fill == null) fill = fillOf(ctx, pr, true);
    if (line == null) line = lineOf(ctx, pr);
    if (!first(spPr, A, "prstGeom")) geom = first(pr, A, "prstGeom")?.getAttribute("prst") ?? geom;
  }
  const style = first(sp, P, "style");
  if (fill == null && style) {
    const ref = first(style, A, "fillRef");
    if (ref && Number(ref.getAttribute("idx")) > 0) fill = colorOf(ctx, ref);
  }
  if (line == null && style) {
    const ref = first(style, A, "lnRef");
    if (ref && Number(ref.getAttribute("idx")) > 0) {
      const color = colorOf(ctx, ref);
      if (color) line = `1px solid ${color}`;
    }
  }
  const radius = cornerRadius(geom, spPr, box);

  if (text?.text) {
    // The deck model anchors text at the top. For middle/bottom anchored
    // text, shrink the frame to the text's estimated height on that side.
    const textBox = text.anchor === "t" ? box : anchoredBox(box, text);
    const layer: SlideComponent = {
      id: uid("text"),
      type: "text",
      name: layerName(text.text) || name,
      ...textBox,
      opacity: 1,
      text: text.text,
      fontSize: text.fontSize,
      fontWeight: text.bold ? 700 : 400,
      fontFamily: text.fontFamily,
      color: text.color,
      textAlign: text.align,
      lineHeight: text.lineHeight,
      letterSpacing: text.letterSpacing || undefined,
      padding: text.padding,
    };
    // Text with its own fill/border stays one layer when the frame is kept;
    // an anchored text inside a filled shape becomes shape + text.
    if (!fill && !line) return layer;
    if (textBox === box) return { ...layer, background: fill ?? undefined, border: line ?? undefined, borderRadius: radius || undefined };
    return [
      { id: uid("container"), type: "container", name, ...box, opacity: 1, background: fill ?? undefined, border: line ?? undefined, borderRadius: radius || undefined },
      layer,
    ];
  }
  if (ph && !fill && !line) return null; // empty placeholder: PowerPoint hides it
  if (!fill && !line) return null;
  return {
    id: uid("container"),
    type: "container",
    name,
    ...box,
    opacity: 1,
    background: fill ?? undefined,
    border: line ?? undefined,
    borderRadius: radius || undefined,
  };
}

/** Estimate the rendered text height and pin the frame to the anchored side. */
function anchoredBox(box: Box, text: TextInfo): Box {
  const inner = Math.max(1, box.width - 2 * text.padding);
  const lines = text.text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil((line.length * text.fontSize * 0.52) / inner)), 0);
  const height = Math.min(box.height, Math.round(lines * text.fontSize * text.lineHeight + 2 * text.padding));
  const y = text.anchor === "ctr" ? box.y + (box.height - height) / 2 : box.y + box.height - height;
  return { ...box, y: round(y), height };
}

function cornerRadius(geom: string, spPr: Element | null, box: Box): number {
  if (geom === "ellipse") return Math.min(box.width, box.height) / 2;
  if (geom !== "roundRect") return 0;
  const adj = first(first(spPr, A, "prstGeom"), A, "gd")?.getAttribute("fmla")?.match(/val\s+(\d+)/)?.[1];
  const fraction = adj ? Number(adj) / 100000 : 0.16667;
  return Math.round(Math.min(box.width, box.height) * fraction);
}

function layerName(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  return flat.length > 28 ? `${flat.slice(0, 27)}…` : flat;
}

// ---- text -------------------------------------------------------------------

type TextInfo = {
  text: string;
  fontSize: number;
  bold: boolean;
  fontFamily: string;
  color: string;
  align: TextAlign;
  lineHeight: number;
  letterSpacing: number;
  padding: number;
  anchor: "t" | "ctr" | "b";
};

function textOf(ctx: Ctx, txBody: Element, sources: Element[], ph: { type: string; idx: string } | null): TextInfo | null {
  const paragraphs = all(txBody, A, "p");
  if (!paragraphs.length) return null;
  const bodyPr = first(txBody, A, "bodyPr");
  const lIns = emuAttr(bodyPr, "lIns", 91440);
  const tIns = emuAttr(bodyPr, "tIns", 45720);
  const padding = Math.round(Math.min(lIns, tIns) * (ctx.scale / EMU_PER_PX));
  const anchorAttr = [txBody, ...sources.slice(1).map((sp) => first(sp, P, "txBody"))]
    .map((body) => first(body, A, "bodyPr")?.getAttribute("anchor"))
    .find(Boolean);
  const anchor: TextInfo["anchor"] = anchorAttr === "ctr" ? "ctr" : anchorAttr === "b" ? "b" : "t";

  // Style hierarchy for runs and paragraphs: own lstStyle, inherited
  // placeholders' lstStyles, master txStyles for the placeholder's family.
  const lstStyles = sources.map((sp) => first(first(sp, P, "txBody"), A, "lstStyle")).filter(Boolean) as Element[];
  const masterStyles = first(ctx.master.doc, P, "txStyles");
  const family = !ph ? "otherStyle" : ph.type === "title" || ph.type === "ctrTitle" ? "titleStyle" : ph.type === "body" || ph.type === "subTitle" || ph.type === "obj" ? "bodyStyle" : "otherStyle";
  const masterStyle = first(masterStyles, P, family);
  const defaultStyle = first(masterStyles, P, "otherStyle");

  const lines: string[] = [];
  let firstRun: Element | null = null;
  let firstPara: Element | null = null;
  for (const p of paragraphs) {
    const lvl = Number(first(p, A, "pPr")?.getAttribute("lvl")) || 0;
    const runs = children(p).filter((n) => n.localName === "r" || n.localName === "fld" || n.localName === "br");
    let line = "";
    for (const run of runs) {
      if (run.localName === "br") {
        line += "\n";
        continue;
      }
      let t = first(run, A, "t")?.textContent ?? "";
      const rPr = first(run, A, "rPr");
      const cap = lookup(rPr, [p], lstStyles, masterStyle, defaultStyle, lvl, (el) => el.getAttribute("cap"));
      if (cap === "all") t = t.toUpperCase();
      if (t && !firstRun) {
        firstRun = run;
        firstPara = p;
      }
      line += t;
    }
    if (line.trim()) {
      const bullet = bulletOf(p, lstStyles, masterStyle, lvl);
      line = bullet ? `${bullet} ${line.trimStart()}` : line;
    }
    lines.push(line);
  }
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return null;

  const p = firstPara ?? paragraphs[0]!;
  const lvl = Number(first(p, A, "pPr")?.getAttribute("lvl")) || 0;
  const rPr = firstRun ? first(firstRun, A, "rPr") : first(first(p, A, "pPr"), A, "defRPr");
  const get = (fn: (el: Element) => string | null | undefined) => lookup(rPr, [p], lstStyles, masterStyle, defaultStyle, lvl, fn);
  const sz = Number(get((el) => el.getAttribute("sz"))) || 1800;
  const fontSize = round((sz / 100) * 2 * ctx.scale);
  const bold = get((el) => el.getAttribute("b")) === "1";
  const latin = get((el) => first(el, A, "latin")?.getAttribute("typeface"));
  const fontFamily = `${JSON.stringify(resolveFont(ctx, latin ?? "+mn-lt"))}, sans-serif`;
  const colorEl = get((el) => (first(el, A, "solidFill") ? "x" : null));
  let color = "#111111";
  if (colorEl) {
    const owner = lookupEl(rPr, [p], lstStyles, masterStyle, defaultStyle, lvl, (el) => Boolean(first(el, A, "solidFill")));
    color = (owner && colorOf(ctx, first(owner, A, "solidFill"))) || color;
  } else {
    color = schemeColor(ctx, "tx1") ?? color;
  }
  const spc = Number(get((el) => el.getAttribute("spc"))) || 0;
  const letterSpacing = round((spc / 100) * 2 * ctx.scale);
  const algn = lookupPara([p], lstStyles, masterStyle, defaultStyle, lvl, (el) => el.getAttribute("algn"));
  const align: TextAlign = algn === "ctr" ? "center" : algn === "r" ? "right" : "left";
  const spcPct = lookupPara([p], lstStyles, masterStyle, defaultStyle, lvl, (el) => first(first(el, A, "lnSpc"), A, "spcPct")?.getAttribute("val"));
  const spcPts = lookupPara([p], lstStyles, masterStyle, defaultStyle, lvl, (el) => first(first(el, A, "lnSpc"), A, "spcPts")?.getAttribute("val"));
  const lineHeight = spcPct ? round((Number(spcPct) / 100000) * 1.2) : spcPts ? round(((Number(spcPts) / 100) * 2 * ctx.scale) / fontSize) : 1.2;

  return { text, fontSize, bold, fontFamily, color, align, lineHeight, letterSpacing, padding, anchor };
}

function bulletOf(p: Element, lstStyles: Element[], masterStyle: Element | null, lvl: number): string {
  const pPrs = [first(p, A, "pPr"), ...lstStyles.map((l) => first(l, A, `lvl${lvl + 1}pPr`)), first(masterStyle, A, `lvl${lvl + 1}pPr`)];
  for (const pPr of pPrs) {
    if (!pPr) continue;
    if (first(pPr, A, "buNone")) return "";
    const ch = first(pPr, A, "buChar")?.getAttribute("char");
    if (ch) return ch;
    if (first(pPr, A, "buAutoNum")) return "•";
  }
  return "";
}

/** Run property lookup: run → paragraph defRPr → lstStyle lvl → master style lvl → otherStyle. */
function lookup(
  rPr: Element | null,
  paras: Element[],
  lstStyles: Element[],
  masterStyle: Element | null,
  defaultStyle: Element | null,
  lvl: number,
  fn: (el: Element) => string | null | undefined,
): string | null {
  const el = lookupEl(rPr, paras, lstStyles, masterStyle, defaultStyle, lvl, (e) => Boolean(fn(e)));
  return el ? (fn(el) ?? null) : null;
}

function lookupEl(
  rPr: Element | null,
  paras: Element[],
  lstStyles: Element[],
  masterStyle: Element | null,
  defaultStyle: Element | null,
  lvl: number,
  has: (el: Element) => boolean,
): Element | null {
  const candidates: Array<Element | null> = [rPr];
  for (const p of paras) candidates.push(first(first(p, A, "pPr"), A, "defRPr"));
  for (const l of lstStyles) candidates.push(first(first(l, A, `lvl${lvl + 1}pPr`), A, "defRPr"));
  candidates.push(first(first(masterStyle, A, `lvl${lvl + 1}pPr`), A, "defRPr"));
  candidates.push(first(first(defaultStyle, A, "lvl1pPr"), A, "defRPr"));
  for (const c of candidates) if (c && has(c)) return c;
  return null;
}

function lookupPara(
  paras: Element[],
  lstStyles: Element[],
  masterStyle: Element | null,
  defaultStyle: Element | null,
  lvl: number,
  fn: (el: Element) => string | null | undefined,
): string | null {
  const candidates: Array<Element | null> = [];
  for (const p of paras) candidates.push(first(p, A, "pPr"));
  for (const l of lstStyles) candidates.push(first(l, A, `lvl${lvl + 1}pPr`));
  candidates.push(first(masterStyle, A, `lvl${lvl + 1}pPr`), first(defaultStyle, A, "lvl1pPr"));
  for (const c of candidates) {
    const v = c && fn(c);
    if (v) return v;
  }
  return null;
}

function resolveFont(ctx: Ctx, typeface: string): string {
  if (typeface.startsWith("+mj")) return ctx.theme.major;
  if (typeface.startsWith("+mn")) return ctx.theme.minor;
  return typeface;
}

// ---- pictures ---------------------------------------------------------------

async function pictureComponent(ctx: Ctx, owner: Part, pic: Element, group: GroupTransform): Promise<SlideComponent | null> {
  const box = boxOf(ctx, first(first(pic, P, "spPr"), A, "xfrm"), group);
  if (!box || box.width <= 0 || box.height <= 0) return null;
  const blip = first(first(pic, P, "blipFill"), A, "blip");
  const rid = blip?.getAttributeNS(R, "embed") ?? "";
  const rel = owner.rels.get(rid);
  if (!rel) return null;
  const src = await mediaDataUri(ctx, resolve(owner.path, rel.target));
  if (!src) return null;
  const name = first(first(pic, P, "nvPicPr"), P, "cNvPr")?.getAttribute("name") || "Image";
  const cropped = Boolean(first(first(pic, P, "blipFill"), A, "srcRect"));
  const spPr = first(pic, P, "spPr");
  const geom = first(spPr, A, "prstGeom")?.getAttribute("prst") ?? "rect";
  const alpha = first(blip, A, "alphaModFix")?.getAttribute("amt");
  return {
    id: uid("image"),
    type: "image",
    name,
    ...box,
    opacity: alpha ? Number(alpha) / 100000 : 1,
    src,
    objectFit: cropped ? "cover" : "fill",
    borderRadius: cornerRadius(geom, spPr, box) || undefined,
    border: lineOf(ctx, spPr) ?? undefined,
  };
}

function mediaDataUri(ctx: Ctx, path: string): Promise<string | null> {
  let pending = ctx.media.get(path);
  if (!pending) {
    pending = (async () => {
      const file = ctx.zip.file(path);
      if (!file) return null;
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      const mime: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", bmp: "image/bmp" };
      if (!mime[ext]) return null; // emf/wmf/tiff: browsers cannot show them
      const bytes = await file.async("uint8array");
      return `data:${mime[ext]};base64,${Buffer.from(bytes).toString("base64")}`;
    })();
    ctx.media.set(path, pending);
  }
  return pending;
}

// ---- fills, lines, colours --------------------------------------------------

function fillOf(ctx: Ctx, pr: Element, allowNone = false): string | null {
  for (const node of children(pr)) {
    switch (node.localName) {
      case "noFill":
        return allowNone ? null : null;
      case "solidFill":
        return colorOf(ctx, node);
      case "gradFill": {
        const stops = all(first(node, A, "gsLst"), A, "gs")
          .map((gs) => ({ pos: Number(gs.getAttribute("pos")) / 1000, color: colorOf(ctx, gs) }))
          .filter((s) => s.color);
        if (stops.length < 2) return stops[0]?.color ?? null;
        const ang = Number(first(node, A, "lin")?.getAttribute("ang")) / 60000 || 0;
        return `linear-gradient(${Math.round(ang + 90)}deg, ${stops.map((s) => `${s.color} ${Math.round(s.pos)}%`).join(", ")})`;
      }
      case "blipFill":
        return null; // picture fills on shapes: not carried
    }
  }
  return null;
}

function lineOf(ctx: Ctx, pr: Element | null): string | null {
  const ln = first(pr, A, "ln");
  if (!ln) return null;
  if (first(ln, A, "noFill")) return null;
  const fill = first(ln, A, "solidFill");
  if (!fill) return null;
  const color = colorOf(ctx, fill);
  if (!color) return null;
  const w = Math.max(1, round((Number(ln.getAttribute("w")) || 9525) / EMU_PER_PX * ctx.scale));
  const dash = first(ln, A, "prstDash")?.getAttribute("val") ?? "";
  const style = /dash/i.test(dash) ? "dashed" : /dot/i.test(dash) ? "dotted" : "solid";
  return `${w}px ${style} ${color}`;
}

/** Colour of the first colour child (srgbClr, schemeClr, sysClr, prstClr) with its modifiers. */
function colorOf(ctx: Ctx, parent: Element | null): string | null {
  if (!parent) return null;
  for (const node of children(parent)) {
    let hex: string | null = null;
    switch (node.localName) {
      case "srgbClr":
        hex = node.getAttribute("val");
        break;
      case "schemeClr":
        hex = schemeColor(ctx, node.getAttribute("val") ?? "");
        break;
      case "sysClr":
        hex = node.getAttribute("lastClr") ?? (node.getAttribute("val") === "window" ? "FFFFFF" : "000000");
        break;
      case "prstClr":
        hex = PRESET_COLORS[node.getAttribute("val") ?? ""] ?? null;
        break;
      default:
        continue;
    }
    if (!hex) return null;
    return applyModifiers(hex, node);
  }
  return null;
}

function schemeColor(ctx: Ctx, name: string): string | null {
  const mapped = ctx.clrMap.get(name) ?? name;
  const hex = ctx.theme.colors.get(mapped) ?? ctx.theme.colors.get(name);
  return hex ? `#${hex.toLowerCase()}` : null;
}

function applyModifiers(hexIn: string, node: Element): string {
  const hex = hexIn.replace("#", "");
  let [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  let alpha = 1;
  for (const mod of children(node)) {
    const v = Number(mod.getAttribute("val")) / 100000;
    switch (mod.localName) {
      case "alpha":
        alpha = v;
        break;
      case "tint":
        [r, g, b] = [r, g, b].map((c) => 1 - (1 - c) * v) as [number, number, number];
        break;
      case "shade":
        [r, g, b] = [r, g, b].map((c) => c * v) as [number, number, number];
        break;
      case "lumMod":
      case "lumOff": {
        const [h, s, l] = rgbToHsl(r, g, b);
        const l2 = mod.localName === "lumMod" ? l * v : l + v;
        [r, g, b] = hslToRgb(h, s, Math.max(0, Math.min(1, l2)));
        break;
      }
    }
  }
  const to = (c: number) => Math.round(Math.max(0, Math.min(1, c)) * 255);
  if (alpha < 1) return `rgba(${to(r)}, ${to(g)}, ${to(b)}, ${Math.round(alpha * 100) / 100})`;
  return `#${[r, g, b].map((c) => to(c).toString(16).padStart(2, "0")).join("")}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

const PRESET_COLORS: Record<string, string> = { white: "FFFFFF", black: "000000", red: "FF0000", blue: "0000FF", green: "008000", gray: "808080", grey: "808080", yellow: "FFFF00", orange: "FFA500" };

// ---- theme ------------------------------------------------------------------

function parseTheme(doc: Document): Theme {
  const colors = new Map<string, string>();
  const scheme = first(doc, A, "clrScheme");
  for (const node of children(scheme)) {
    const inner = children(node)[0];
    const hex = inner?.localName === "srgbClr" ? inner.getAttribute("val") : inner?.localName === "sysClr" ? inner.getAttribute("lastClr") : null;
    if (hex) colors.set(node.localName, hex);
  }
  const fonts = first(doc, A, "fontScheme");
  const major = first(first(fonts, A, "majorFont"), A, "latin")?.getAttribute("typeface") || "Calibri Light";
  const minor = first(first(fonts, A, "minorFont"), A, "latin")?.getAttribute("typeface") || "Calibri";
  return { colors, major, minor };
}

function defaultTheme(): Theme {
  return {
    colors: new Map([["dk1", "000000"], ["lt1", "FFFFFF"], ["dk2", "44546A"], ["lt2", "E7E6E6"], ["accent1", "4472C4"], ["accent2", "ED7D31"], ["accent3", "A5A5A5"], ["accent4", "FFC000"], ["accent5", "5B9BD5"], ["accent6", "70AD47"], ["hlink", "0563C1"], ["folHlink", "954F72"]]),
    major: "Calibri Light",
    minor: "Calibri",
  };
}

function parseClrMap(master: Document, layout?: Document, slide?: Document): Map<string, string> {
  const map = new Map<string, string>();
  const base = first(master, P, "clrMap");
  if (base) for (const attr of Array.from(base.attributes)) map.set(attr.name, attr.value);
  // Overrides on layout/slide (clrMapOvr/overrideClrMapping).
  for (const doc of [layout, slide]) {
    const ovr = doc ? first(first(doc, P, "clrMapOvr"), A, "overrideClrMapping") : null;
    if (ovr) for (const attr of Array.from(ovr.attributes)) map.set(attr.name, attr.value);
  }
  return map;
}

// ---- animations -------------------------------------------------------------

const PRESET_EFFECTS: Record<number, (subtype: number) => AnimationEffect> = {
  10: () => "fade",
  42: (s) => (s === 1 ? "fade-down" : "fade-up"), // Float In
  2: (s) => (s === 2 ? "fade-left" : s === 8 ? "fade-right" : s === 1 ? "fade-down" : "fade-up"), // Fly In
  53: () => "scale", // Zoom
  23: () => "scale", // Grow & Turn
  26: () => "scale", // Basic Zoom
  22: (s) => (s === 2 ? "fade-left" : s === 8 ? "fade-right" : s === 1 ? "fade-down" : "fade-up"), // Wipe
  13: () => "fade-up", // Rise Up
};

/**
 * Main sequence → per-layer entrance. Each top-level group is one click
 * unless it starts with the slide (first group, `withEffect`/`afterEffect`).
 */
function applyAnimations(ctx: Ctx, bySpid: Map<string, SlideComponent>) {
  const timing = first(ctx.slide.doc, P, "timing");
  if (!timing || !bySpid.size) return;

  const mainSeq = all(timing, P, "cTn").find((el) => el.getAttribute("nodeType") === "mainSeq");
  if (!mainSeq) return;
  const groups = children(first(mainSeq, P, "childTnLst")).filter((el) => el.localName === "par");
  let click = 0;
  groups.forEach((group, groupIndex) => {
    const effects = all(group, P, "cTn").filter((el) => el.getAttribute("presetClass") === "entr");
    if (!effects.length) return;
    const startsOnClick = effects.some((el) => el.getAttribute("nodeType") === "clickEffect") || groupIndex > 0;
    const step = startsOnClick ? ++click : undefined;
    let elapsed = 0;
    for (const cTn of effects) {
      const spid = all(cTn, P, "spTgt")[0]?.getAttribute("spid") ?? "";
      const component = bySpid.get(spid);
      if (!component) continue;
      const presetId = Number(cTn.getAttribute("presetID")) || 10;
      const subtype = Number(cTn.getAttribute("presetSubtype")) || 0;
      const effect = (PRESET_EFFECTS[presetId] ?? (() => "fade"))(subtype);
      const ownDelay = Number(first(first(cTn, P, "stCondLst"), P, "cond")?.getAttribute("delay")) || 0;
      const duration = Math.max(
        ...all(cTn, P, "cTn")
          .map((el) => Number(el.getAttribute("dur")))
          .filter((n) => Number.isFinite(n) && n > 1),
        0,
      ) || 500;
      const after = cTn.getAttribute("nodeType") === "afterEffect";
      const delay = after ? elapsed + ownDelay : ownDelay;
      elapsed = Math.max(elapsed, delay + duration);
      const animation: LayerAnimation = { effect, delay: Math.round(delay), duration: Math.round(duration), step };
      component.animation = animation;
      const frame = bySpid.get(`${spid}#frame`);
      if (frame) frame.animation = { ...animation };
    }
  });
}

// ---- package plumbing -------------------------------------------------------

async function part(zip: JSZip, path: string): Promise<Part | null> {
  const file = zip.file(path);
  if (!file) return null;
  const xml = await file.async("string");
  const doc = new DOMParser().parseFromString(xml, "application/xml") as unknown as Document;
  const relPath = path.replace(/([^/]+)$/, "_rels/$1.rels");
  const rels = new Map<string, Rel>();
  const relFile = zip.file(relPath);
  if (relFile) {
    const relDoc = new DOMParser().parseFromString(await relFile.async("string"), "application/xml") as unknown as Document;
    for (const rel of Array.from(relDoc.getElementsByTagName("Relationship"))) {
      rels.set(rel.getAttribute("Id") ?? "", { id: rel.getAttribute("Id") ?? "", type: rel.getAttribute("Type") ?? "", target: rel.getAttribute("Target") ?? "" });
    }
  }
  return { doc, path, rels };
}

function resolve(fromPath: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = fromPath.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

async function title(zip: JSZip, fallback: string): Promise<string> {
  const core = zip.file("docProps/core.xml");
  if (!core) return fallback;
  const text = (await core.async("string")).match(/<dc:title>([^<]*)<\/dc:title>/)?.[1];
  const decoded = text?.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').trim();
  return decoded || fallback;
}

function first(parent: Node | null | undefined, ns: string, name: string): Element | null {
  if (!parent) return null;
  // On a document, find the first such element anywhere; on an element, only direct children.
  if (parent.nodeType === 9) return all(parent, ns, name)[0] ?? null;
  for (const node of children(parent)) if (node.localName === name && node.namespaceURI === ns) return node;
  return null;
}

function all(parent: Node | null | undefined, ns: string, name: string): Element[] {
  if (!parent) return [];
  const el = parent as Element | Document;
  return Array.from(el.getElementsByTagNameNS(ns, name));
}

function children(parent: Node | null | undefined): Element[] {
  if (!parent) return [];
  return Array.from(parent.childNodes).filter((n): n is Element => n.nodeType === 1);
}

function emuAttr(el: Element | null, name: string, fallback: number): number {
  const v = el?.getAttribute(name);
  return v == null || v === "" ? fallback : Number(v);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
