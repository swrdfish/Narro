import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { enhanceSelect } from '../src/select.js';

function setup(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { pretendToBeVisual: true });
  const { document } = dom.window;
  const select = document.querySelector('select');
  const events = [];
  select.addEventListener('input', () => events.push(`input:${select.value}`));
  select.addEventListener('change', () => events.push(`change:${select.value}`));
  enhanceSelect(select);
  const wrapper = select.parentElement;
  const button = wrapper.querySelector('.cs-button');
  const list = wrapper.querySelector('.cs-list');
  const key = (k) => button.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  const options = () => [...list.querySelectorAll('[role=option]')];
  return { dom, document, select, button, list, events, key, options };
}

const VOICES = '<label class="field"><span>Voice</span><select><option value="amy">Amy</option><option value="joe">Joe</option><option value="kim">Kim</option><option value="kyle">Kyle</option></select></label>';

test('the button shows the selection and is named by the field label', () => {
  const { select, button, document } = setup(VOICES);
  assert.equal(button.textContent, 'Amy');
  assert.equal(button.getAttribute('role'), 'combobox');
  const [labelId, valueId] = button.getAttribute('aria-labelledby').split(' ');
  assert.equal(document.getElementById(labelId).textContent, 'Voice');
  assert.equal(document.getElementById(valueId).textContent, 'Amy');
  assert.equal(select.tabIndex, -1, 'the hidden native select is out of the tab order');
});

test('clicking opens the list; choosing updates the native select and fires input/change', () => {
  const { button, list, select, events, options } = setup(VOICES);
  button.click();
  assert.equal(list.hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  options()[2].click();
  assert.equal(select.value, 'kim');
  assert.equal(button.textContent, 'Kim');
  assert.equal(list.hidden, true);
  assert.deepEqual(events, ['input:kim', 'change:kim']);
  assert.equal(options()[2].getAttribute('aria-selected'), 'true');
});

test('keyboard: arrows, Home/End and Enter choose; Escape closes without changing', () => {
  const { button, list, select, events, key } = setup(VOICES);
  key('ArrowDown'); // opens
  assert.equal(list.hidden, false);
  key('ArrowDown');
  key('ArrowDown');
  key('Enter');
  assert.equal(select.value, 'kim');
  key('ArrowDown');
  key('End');
  key('Escape');
  assert.equal(list.hidden, true);
  assert.equal(select.value, 'kim', 'Escape keeps the previous choice');
  key(' ');
  key('Home');
  key('Enter');
  assert.equal(select.value, 'amy');
  assert.deepEqual(events, ['input:kim', 'change:kim', 'input:amy', 'change:amy']);
});

test('type-ahead jumps to matching options', () => {
  const { select, key } = setup(VOICES);
  key('k'); // closed: chooses directly, like a native select
  assert.equal(select.value, 'kim');
  key('k');
  assert.equal(select.value, 'kyle', 'the same letter again moves to the next match');
});

test('option groups are shown as headings', () => {
  const { list, options } = setup('<label class="field"><span>Engine</span><select><optgroup label="Cloud"><option value="openai">OpenAI</option></optgroup><optgroup label="Local"><option value="kokoro">Kokoro</option><option value="piper">Piper</option></optgroup></select></label>');
  assert.deepEqual([...list.querySelectorAll('.cs-group')].map((g) => g.textContent), ['Cloud', 'Local']);
  assert.deepEqual(options().map((o) => o.textContent), ['OpenAI', 'Kokoro', 'Piper']);
});

test('values set by code and replaced options stay in sync', async () => {
  const { dom, select, button, options } = setup(VOICES);
  select.value = 'joe';
  assert.equal(button.textContent, 'Joe');
  select.replaceChildren(new dom.window.Option('Alba', 'alba'), new dom.window.Option('Cori', 'cori'));
  select.value = 'cori';
  await new Promise((resolve) => setTimeout(resolve, 0)); // the option list re-renders on mutation
  assert.deepEqual(options().map((o) => o.textContent), ['Alba', 'Cori']);
  assert.equal(button.textContent, 'Cori');
  assert.equal(options()[1].getAttribute('aria-selected'), 'true');
});
