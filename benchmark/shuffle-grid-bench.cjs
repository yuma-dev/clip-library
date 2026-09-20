// Isolated production-component fixture: no real library, settings, or media.
// Run after npm run build:renderer. Reports synthetic before/after rendering costs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { build } = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-shuffle-bench-'));
const fixture = `
import React, { useState, useMemo, Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import ClipGroup from './src/renderer/library/ClipGroup';
import RailSearch from './src/renderer/shell/RailSearch';
import { useLibraryFilter } from './src/renderer/library/useLibraryFilter';
import { SelectionContext } from './src/renderer/library/selectionContext';
import { initGridKeyboardNavigation } from './src/renderer/library/gridNavigation';
initGridKeyboardNavigation();
let scans = 0;
window.clips = {
  loadGlobalTags: async () => ['Favorite', 'Hidden'],
  getTagPreferences: async () => ['Favorite', 'Untagged', 'Unnamed'],
  saveTagPreferences: async () => {},
  restoreMissingGlobalTags: async () => ({}),
  getGameIconsBatch: async () => ({}),
  getClipParticipants: async () => { scans++; return { people: [], byClip: {} }; },
};
window.fixtureStats = { durations: [], scans: () => scans };
const clips = Array.from({length: 2000}, (_, i) => ({originalName: 'clip-'+i+'.mp4', customName: 'Moment '+i,
  createdAt: Date.now()-i*86400000, tags: [i%3 ? 'Favorite' : 'Hidden'], isTrimmed: false, thumbnailPath: null }));
const thumbs = new Map();
const selected = new Set();
const selection = { isSelected: n => selected.has(n), onCardClick: (e,c) => { selected.add(c.originalName); e.currentTarget.classList.add('selected'); }, onCardContextMenu: () => {} };
function App() {
  const filter = useLibraryFilter(clips);
  const [collapsed, setCollapsed] = useState(false);
  const group = useMemo(() => ({name: 'Shuffled clips', clips: filter.filteredClips}), [filter.filteredClips]);
  return <><div className="rail" style={{height:80, width:700}}><RailSearch filter={filter} clips={clips}/></div>
    <button id="hide" onClick={filter.hideAllTags}>Hide all</button>
    <button id="all" onClick={filter.showAllTags}>Show all</button>
    <output id="count">{filter.filteredClips.length}</output>
    <output id="last">{filter.filteredClips.at(-1)?.originalName}</output>
    <div className="clip-scroll" style={{height:650, flex:'none'}}><div className="clip-grid">
      <Profiler id="grid" onRender={(_,phase,duration) => window.fixtureStats.durations.push(duration)}>
        <SelectionContext.Provider value={selection}><ClipGroup group={group} thumbnails={thumbs}
        grayscaleIcons={false} showNewIndicators={false} layoutHint={null} collapsed={collapsed}
        onToggle={() => setCollapsed(v => !v)}/></SelectionContext.Provider>
      </Profiler></div></div></>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
(async () => {
  let browser, server;
  try {
    const cssDir = path.join(root, 'renderer-dist/assets');
    const css = fs.readdirSync(cssDir).filter(f => f.endsWith('.css')).map(f => fs.readFileSync(path.join(cssDir, f), 'utf8')).join('\n');
    fs.writeFileSync(path.join(temp, 'style.css'), css);
    for (const mode of ['before', 'after']) {
      await build({ stdin: { contents: fixture, resolveDir: root, sourcefile: 'fixture.tsx', loader: 'tsx' },
        bundle: true, outfile: path.join(temp, mode+'.js'), jsx: 'automatic',
        define: {'process.env.NODE_ENV':'"development"'}, loader:{'.png':'dataurl','.jpg':'dataurl','.gif':'dataurl'},
        plugins: mode === 'before' ? [{name:'old-mounting',setup(b){b.onLoad({filter:/ClipGroup\.tsx$/},args=>({
          contents: fs.readFileSync(args.path,'utf8').replace('const virtualized = group.clips.length > 80;', 'const virtualized = false;'), loader:'tsx'
        }));}}] : [] });
    }
    server = http.createServer((req, res) => {
      if (req.url === '/before' || req.url === '/after') {
        res.setHeader('Content-Type','text/html'); res.end('<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root" class="route-host"></div><script src="'+req.url+'.js"></script></body></html>');
      } else if (['/before.js','/after.js','/style.css'].includes(req.url)) {
        res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript'); res.end(fs.readFileSync(path.join(temp,req.url.slice(1))));
      } else { res.statusCode=404; res.end(); }
    });
    await new Promise(r => server.listen(0,'127.0.0.1',r));
    browser = await chromium.launch({headless:true});
    const results = {};
    for (const mode of ['before','after']) {
      const page = await browser.newPage({viewport:{width:1440,height:900}});
      const errors=[]; page.on('pageerror',e=>errors.push(e.message));
      await page.goto('http://127.0.0.1:'+server.address().port+'/'+mode);
      await page.waitForFunction(() => document.querySelector('#count')?.textContent === '1333');
      const search = page.getByRole('textbox');
      await search.fill('?shuffle');
      if (mode==='before') await page.waitForFunction(() => document.querySelectorAll('.clip-item').length === 1333, {timeout:30000});
      else await page.waitForSelector('.clip-group-virtual');
      const mounted = await page.locator('.clip-item').count();
      const durations=[];
      for(let i=0;i<5;i++) {
        await page.evaluate(() => { window.fixtureStats.durations=[]; });
        await page.getByRole('button',{name:'Shuffle again'}).click();
        await page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
        durations.push(...await page.evaluate(() => window.fixtureStats.durations));
      }
      assert.equal(await page.evaluate(() => window.fixtureStats.scans()),0,'shuffle must not scan participants');
      if(mode==='after') {
        assert.ok(mounted<100,'mounted cards bounded independently of library size');
        // Scroll through the full reserved range, including the partial final row.
        await page.locator('.clip-scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;});
        await page.waitForFunction(()=>Array.from(document.querySelectorAll('.clip-item')).some(el=>el.dataset.originalName===document.querySelector('#last').textContent));
        const bottom = await page.locator('.clip-scroll').evaluate(el=>({height:el.scrollHeight, scroll:el.scrollTop, viewport:el.clientHeight}));
        assert.ok(Math.abs(bottom.height-bottom.scroll-bottom.viewport)<4,'can reach end');
        await page.setViewportSize({width:1000,height:900});
        await page.locator('.clip-scroll').evaluate(el=>{el.scrollTop=0;});
        await page.waitForFunction(()=>document.querySelector('.clip-group-virtual').style.paddingTop==='24px');
        // Existing selection survives row unmount/remount.
        const first = page.locator('.clip-item').first();
        const name = await first.getAttribute('data-original-name');
        await first.locator('.clip-item-media-container').click();
        await page.locator('.clip-scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;});
        await page.waitForFunction(n=>!document.querySelector('[data-original-name="'+n+'"]'),name);
        await page.locator('.clip-scroll').evaluate(el=>{el.scrollTop=0;});
        await page.waitForSelector('[data-original-name="'+name+'"].selected');
        // Keyboard focus follows clip identity while virtual row indices shift.
        await page.locator('#count').click();
        await page.keyboard.press('ArrowDown');
        let focused = await page.locator('.grid-focused').getAttribute('data-original-name');
        for (let i=0;i<18;i++) {
          await page.waitForTimeout(170);
          await page.keyboard.press('ArrowDown');
          const next = await page.locator('.grid-focused').getAttribute('data-original-name');
          assert.notEqual(next,focused,'keyboard navigation must advance across row windows');
          focused=next;
        }
        assert.ok(await page.locator('.clip-scroll').evaluate(el=>el.scrollTop)>0);
        await search.fill('?older:2m');
        await page.waitForFunction(()=>Number(document.querySelector('#count').textContent)<1333);
        await page.locator('#hide').click();
        await page.waitForFunction(()=>document.querySelector('#count').textContent==='0');
        await search.fill('?older:2m #hidden');
        await page.waitForFunction(()=>Number(document.querySelector('#count').textContent)>0);
        await search.fill('nonexistent');
        await page.waitForFunction(()=>document.querySelector('#count').textContent==='0');
        await page.locator('#all').click();
        await search.fill('?');
        await page.getByRole('button',{name:'Exclude the last 2 months'}).click();
        assert.equal(await search.inputValue(),'?older:2m ');
        await page.getByRole('button',{name:/Shuffled clips/}).click();
        await page.waitForFunction(()=>document.querySelectorAll('.clip-item').length===0);
        await page.getByRole('button',{name:/Shuffled clips/}).click();
        await page.waitForSelector('.clip-item');
      }
      assert.deepEqual(errors,[]);
      results[mode]={mountedCards:mounted, reshuffleReactMaxMs:+Math.max(...durations).toFixed(2), reshuffleReactMeanMs:+(durations.reduce((a,b)=>a+b,0)/durations.length).toFixed(2)};
      await page.close();
    }
    console.log(JSON.stringify({checks:'passed', fixtureClips:2000, results},null,2));
  } finally {
    await browser?.close();
    if(server) await new Promise(r=>server.close(r));
    if(path.dirname(temp)===path.resolve(os.tmpdir()) && path.basename(temp).startsWith('clip-shuffle-bench-')) fs.rmSync(temp,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
