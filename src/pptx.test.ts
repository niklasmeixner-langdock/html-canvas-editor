import assert from "node:assert/strict";
import { test } from "node:test";
import { deckToPptx } from "./pptx.ts";
import { isPptx, pptxToDeck } from "./pptx-import.ts";
import { sampleDeck } from "./sample.ts";

test("recognises PowerPoint files by their bytes", () => {
  assert.equal(isPptx(new TextEncoder().encode("<html></html>"), "deck.html", "text/html"), false);
  assert.equal(isPptx(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), "deck.pptx", "application/octet-stream"), true);
});

test("round-trips a deck through PowerPoint and keeps animations", async () => {
  const original = sampleDeck();
  const layers = original.slides[0]!.components;
  layers[0]!.animation = { effect: "fade", delay: 0, duration: 600 };
  layers[1]!.animation = { effect: "fade-up", delay: 0, duration: 500, step: 1 };
  layers[2]!.animation = { effect: "scale", delay: 300, duration: 400, step: 1 };
  const animated = layers.filter((component) => component.animation);
  assert.equal(animated.length, 3);

  const bytes = await deckToPptx(original);
  assert.equal(isPptx(bytes, "deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"), true);

  const restored = await pptxToDeck(bytes);
  assert.equal(restored.slides.length, original.slides.length);

  const texts = restored.slides[0]?.components.filter((component) => component.type === "text") ?? [];
  const originalTexts = original.slides[0]?.components.filter((component) => component.type === "text") ?? [];
  assert.equal(texts.length, originalTexts.length);
  for (const [i, component] of originalTexts.entries()) {
    const back = texts[i]!;
    assert.equal(back.text, component.text);
    assert.ok(Math.abs(back.x - component.x) < 1.5, `x ${back.x} ≈ ${component.x}`);
    assert.ok(Math.abs(back.y - component.y) < 1.5, `y ${back.y} ≈ ${component.y}`);
    // The exporter adds wrap slack to text frames, so width grows slightly.
    assert.ok(back.width >= component.width - 1.5 && back.width <= component.width * 1.07 + 13, `width ${back.width} ≈ ${component.width}`);
    assert.ok(Math.abs((back.fontSize ?? 0) - (component.fontSize ?? 0)) < 1, `fontSize ${back.fontSize} ≈ ${component.fontSize}`);
  }

  const restoredAnimated = restored.slides.flatMap((slide) => slide.components).filter((component) => component.animation);
  assert.equal(restoredAnimated.length, animated.length);
  const byText = new Map(restoredAnimated.map((component) => [component.text ?? component.name, component.animation!]));
  for (const component of animated) {
    const back = byText.get(component.text ?? component.name);
    assert.ok(back, `animation survives for ${component.name}`);
    assert.equal(back.effect, component.animation!.effect);
    assert.equal(back.step ?? undefined, component.animation!.step ?? undefined);
    assert.equal(back.delay, component.animation!.delay);
  }
});
