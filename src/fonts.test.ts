import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fontFamilyForWeight,
  isolateFontFacesByWeight,
  isolatedFamilyName,
  prepareDeckFonts,
} from "./flatten.ts";
import type { Deck } from "./types.ts";
import { SLIDE_HEIGHT, SLIDE_WIDTH } from "./types.ts";

test("isolates each @font-face family by weight", () => {
  const css = [
    "@font-face{font-family:Bureau;src:url(a);font-weight:400;font-style:normal}",
    "@font-face{font-family:Bureau;src:url(b);font-weight:500;font-style:normal}",
    "@font-face{font-family:Bureau;src:url(c);font-weight:700;font-style:normal}",
  ].join("\n");
  const out = isolateFontFacesByWeight(css);
  assert.match(out, /font-family:"Bureau-400"/);
  assert.match(out, /font-family:"Bureau-500"/);
  assert.match(out, /font-family:"Bureau-700"/);
  assert.equal(out.includes("font-family:Bureau;"), false);
  // Idempotent.
  assert.equal(isolateFontFacesByWeight(out), out);
});

test("points text stacks at the weight-specific face", () => {
  assert.equal(isolatedFamilyName("Bureau", 500), "Bureau-500");
  assert.equal(isolatedFamilyName("Bureau-500", 500), "Bureau-500");
  assert.equal(isolatedFamilyName("Inter", 700), "Inter");
  assert.equal(
    fontFamilyForWeight("Bureau, Arial, sans-serif", 500),
    '"Bureau-500", Arial, sans-serif',
  );
  assert.equal(fontFamilyForWeight("Inter, system-ui, sans-serif", 600), "Inter, system-ui, sans-serif");
});

test("prepareDeckFonts remaps subsetted custom fonts on the deck", () => {
  const deck: Deck = {
    title: "Survey",
    width: SLIDE_WIDTH,
    height: SLIDE_HEIGHT,
    source: "user",
    updatedAt: new Date().toISOString(),
    fontCss:
      "@font-face{font-family:Bureau;src:url(a);font-weight:500;font-style:normal}",
    slides: [
      {
        id: "s1",
        name: "Slide 1",
        background: "#fff",
        components: [
          {
            id: "t1",
            type: "text",
            name: "Work phones / SIM cards",
            x: 0,
            y: 0,
            width: 200,
            height: 24,
            opacity: 1,
            text: "Work phones / SIM cards",
            fontWeight: 500,
            fontFamily: "Bureau, Arial, sans-serif",
          },
        ],
      },
    ],
  };
  prepareDeckFonts(deck);
  assert.match(deck.fontCss ?? "", /font-family:"Bureau-500"/);
  assert.equal(deck.slides[0]?.components[0]?.fontFamily, '"Bureau-500", Arial, sans-serif');
  prepareDeckFonts(deck);
  assert.equal(deck.slides[0]?.components[0]?.fontFamily, '"Bureau-500", Arial, sans-serif');
});
