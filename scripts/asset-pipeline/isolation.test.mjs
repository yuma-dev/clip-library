import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { isolateLayer, resetIsolation } from './isolation.mjs';

test('transparent capture preserves hidden menus and restores state between layers', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="export-root"><div data-layer="background">background</div><div data-layer="card">card</div><div data-layer="menu" style="visibility:hidden"><span>menu</span></div><div data-layer="profile" style="visibility:hidden"></div></div>');
    const states = () => page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll('[data-layer]')).map(el => [el.dataset.layer, getComputedStyle(el).visibility])));
    const before = await states();
    await page.evaluate(isolateLayer, '#export-root > :not([data-layer="background"])');
    assert.deepEqual(await states(), {background:'hidden',card:'visible',menu:'hidden',profile:'hidden'});
    await page.evaluate(resetIsolation);
    assert.deepEqual(await states(), before);
    await page.evaluate(() => document.querySelector('[data-layer="menu"]').style.visibility = 'visible');
    await page.evaluate(isolateLayer, '#export-root > :not([data-layer="background"])');
    assert.equal((await states()).menu, 'visible');
    await page.evaluate(resetIsolation);
    await page.evaluate(isolateLayer, {selector:'#export-root > :not([data-layer="background"])',exclude:['[data-layer="menu"]']});
    assert.equal((await states()).menu, 'hidden');
    await page.evaluate(resetIsolation);
    assert.equal((await states()).menu, 'visible');
  } finally { await browser.close(); }
});
