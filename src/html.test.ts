import assert from "node:assert/strict";
import { test } from "node:test";
import { deckToHtml, htmlToDeck } from "./html.ts";
import { sampleDeck } from "./sample.ts";

test("round-trips the sample deck through HTML", () => {
  const original = sampleDeck();
  const html = deckToHtml(original);
  const restored = htmlToDeck(html);
  assert.equal(restored.title, original.title);
  assert.equal(restored.slides.length, original.slides.length);
  assert.equal(restored.slides[0]?.components[1]?.text, original.slides[0]?.components[1]?.text);
});

test("turns uploaded slide HTML into editable text", () => {
  const restored = htmlToDeck(`
    <div class="slide" style="background:#F1F0ED">
      <h1 data-slot="title">Hello from the agent</h1>
      <p data-slot="subtitle">Move this copy without another prompt.</p>
    </div>
  `);
  assert.equal(restored.slides.length, 1);
  const texts = restored.slides[0]?.components.filter((component) => component.type === "text") ?? [];
  assert.equal(texts.length >= 2, true);
  assert.match(texts.map((component) => component.text).join(" "), /Hello from the agent/);
  assert.ok(restored.rawHtml);
});
