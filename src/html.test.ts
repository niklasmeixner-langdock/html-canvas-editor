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

test("wraps arbitrary HTML as a single imported slide", () => {
  const restored = htmlToDeck("<h1>Hello from the agent</h1>");
  assert.equal(restored.slides.length, 1);
  assert.equal(restored.slides[0]?.components[0]?.type, "html");
  assert.match(restored.slides[0]?.components[0]?.html ?? "", /Hello from the agent/);
});
