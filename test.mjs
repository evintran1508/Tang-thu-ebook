import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  stripMarks,
  inferGenre,
  fetchArchiveBooksPage,
  fetchItemMetadata,
  resolveLeafCount,
  fetchLeafSpeechText,
  buildScanPageUrl
} from './js/archive.js';
import { getBookVisual, buildPosterDataUrl, getCoverImageUrls } from './js/cover.js';
import { getRecentProgress, setProgress, removeProgress } from './js/store.js';

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://archive.org/') || url.includes('.archive.org/')) {
    const buf = execFileSync('curl.exe', ['-4', '-sS', '-L', '--retry', '3', '--retry-all-errors', url], {
      maxBuffer: 25 * 1024 * 1024
    });
    return new Response(buf, { status: 200 });
  }
  return nativeFetch(input, init);
};

// 1. Validate seed catalog & cover / leaf image endpoints
const catalog = JSON.parse(fs.readFileSync('./data/catalog.json', 'utf8'));
assert(catalog.length >= 24, 'catalog has >= 24 verified seed books');
assert.equal(catalog[5].identifier, 'biquyetthanhcong_dacnhantam_2016', 'Đắc Nhân Tâm sits at initial active slot 5');
const [hiCover, thumbCover] = getCoverImageUrls(catalog[5].identifier);
assert(hiCover.endsWith('/page/cover_w500.jpg'), 'uses crisp 500px-wide Archive cover endpoint');
assert(thumbCover.includes('/services/img/'), 'keeps fallback thumbnail endpoint');
assert.equal(
  buildScanPageUrl('cau-truyen-triet-hoc-will-durant', 7, 1200),
  'https://archive.org/download/cau-truyen-triet-hoc-will-durant/page/n7_w1200.jpg'
);
assert.equal(
  buildScanPageUrl('cau-truyen-triet-hoc-will-durant', 7, 300),
  'https://archive.org/download/cau-truyen-triet-hoc-will-durant/page/n7_w300.jpg'
);

// 2. Validate text-reading removal & native browser cursor
assert.equal(fs.existsSync('./js/epub.js'), false, 'js/epub.js text reader module is removed');
const html = fs.readFileSync('./index.html', 'utf8');
const css = fs.readFileSync('./css/app.css', 'utf8');
const mainJs = fs.readFileSync('./js/main.js', 'utf8');
const readerJs = fs.readFileSync('./js/reader.js', 'utf8');
const shelfJs = fs.readFileSync('./js/shelf.js', 'utf8');
const coverJs = fs.readFileSync('./js/cover.js', 'utf8');

assert(!html.includes('id="cursor"'), 'custom floating cursor DOM removed');
assert(!css.includes('cursor: none'), 'cursor: none override removed across web app');
assert(!html.includes('id="rdrModeBtn"') && !html.includes('id="rdrStageWrap"'), 'text reading mode removed');

// 3. Validate DOM IDs & Icon-based Internet Archive Reader Toolbar
const ids = [...mainJs.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
for (const id of ids) {
  assert(html.includes(`id="${id}"`), `Missing DOM id in index.html: ${id}`);
}

const requiredIconBtns = [
  'rdrCloseBtn',
  'rdrView1Btn',
  'rdrView2Btn',
  'rdrViewThumbBtn',
  'rdrTtsBtn',
  'rdrZoomOutBtn',
  'rdrZoomInBtn',
  'rdrExpandBtn',
  'rdrSidePrevBtn',
  'rdrSideNextBtn',
  'rdrPrevBtn',
  'rdrNextBtn'
];
for (const btnId of requiredIconBtns) {
  const re = new RegExp(`id="${btnId}"[\\s\\S]*?<svg\\b`, 'i');
  assert(re.test(html), `${btnId} renders as an SVG icon button`);
}
assert(html.includes('id="rdrThumbGrid"'), 'includes multi-page thumbnail grid container');
assert(
  html.includes('value="downloads desc"') &&
  html.includes('value="week desc"') &&
  html.includes('value="month desc"'),
  'sort dropdown exposes Archive popularity rankings (downloads, week, month)'
);

// 4. Validate layout bounds, centered header tabs, catalog-scoped filters & weekly-only sidebar
const topbarHtml = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
assert(topbarHtml.includes('class="tabs"'), 'genre tabs sit in topbar');
assert(
  !topbarHtml.includes('id="langSelect"') &&
  !topbarHtml.includes('id="filterToggleBtn"') &&
  !topbarHtml.includes('id="sortSelect"'),
  'topbar no longer holds language, filter, or sort controls'
);
assert(
  css.includes('grid-template-columns: 1fr auto 1fr') && css.includes('justify-self: center'),
  'genre tabs are geometrically centered in header'
);

const sidebarHtml = html.slice(html.indexOf('<aside class="sidebar"'), html.indexOf('</aside>'));
assert(!sidebarHtml.includes('id="sortSelect"'), 'Sách nổi bật sidebar no longer holds sort dropdown');
assert(sidebarHtml.includes('Thịnh hành tuần'), 'Sách nổi bật sidebar labeled as weekly trending');
assert(
  mainJs.includes('loadWeeklyTrending') && mainJs.includes("sort: 'week desc'"),
  'Sách nổi bật fetches strictly weekly trending books (week desc)'
);

const catalogHeadHtml = html.slice(html.indexOf('<div class="catalog-head">'), html.indexOf('<div class="catalog-body"'));
assert(
  catalogHeadHtml.includes('id="sortSelect"') &&
  catalogHeadHtml.includes('id="langSelect"') &&
  catalogHeadHtml.includes('id="filterToggleBtn"') &&
  catalogHeadHtml.includes('id="filterDrawer"') &&
  catalogHeadHtml.includes('id="viewShelfBtn"') &&
  catalogHeadHtml.includes('id="viewGridBtn"'),
  'sort, language, filter, and shelf/grid toggle all sit side-by-side in catalog header'
);

assert.equal(stripMarks('Bí Quyết Thành Công: Đắc Nhân Tâm'), 'bi quyet thanh cong: dac nhan tam');
assert.equal(inferGenre({ title: 'Đắc nhân tâm', subject: [] }).genre, 'selfhelp');
assert.deepEqual(getBookVisual(catalog[5]), getBookVisual(catalog[5]), 'deterministic cover hash');
assert(Array.isArray(getRecentProgress()), 'getRecentProgress returns array safely without window');
setProgress(catalog[5], { ratio: 0.35, addSeconds: 12 });
removeProgress(catalog[5].identifier);
const posterUrl = decodeURIComponent(buildPosterDataUrl(catalog[5]));
assert(posterUrl.includes('viewBox="0 0 600 900"'), 'poster uses true 2:3 book ratio (600x900)');
assert(
  css.includes('.reader.is-immersive .rdr-header') &&
  css.includes('.reader.is-immersive .rdr-footer') &&
  !css.includes('.reader.is-immersive .rdr-header,\n.reader.is-immersive .rdr-footer {\n  display: none'),
  'fullscreen mode keeps reader tools & footer visible'
);
assert(
  readerJs.includes('sidePrevBtnEl') && readerJs.includes('sideNextBtnEl'),
  'left & right side page-turn buttons wired in reader'
);
assert(
  css.includes('.grid-foot') && css.includes('height: calc(1.2em * 2)') && css.includes('align-items: flex-end'),
  'save buttons in book list cards align uniformly on a single horizontal line'
);
assert(
  html.includes('type="text" inputmode="search"') &&
  css.includes('input:not(.search-input):focus-visible') &&
  css.includes('::-webkit-search-cancel-button'),
  'search input removes nested blue focus box and duplicate browser clear icon'
);
assert(readerJs.includes('VERIFY_DWELL_SEC') && readerJs.includes('speechSynthesis'), 'reader includes verified reading & speechSynthesis Read Aloud');
assert(
  readerJs.includes('triggerPageTurnAnim') &&
  css.includes('.rdr-spread') &&
  css.includes('transform-style: preserve-3d'),
  'reader includes hardware-accelerated 3D page turn transition'
);
assert(
  mainJs.includes('resumeReaderForId') &&
  mainJs.includes('#read/'),
  'main preserves reader session across page reloads via URL hash'
);
assert(
  shelfJs.includes('checkHoverMath') &&
  shelfJs.includes('overlayOpen') &&
  !css.includes('mix-blend-mode: multiply'),
  'shelf utilizes zero-reflow mathematical hover and pauses during reader overlay, paper grain removes mix-blend-mode'
);
assert(shelfJs.includes('shelfEl.getBoundingClientRect()'), '3D shelf measures strictly inside its bounded container');
assert(coverJs.includes('is-contain') && css.includes('.cv-full-img.is-contain'), 'prevents stretching on non-portrait covers');

// 5. Live verification: Internet Archive automatic popularity ranking & per-leaf speech OCR
const popAllTime = await fetchArchiveBooksPage({ lang: 'vie', sort: 'downloads desc', rows: 5 });
assert(popAllTime.items.length >= 3, 'live Archive popularity query returns items');
assert(
  popAllTime.items[0].downloads >= popAllTime.items[1].downloads &&
  popAllTime.items[1].downloads >= popAllTime.items[2].downloads,
  'Archive API automatically sorts items by all-time downloads desc'
);

const popWeek = await fetchArchiveBooksPage({ lang: 'vie', sort: 'week desc', rows: 5 });
assert(popWeek.items.length >= 3, 'live Archive weekly trending query returns items');
assert(
  popWeek.items[0].week >= popWeek.items[1].week &&
  popWeek.items[1].week >= popWeek.items[2].week,
  'Archive API automatically sorts items by 7-day popularity (week desc)'
);

const meta = await fetchItemMetadata('cau-truyen-triet-hoc-will-durant');
const leaves = await resolveLeafCount(meta);
assert(leaves > 400, 'resolves >400 leaves on Will Durant printed book');
const leafSpeech = await fetchLeafSpeechText(meta, 7, leaves);
assert(leafSpeech.length > 80, 'extracts real Vietnamese OCR speech text for printed leaf 7');

// 6. Verify real disk persistence API on localhost:4173 (/api/userdata) and server security
const badUriRes = await fetch('http://localhost:4173/%E0%A4%A');
assert.equal(badUriRes.status, 400, 'server returns 400 for malformed URI without crashing');

const privRes1 = await fetch('http://localhost:4173/data/userdata.json');
assert.equal(privRes1.status, 403, 'server blocks direct access to userdata.json');
const privRes2 = await fetch('http://localhost:4173/server.mjs');
assert.equal(privRes2.status, 403, 'server blocks direct access to server.mjs');

assert(
  css.includes('flex: 0 0 420px') && css.includes('flex: 0 0 390px'),
  'catalogBody maintains fixed flex basis on mobile & tablet'
);
assert(
  shelfJs.includes('lastNeedMoreTime') && mainJs.includes('nextLoadAllowedAt'),
  'app throttles next page requests to prevent request storm on error'
);

const initDataRes = await fetch('http://localhost:4173/api/userdata');
assert.equal(initDataRes.status, 200, 'GET /api/userdata responds 200');
const backupData = await initDataRes.json();

const testPayload = {
  saved: [{ identifier: catalog[5].identifier, title: catalog[5].title, creator: catalog[5].creator }],
  progress: {
    [catalog[10].identifier]: {
      identifier: catalog[10].identifier,
      title: catalog[10].title,
      creator: catalog[10].creator,
      verified: true,
      mode: 'scan',
      scanLeaf: 7,
      scanTotal: 412,
      ratio: 8 / 412,
      posLabel: 'Trang 8–9 / 412',
      readSeconds: 45
    }
  },
  prefs: { pageLayout: 'double' }
};

const putRes = await fetch('http://localhost:4173/api/userdata', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(testPayload)
});
assert.equal(putRes.status, 200, 'PUT /api/userdata persists to disk');
const verifyDisk = JSON.parse(fs.readFileSync('./data/userdata.json', 'utf8'));
assert.equal(verifyDisk.saved[0].identifier, catalog[5].identifier, 'userdata.json persisted saved book');
assert.equal(verifyDisk.progress[catalog[10].identifier].scanLeaf, 7, 'userdata.json persisted exact scan page');

// Verify server merge protects existing saved books from unhydrated empty payload
const emptyPayload = { saved: [], progress: {}, prefs: {} };
await fetch('http://localhost:4173/api/userdata', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(emptyPayload)
});
const checkMerge = JSON.parse(fs.readFileSync('./data/userdata.json', 'utf8'));
assert.equal(checkMerge.saved[0].identifier, catalog[5].identifier, 'server merge protects saved books from new-client wipe');

if (!backupData.updatedAt && backupData.saved.length === 0 && Object.keys(backupData.progress).length === 0) {
  fs.rmSync('./data/userdata.json', { force: true });
} else {
  await fetch('http://localhost:4173/api/userdata', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(backupData)
  });
}

console.log(
  `OK: ${ids.length} DOM ids, ${requiredIconBtns.length} SVG icon tools, Archive popularity sort (top=${popAllTime.items[0].downloads.toLocaleString()} downloads, week=${popWeek.items[0].week}), speech OCR (${leafSpeech.length} chars), default cursor, and disk persistence verified.`
);
