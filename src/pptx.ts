import { createHash } from "node:crypto";
import JSZip from "jszip";
import type { Deck, LayerAnimation, Slide, SlideComponent } from "./types.ts";
import { SLIDE_HEIGHT, SLIDE_WIDTH } from "./types.ts";

/**
 * Deck → .pptx, written as Office Open XML directly.
 *
 * The deck model is already PowerPoint's model: absolutely positioned text
 * boxes, pictures and rectangles per slide. So every layer becomes a native
 * shape (editable in PowerPoint), and the six entrance effects become a
 * `<p:timing>` tree with the same delays, durations and click steps.
 *
 * Units: the 1920×1080 canvas maps to a 13.333×7.5 in slide, so
 * 1 px = 6350 EMU and 1 px of font size = 0.5 pt.
 */

const EMU_PER_PX = 6350;
const SLIDE_CX = SLIDE_WIDTH * EMU_PER_PX; // 12192000
const SLIDE_CY = SLIDE_HEIGHT * EMU_PER_PX; // 6858000
const PT_PER_PX = 0.5;

const NS = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
};
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT = {
  slide: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
  layout: "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
  master: "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
  theme: "application/vnd.openxmlformats-officedocument.theme+xml",
  presentation: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  presProps: "application/vnd.openxmlformats-officedocument.presentationml.presProps+xml",
  core: "application/vnd.openxmlformats-package.core-properties+xml",
  app: "application/vnd.openxmlformats-officedocument.extended-properties+xml",
};
export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

type Media = { name: string; bytes: Uint8Array; width: number; height: number };

type Options = {
  /** Fetch an http(s) image. Default: global fetch with an 8 s timeout. */
  fetchImage?: (url: string) => Promise<Uint8Array | null>;
  /** Rasterise an SVG to PNG at roughly the given pixel width. Default: resvg. */
  rasterizeSvg?: (svg: string, widthPx: number) => Promise<Uint8Array | null>;
};

export async function deckToPptx(deck: Deck, options: Options = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  const media = new MediaStore(zip, options);
  const slideXml: string[] = [];
  for (const [index, slide] of deck.slides.entries()) {
    slideXml.push(await renderSlide(slide, index, media, zip));
  }

  const slideRels = deck.slides.map((_, i) => `<Relationship Id="rId${i + 2}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`);
  const slideIds = deck.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`);

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Default Extension="gif" ContentType="image/gif"/>
<Override PartName="/ppt/presentation.xml" ContentType="${CT.presentation}"/>
<Override PartName="/ppt/presProps.xml" ContentType="${CT.presProps}"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT.master}"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT.layout}"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="${CT.theme}"/>
${deck.slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${CT.slide}"/>`).join("\n")}
<Override PartName="/docProps/core.xml" ContentType="${CT.core}"/>
<Override PartName="/docProps/app.xml" ContentType="${CT.app}"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
  );
  const now = new Date().toISOString();
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(deck.title)}</dc:title><dc:creator>Langdock slide canvas</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`,
  );
  zip.file(
    "docProps/app.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Langdock slide canvas</Application><Slides>${deck.slides.length}</Slides></Properties>`,
  );
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}" saveSubsetFonts="1">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>${slideIds.join("")}</p:sldIdLst>
<p:sldSz cx="${SLIDE_CX}" cy="${SLIDE_CY}"/><p:notesSz cx="6858000" cy="9144000"/>
<p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle>
</p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>
${slideRels.join("\n")}
<Relationship Id="rId${deck.slides.length + 2}" Type="${REL}/theme" Target="theme/theme1.xml"/>
<Relationship Id="rId${deck.slides.length + 3}" Type="${REL}/presProps" Target="presProps.xml"/>
</Relationships>`,
  );
  zip.file(
    "ppt/presProps.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentationPr xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"/>`,
  );
  zip.file("ppt/slideMasters/slideMaster1.xml", MASTER_XML);
  zip.file(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
  );
  zip.file("ppt/slideLayouts/slideLayout1.xml", LAYOUT_XML);
  zip.file(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
  );
  zip.file("ppt/theme/theme1.xml", THEME_XML);
  slideXml.forEach((xml, i) => zip.file(`ppt/slides/slide${i + 1}.xml`, xml));

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: PPTX_MIME });
}

// ---- slides -----------------------------------------------------------------

type ShapeRef = { spid: number; kind: "sp" | "pic"; animation?: LayerAnimation };

async function renderSlide(slide: Slide, index: number, media: MediaStore, zip: JSZip): Promise<string> {
  const rels: string[] = [`<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`];
  let nextRel = 2;
  let nextId = 2;
  const shapes: string[] = [];
  const refs: ShapeRef[] = [];

  for (const component of slide.components) {
    const spid = nextId++;
    if (component.type === "image") {
      const image = await media.image(component);
      if (!image) continue;
      const rid = `rId${nextRel++}`;
      rels.push(`<Relationship Id="${rid}" Type="${REL}/image" Target="../media/${image.name}"/>`);
      shapes.push(picture(component, spid, rid, image));
      refs.push({ spid, kind: "pic", animation: component.animation });
      continue;
    }
    if (component.type === "html") continue; // never survives flattening; nothing to draw
    shapes.push(shape(component, spid));
    refs.push({ spid, kind: "sp", animation: component.animation });
  }

  zip.file(
    `ppt/slides/_rels/slide${index + 1}.xml.rels`,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`,
  );

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}">
<p:cSld name="${esc(slide.name)}">
${background(slide.background)}
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
${shapes.join("\n")}
</p:spTree>
</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
${timing(refs)}
</p:sld>`;
}

function background(css: string): string {
  const fill = fillXml(css, 1);
  if (!fill) return "";
  return `<p:bg><p:bgPr>${fill}<a:effectLst/></p:bgPr></p:bg>`;
}

function xfrm(c: { x: number; y: number; width: number; height: number }): string {
  return `<a:xfrm><a:off x="${emu(c.x)}" y="${emu(c.y)}"/><a:ext cx="${Math.max(1, emu(c.width))}" cy="${Math.max(1, emu(c.height))}"/></a:xfrm>`;
}

function geometry(c: SlideComponent): string {
  const radius = c.borderRadius ?? 0;
  if (radius <= 0) return `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`;
  // roundRect adj: radius as a fraction of the shorter side, in 1/100000.
  const adj = Math.round(Math.min(50000, (radius / Math.max(1, Math.min(c.width, c.height))) * 100000));
  return `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${adj}"/></a:avLst></a:prstGeom>`;
}

function shape(c: SlideComponent, spid: number): string {
  const fill = c.background ? fillXml(c.background, c.opacity) : null;
  const line = c.border ? lineXml(c.border, c.opacity) : null;
  const isText = c.type === "text";
  const frame = isText ? textFrame(c) : { x: c.x, y: c.y, width: c.width, height: c.height, wrap: true };
  return `<p:sp>
<p:nvSpPr><p:cNvPr id="${spid}" name="${esc(c.name || c.type)}"/><p:cNvSpPr txBox="${isText ? 1 : 0}"/><p:nvPr/></p:nvSpPr>
<p:spPr>${xfrm(frame)}${geometry(c)}${fill ?? "<a:noFill/>"}${line ?? "<a:ln><a:noFill/></a:ln>"}</p:spPr>
${isText ? textBody(c, frame.wrap) : `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody>`}
</p:sp>`;
}

/**
 * PowerPoint sets type a little wider than Chrome (different kerning, and a
 * substituted font when the webfont is missing), so a box that fit exactly
 * in the browser wraps its last word. Single lines therefore never wrap, and
 * wrapping boxes get slack on the side their alignment grows into, so the
 * visible text stays where it was.
 */
function textFrame(c: SlideComponent): { x: number; y: number; width: number; height: number; wrap: boolean } {
  const text = c.text ?? "";
  const lineHeight = (c.fontSize ?? 32) * (c.lineHeight ?? 1.25);
  const innerHeight = c.height - 2 * (c.padding ?? 0);
  const singleLine = !text.includes("\n") && innerHeight < lineHeight * 1.9;
  if (singleLine) {
    // No wrapping; keep the box so alignment (and any fill/border) stays put.
    return { x: c.x, y: c.y, width: c.width, height: c.height, wrap: false };
  }
  const slack = Math.max(12, c.width * 0.06);
  const align = c.textAlign as string | undefined;
  if (align === "center") return { x: c.x - slack / 2, y: c.y, width: c.width + slack, height: c.height, wrap: true };
  if (align === "right" || align === "end") return { x: c.x - slack, y: c.y, width: c.width + slack, height: c.height, wrap: true };
  return { x: c.x, y: c.y, width: c.width + slack, height: c.height, wrap: true };
}

function textBody(c: SlideComponent, wrap: boolean): string {
  const pad = emu(c.padding ?? 0);
  const size = Math.max(1, Math.round((c.fontSize ?? 32) * PT_PER_PX * 100));
  const color = parseColor(c.color ?? "#111827");
  const font = fontName(c.fontFamily);
  const align = alignXml(c.textAlign);
  // CSS line-height is a multiple of the font size; PowerPoint's percentage
  // is of "single" spacing, which is ~1.2× the font size for most fonts.
  const lineSpacing = c.lineHeight ? `<a:lnSpc><a:spcPct val="${Math.round((c.lineHeight / 1.2) * 100000)}"/></a:lnSpc>` : "";
  const spacing = c.letterSpacing ? ` spc="${Math.round(c.letterSpacing * PT_PER_PX * 100)}"` : "";
  const bold = (c.fontWeight ?? 400) >= 600 ? ` b="1"` : "";
  const rPr = `<a:rPr lang="en-US" sz="${size}"${bold}${spacing} dirty="0">${solidFill(color, c.opacity)}<a:latin typeface="${esc(font)}"/><a:cs typeface="${esc(font)}"/></a:rPr>`;
  const paragraphs = (c.text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `<a:p><a:pPr${align}>${lineSpacing}</a:pPr>${line ? `<a:r>${rPr}<a:t>${esc(line)}</a:t></a:r>` : ""}<a:endParaRPr lang="en-US" sz="${size}"/></a:p>`)
    .join("");
  return `<p:txBody><a:bodyPr wrap="${wrap ? "square" : "none"}" lIns="${pad}" tIns="${pad}" rIns="${pad}" bIns="${pad}" rtlCol="0" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody>`;
}

function alignXml(align: string | undefined): string {
  if (align === "center") return ` algn="ctr"`;
  if (align === "right" || align === "end") return ` algn="r"`;
  return "";
}

function picture(c: SlideComponent, spid: number, rid: string, image: Media): string {
  // contain: shrink the frame to the letterboxed image. cover: crop the source.
  const fit = c.objectFit ?? "cover";
  let frame = { x: c.x, y: c.y, width: c.width, height: c.height };
  let srcRect = "";
  if (image.width > 0 && image.height > 0 && fit !== "fill") {
    const boxRatio = c.width / c.height;
    const imgRatio = image.width / image.height;
    if (fit === "contain") {
      const w = imgRatio > boxRatio ? c.width : c.height * imgRatio;
      const h = imgRatio > boxRatio ? c.width / imgRatio : c.height;
      frame = { x: c.x + (c.width - w) / 2, y: c.y + (c.height - h) / 2, width: w, height: h };
    } else {
      // cover: keep the frame, crop the overflowing axis, in 1/1000 %.
      const crop = imgRatio > boxRatio ? (1 - boxRatio / imgRatio) / 2 : (1 - imgRatio / boxRatio) / 2;
      const pct = Math.round(crop * 100000);
      srcRect = imgRatio > boxRatio ? `<a:srcRect l="${pct}" r="${pct}"/>` : `<a:srcRect t="${pct}" b="${pct}"/>`;
    }
  }
  const alpha = c.opacity < 1 ? `<a:alphaModFix amt="${Math.round(c.opacity * 100000)}"/>` : "";
  const line = c.border ? lineXml(c.border, c.opacity) : `<a:ln><a:noFill/></a:ln>`;
  return `<p:pic>
<p:nvPicPr><p:cNvPr id="${spid}" name="${esc(c.name || "Image")}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="${rid}">${alpha}</a:blip>${srcRect}<a:stretch><a:fillRect/></a:stretch></p:blipFill>
<p:spPr>${xfrm(frame)}${geometry({ ...c, ...frame })}${line}</p:spPr>
</p:pic>`;
}

// ---- animations -------------------------------------------------------------

/**
 * One `<p:par>` per click group in the main sequence: group 0 (no step) runs
 * when the slide appears, group n on the n-th click. Inside a group each
 * layer is its own effect with the deck's delay and duration.
 */
function timing(refs: ShapeRef[]): string {
  const animated = refs.filter((ref) => ref.animation);
  if (!animated.length) return "";
  const groups = new Map<number, ShapeRef[]>();
  for (const ref of animated) {
    const step = ref.animation!.step ?? 0;
    if (!groups.has(step)) groups.set(step, []);
    groups.get(step)!.push(ref);
  }
  let id = 3; // 1 = root, 2 = main sequence
  const groupXml = [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([step, members]) => {
      const start =
        step === 0
          ? `<p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst>`
          : `<p:stCondLst><p:cond delay="indefinite"/></p:stCondLst>`;
      const effects = members
        .map((ref, i) => {
          const node = step === 0 ? "withEffect" : i === 0 ? "clickEffect" : "withEffect";
          const xml = effect(ref, id, node);
          id = xml.nextId;
          return xml.xml;
        })
        .join("");
      const outer = id++;
      const inner = id++;
      return `<p:par><p:cTn id="${outer}" fill="hold">${start}<p:childTnLst><p:par><p:cTn id="${inner}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${effects}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`;
    })
    .join("");
  const builds = animated
    .filter((ref) => ref.kind === "sp")
    .map((ref) => `<p:bldP spid="${ref.spid}" grpId="0" animBg="1"/>`)
    .join("");
  return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>
<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${groupXml}</p:childTnLst></p:cTn>
<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>
<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>
</p:childTnLst></p:cTn></p:par></p:tnLst>${builds ? `<p:bldLst>${builds}</p:bldLst>` : ""}</p:timing>`;
}

/** PowerPoint preset ids, so the animation pane labels the effect sensibly. */
const PRESETS: Record<LayerAnimation["effect"], { id: number; subtype: number }> = {
  fade: { id: 10, subtype: 0 },
  "fade-up": { id: 42, subtype: 4 }, // Float In, from bottom
  "fade-down": { id: 42, subtype: 1 }, // Float In, from top
  "fade-left": { id: 2, subtype: 2 }, // Fly In, from right (moves left)
  "fade-right": { id: 2, subtype: 8 }, // Fly In, from left (moves right)
  scale: { id: 53, subtype: 16 }, // Zoom in
};
/** How far the fade-* effects travel, as a fraction of the slide (≈24 px). */
const SLIDE_OFFSET = 24 / SLIDE_HEIGHT;

function effect(ref: ShapeRef, firstId: number, nodeType: string): { xml: string; nextId: number } {
  const anim = ref.animation!;
  const preset = PRESETS[anim.effect] ?? PRESETS.fade;
  const dur = Math.max(1, Math.round(anim.duration));
  const delay = Math.max(0, Math.round(anim.delay));
  let id = firstId;
  const target = `<p:tgtEl><p:spTgt spid="${ref.spid}"/></p:tgtEl>`;
  const parts: string[] = [];
  // Make it visible, then the effect.
  parts.push(
    `<p:set><p:cBhvr><p:cTn id="${id++}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>${target}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>`,
  );
  parts.push(`<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="${id++}" dur="${dur}"/>${target}</p:cBhvr></p:animEffect>`);
  const move = (attr: "ppt_x" | "ppt_y", fromExpr: string) =>
    `<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="${id++}" dur="${dur}" fill="hold"/>${target}<p:attrNameLst><p:attrName>${attr}</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="${fromExpr}"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="#${attr}"/></p:val></p:tav></p:tavLst></p:anim>`;
  const dx = SLIDE_OFFSET * (SLIDE_HEIGHT / SLIDE_WIDTH); // same visual distance horizontally
  if (anim.effect === "fade-up") parts.push(move("ppt_y", `#ppt_y+${SLIDE_OFFSET.toFixed(4)}`));
  if (anim.effect === "fade-down") parts.push(move("ppt_y", `#ppt_y-${SLIDE_OFFSET.toFixed(4)}`));
  if (anim.effect === "fade-left") parts.push(move("ppt_x", `#ppt_x+${dx.toFixed(4)}`));
  if (anim.effect === "fade-right") parts.push(move("ppt_x", `#ppt_x-${dx.toFixed(4)}`));
  if (anim.effect === "scale") {
    parts.push(
      `<p:animScale><p:cBhvr><p:cTn id="${id++}" dur="${dur}" fill="hold"/>${target}</p:cBhvr><p:from x="92000" y="92000"/><p:to x="100000" y="100000"/></p:animScale>`,
    );
  }
  const xml = `<p:par><p:cTn id="${id++}" presetID="${preset.id}" presetClass="entr" presetSubtype="${preset.subtype}" fill="hold" grpId="0" nodeType="${nodeType}"><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst><p:childTnLst>${parts.join("")}</p:childTnLst></p:cTn></p:par>`;
  return { xml, nextId: id };
}

// ---- fills, lines, colours --------------------------------------------------

type Rgba = { hex: string; alpha: number };

function solidFill(color: Rgba | null, opacity = 1): string {
  if (!color) return "";
  const alpha = Math.round(color.alpha * opacity * 100000);
  return `<a:solidFill><a:srgbClr val="${color.hex}">${alpha < 100000 ? `<a:alpha val="${alpha}"/>` : ""}</a:srgbClr></a:solidFill>`;
}

/** CSS background → DrawingML fill. Solid colours and linear gradients. */
function fillXml(css: string, opacity: number): string | null {
  const value = css.trim();
  if (!value || value === "none" || value === "transparent") return null;
  const gradient = parseLinearGradient(value);
  if (gradient) {
    const stops = gradient.stops
      .map((stop) => {
        const alpha = Math.round(stop.color.alpha * opacity * 100000);
        return `<a:gs pos="${Math.round(stop.pos * 100000)}"><a:srgbClr val="${stop.color.hex}">${alpha < 100000 ? `<a:alpha val="${alpha}"/>` : ""}</a:srgbClr></a:gs>`;
      })
      .join("");
    return `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst><a:lin ang="${Math.round(gradient.angle * 60000)}" scaled="0"/></a:gradFill>`;
  }
  const color = parseColor(value);
  if (!color) return null;
  if (color.alpha <= 0) return null;
  return solidFill(color, opacity);
}

/** `1px solid #abc` → `<a:ln>`. Dashed/dotted keep their dash. */
function lineXml(css: string, opacity: number): string | null {
  const width = Number.parseFloat(css);
  const colorText = css.match(/(#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b[a-z]+\s*$)/i)?.[1]?.trim();
  const color = colorText ? parseColor(colorText) : null;
  if (!Number.isFinite(width) || width <= 0 || !color || /\bnone\b|\bhidden\b/.test(css)) return null;
  const dash = /\bdashed\b/.test(css) ? `<a:prstDash val="dash"/>` : /\bdotted\b/.test(css) ? `<a:prstDash val="sysDot"/>` : "";
  return `<a:ln w="${Math.round(width * EMU_PER_PX)}">${solidFill(color, opacity)}${dash}</a:ln>`;
}

const NAMED: Record<string, string> = {
  white: "FFFFFF",
  black: "000000",
  red: "FF0000",
  blue: "0000FF",
  green: "008000",
  gray: "808080",
  grey: "808080",
  silver: "C0C0C0",
  orange: "FFA500",
  yellow: "FFFF00",
  navy: "000080",
};

export function parseColor(value: string): Rgba | null {
  const v = value.trim().toLowerCase();
  if (!v || v === "transparent" || v === "none" || v === "currentcolor") return null;
  let m = v.match(/^#([0-9a-f]{3})([0-9a-f])?$/);
  if (m) {
    const hex = m[1]!.split("").map((c) => c + c).join("").toUpperCase();
    return { hex, alpha: m[2] ? Number.parseInt(m[2] + m[2], 16) / 255 : 1 };
  }
  m = v.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);
  if (m) return { hex: m[1]!.toUpperCase(), alpha: m[2] ? Number.parseInt(m[2], 16) / 255 : 1 };
  m = v.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/);
  if (m) {
    const hex = [m[1], m[2], m[3]].map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, "0")).join("").toUpperCase();
    const a = m[4] == null ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return { hex, alpha: Math.max(0, Math.min(1, a)) };
  }
  m = v.match(/^hsla?\(\s*([\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/);
  if (m) {
    const [r, g, b] = hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
    const hex = [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();
    const a = m[4] == null ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return { hex, alpha: a };
  }
  if (NAMED[v]) return { hex: NAMED[v]!, alpha: 1 };
  return null;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

type Gradient = { angle: number; stops: Array<{ pos: number; color: Rgba }> };

/** `linear-gradient(135deg, #a 0%, #b 100%)` → DrawingML angle (0 = left→right, clockwise) + stops. */
function parseLinearGradient(css: string): Gradient | null {
  const m = css.match(/linear-gradient\((.*)\)\s*$/is);
  if (!m) return null;
  const args = splitTopLevel(m[1]!);
  if (!args.length) return null;
  let cssAngle = 180; // default: to bottom
  const first = args[0]!.trim();
  const dirs: Record<string, number> = { "to top": 0, "to right": 90, "to bottom": 180, "to left": 270, "to top right": 45, "to right top": 45, "to bottom right": 135, "to right bottom": 135, "to bottom left": 225, "to left bottom": 225, "to top left": 315, "to left top": 315 };
  let stopArgs = args;
  if (/^-?[\d.]+(deg|turn|rad)$/.test(first)) {
    const n = Number.parseFloat(first);
    cssAngle = first.endsWith("turn") ? n * 360 : first.endsWith("rad") ? (n * 180) / Math.PI : n;
    stopArgs = args.slice(1);
  } else if (dirs[first.replace(/\s+/g, " ")] != null) {
    cssAngle = dirs[first.replace(/\s+/g, " ")]!;
    stopArgs = args.slice(1);
  }
  const stops: Gradient["stops"] = [];
  stopArgs.forEach((arg, i) => {
    const parts = arg.trim().match(/^(.*?)(?:\s+([\d.]+)%)?$/);
    const color = parseColor(parts?.[1]?.trim() ?? "");
    if (!color) return;
    const pos = parts?.[2] != null ? Number(parts[2]) / 100 : stopArgs.length === 1 ? 0 : i / (stopArgs.length - 1);
    stops.push({ pos: Math.max(0, Math.min(1, pos)), color });
  });
  if (stops.length < 2) return stops.length === 1 ? { angle: 0, stops: [stops[0]!, { ...stops[0]!, pos: 1 }] } : null;
  // CSS: 0deg points up, clockwise. DrawingML: 0 points right, clockwise.
  const angle = (((cssAngle - 90) % 360) + 360) % 360;
  return { angle, stops };
}

function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}

const GENERIC_FONTS: Record<string, string> = {
  "system-ui": "Segoe UI",
  "-apple-system": "Segoe UI",
  blinkmacsystemfont: "Segoe UI",
  "sans-serif": "Arial",
  serif: "Georgia",
  monospace: "Consolas",
  "ui-monospace": "Consolas",
  "ui-sans-serif": "Arial",
  "ui-serif": "Georgia",
  cursive: "Comic Sans MS",
};

/** First real family of a CSS font stack; generic families map to Office fonts. */
export function fontName(stack: string | undefined): string {
  const first = (stack ?? "").split(",")[0]?.trim().replace(/^["']|["']$/g, "") ?? "";
  if (!first) return "Arial";
  return GENERIC_FONTS[first.toLowerCase()] ?? first;
}

// ---- media ------------------------------------------------------------------

class MediaStore {
  private readonly byHash = new Map<string, Media>();
  private count = 0;

  constructor(
    private readonly zip: JSZip,
    private readonly options: Options,
  ) {}

  async image(c: SlideComponent): Promise<Media | null> {
    const src = c.src?.trim();
    if (!src) return null;
    let bytes: Uint8Array | null = null;
    let ext = "png";
    const data = src.match(/^data:([^;,]+)((?:;[^,]*)*),(.*)$/s);
    if (data) {
      const mime = data[1]!.toLowerCase();
      const raw = data[2]!.includes("base64") ? Buffer.from(data[3]!, "base64") : Buffer.from(decodeURIComponent(data[3]!), "utf8");
      if (mime === "image/svg+xml") {
        bytes = await this.rasterize(raw.toString("utf8"), c.width);
      } else {
        bytes = new Uint8Array(raw);
        ext = extFor(mime);
      }
    } else if (/^https?:\/\//i.test(src)) {
      const fetched = await (this.options.fetchImage ?? defaultFetch)(src);
      if (fetched) {
        const kind = sniff(fetched);
        if (kind === "svg") bytes = await this.rasterize(Buffer.from(fetched).toString("utf8"), c.width);
        else if (kind) {
          bytes = fetched;
          ext = kind;
        }
      }
    }
    if (!bytes?.length) return null;
    const hash = createHash("sha1").update(bytes).digest("hex");
    const existing = this.byHash.get(hash);
    if (existing) return existing;
    const dims = imageSize(bytes) ?? { width: 0, height: 0 };
    const name = `image${++this.count}.${ext}`;
    this.zip.file(`ppt/media/${name}`, bytes);
    const media = { name, bytes, ...dims };
    this.byHash.set(hash, media);
    return media;
  }

  private async rasterize(svg: string, widthPx: number): Promise<Uint8Array | null> {
    // 2× the placed size keeps icons crisp on a projector.
    const target = Math.max(32, Math.min(2048, Math.round(widthPx * 2)));
    try {
      return await (this.options.rasterizeSvg ?? defaultRasterize)(svg, target);
    } catch {
      return null;
    }
  }
}

async function defaultFetch(url: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "follow" });
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

async function defaultRasterize(svg: string, widthPx: number): Promise<Uint8Array | null> {
  const { Resvg } = await import("@resvg/resvg-js");
  // Icons flattened from the DOM carry `color="rgb(...)"` and `currentColor`;
  // resvg has no CSS cascade, so resolve currentColor to the given colour.
  const color = svg.match(/\bcolor="([^"]+)"/)?.[1];
  const prepared = color ? svg.replaceAll("currentColor", color) : svg;
  const resvg = new Resvg(prepared, { fitTo: { mode: "width", value: widthPx } });
  return resvg.render().asPng();
}

function extFor(mime: string): string {
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpeg";
  if (mime === "image/gif") return "gif";
  return "png";
}

function sniff(bytes: Uint8Array): "png" | "jpeg" | "gif" | "svg" | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "gif";
  const head = Buffer.from(bytes.subarray(0, 512)).toString("utf8");
  if (/<svg[\s>]/i.test(head)) return "svg";
  return null;
}

/** Pixel size of a PNG/JPEG/GIF, from the header. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes.length > 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes.length > 10) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1]!;
      const length = view.getUint16(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

// ---- helpers ----------------------------------------------------------------

function emu(px: number): number {
  return Math.round(px * EMU_PER_PX);
}

function esc(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ---- static parts -----------------------------------------------------------

const MASTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}">
<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles>
</p:sldMaster>`;

const LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}" type="blank" preserve="1">
<p:cSld name="Blank"><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree></p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;

const THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="${NS.a}" name="Langdock">
<a:themeElements>
<a:clrScheme name="Langdock"><a:dk1><a:srgbClr val="13141B"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2026"/></a:dk2><a:lt2><a:srgbClr val="F5F4F2"/></a:lt2><a:accent1><a:srgbClr val="4469FC"/></a:accent1><a:accent2><a:srgbClr val="6987FD"/></a:accent2><a:accent3><a:srgbClr val="898A8C"/></a:accent3><a:accent4><a:srgbClr val="EF4444"/></a:accent4><a:accent5><a:srgbClr val="2B2C32"/></a:accent5><a:accent6><a:srgbClr val="727376"/></a:accent6><a:hlink><a:srgbClr val="4469FC"/></a:hlink><a:folHlink><a:srgbClr val="6987FD"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Langdock"><a:majorFont><a:latin typeface="Inter"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Inter"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Office">
<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
<a:objectDefaults/><a:extraClrSchemeLst/>
</a:theme>`;
