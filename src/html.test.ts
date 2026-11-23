import assert from "node:assert/strict";
import { test } from "node:test";
import { deckToHtml, htmlToDeck } from "./html.ts";
import { sampleDeck } from "./sample.ts";
import { defaultComponent, emptyDeck } from "./types.ts";

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

test("exports input fields as fillable textareas that survive a re-import", () => {
  const deck = emptyDeck("Workshop");
  const field = defaultComponent("input", 200, 200);
  field.text = '\nWe said <b>yes</b> & "maybe"';
  field.placeholder = 'Your "answer"';
  deck.slides[0]!.components.push(defaultComponent("text", 80, 80), field);

  const html = deckToHtml(deck);
  assert.match(html, /<textarea data-field [^>]*placeholder="Your &quot;answer&quot;"/);
  assert.match(html, /class="save"/, "a fillable deck can save a filled-in copy");
  assert.match(html, /<main class="deck" data-stamp="[a-z0-9]+">/);
  assert.ok(!html.includes("<b>yes</b>"), "typed text is escaped, never markup");

  // Lossless through the embedded deck JSON.
  const viaJson = htmlToDeck(html).slides[0]?.components.find((component) => component.id === field.id);
  assert.deepEqual(viaJson, field);

  // And from the markup alone, should the JSON be gone.
  const bare = html.replace(/<script type="application\/json" id="deck-data">[\s\S]*?<\/script>/, "");
  const viaMarkup = htmlToDeck(bare).slides[0]?.components.find((component) => component.id === field.id);
  assert.equal(viaMarkup?.type, "input");
  assert.equal(viaMarkup?.text, field.text);
  assert.equal(viaMarkup?.placeholder, field.placeholder);
  assert.equal(viaMarkup?.fontSize, field.fontSize);
  assert.equal(viaMarkup?.padding, field.padding);
});

test("leaves decks without input fields free of the save chrome", () => {
  const html = deckToHtml(sampleDeck());
  assert.ok(!html.includes('class="save"'));
  assert.ok(!html.includes("data-stamp="));
  assert.ok(!html.includes("<textarea"));
});
