import { fetchArchiveBooksPage, loadSeedCatalog, fetchItemMetadata } from './archive.js';
import {
  hydrateStore,
  getSaved,
  isSaved,
  toggleSave,
  getProgress,
  getRecentProgress,
  removeProgress,
  getPrefs,
  setPrefs
} from './store.js';
import { renderCover } from './cover.js';
import { createShelf } from './shelf.js';
import { createDetail } from './detail.js';
import { createReader } from './reader.js';

const GENRE_TITLES = {
  all: 'Kho sách đề xuất',
  saved: 'Tủ sách đã lưu',
  selfhelp: 'Kỹ năng & Sống đẹp',
  novel: 'Tiểu thuyết',
  short: 'Truyện & Ký',
  poetry: 'Thơ ca',
  history: 'Sử & Khảo cứu'
};

const BOOKMARK_SVG = '<svg viewBox="0 0 14 18" aria-hidden="true"><path d="M2 1.5 H12 V16.5 L7 12.8 L2 16.5 Z"/></svg>';

const initPrefs = getPrefs();

const state = {
  layout: initPrefs.layout === 'grid' ? 'grid' : 'shelf',
  genre: 'all',
  lang: 'all',
  era: 'all',
  author: 'all',
  sort: 'downloads desc',
  query: '',
  page: 1,
  hasMore: false
};

let searchAbort = null;
let moreAbort = null;
let loadingMore = false;
let debounceTimer = null;
let filterBarOpen = false;
let lastOriginCoverEl = null;

let seedBooks = [];
let trendingBooks = [];
let catalogBooks = [];
let heroBook = null;
let heroBookId = '';

const knownAuthors = new Set();
const gridSeenIds = new Set();

// DOM references
const tabInd = document.getElementById('tabInd');
const tabBtns = Array.from(document.querySelectorAll('.tab-btn'));
const savedCountEl = document.getElementById('savedCount');
const archiveTotalEl = document.getElementById('archiveTotal');
const catalogHeadingEl = document.getElementById('catalogHeading');

const sideNewListEl = document.getElementById('sideNewList');
const sideProgressListEl = document.getElementById('sideProgressList');
const sideProgressMetaEl = document.getElementById('sideProgressMeta');

const heroTagsEl = document.getElementById('heroTags');
const heroTitleEl = document.getElementById('heroTitle');
const heroAuthorEl = document.getElementById('heroAuthor');
const heroDescEl = document.getElementById('heroDesc');
const heroReadBtnEl = document.getElementById('heroReadBtn');
const heroReadLblEl = document.getElementById('heroReadLbl');
const heroSaveBtnEl = document.getElementById('heroSaveBtn');
const heroSaveLblEl = document.getElementById('heroSaveLbl');
const heroDetailBtnEl = document.getElementById('heroDetailBtn');
const heroCoverEl = document.getElementById('heroCover');
const heroPrevBtnEl = document.getElementById('heroPrevBtn');
const heroNextBtnEl = document.getElementById('heroNextBtn');

const viewShelfBtn = document.getElementById('viewShelfBtn');
const viewGridBtn = document.getElementById('viewGridBtn');
const shelfSectionEl = document.getElementById('shelf');
const gridViewEl = document.getElementById('gridView');
const gridListEl = document.getElementById('gridList');
const gridMoreWrapEl = document.getElementById('gridMoreWrap');
const gridMoreBtnEl = document.getElementById('gridMoreBtn');

const searchInput = document.getElementById('searchInput');
const searchClearBtn = document.getElementById('searchClearBtn');
const langSelect = document.getElementById('langSelect');

const filterAnchorEl = document.getElementById('filterAnchor');
const filterToggleBtn = document.getElementById('filterToggleBtn');
const filterDrawer = document.getElementById('filterDrawer');
const eraBtns = Array.from(document.querySelectorAll('[data-era]'));
const sortSelect = document.getElementById('sortSelect');
const authorSelect = document.getElementById('authorSelect');
const filterResetBtn = document.getElementById('filterResetBtn');

const resumeBarEl = document.getElementById('resumeBar');
const resumeCoverEl = document.getElementById('resumeCover');
const resumeTitleEl = document.getElementById('resumeTitle');
const resumeSubEl = document.getElementById('resumeSub');
const resumeBtnEl = document.getElementById('resumeBtn');

function syncResumeBar() {
  if (!resumeBarEl || !resumeTitleEl || !resumeSubEl || !resumeBtnEl) return;
  const recent = getRecentProgress();
  if (recent.length > 0) {
    const book = recent[0];
    const pct = Math.max(1, Math.min(100, Math.round((book.ratio || 0) * 100)));
    const pos = book.posLabel || 'Đang đọc';
    resumeTitleEl.textContent = book.title;
    resumeSubEl.textContent = `${pos} (${pct}%) · ${book.creator || 'Khuyết danh'}`;
    if (resumeCoverEl) {
      resumeCoverEl.innerHTML = '';
      renderCover(resumeCoverEl, book, { size: 'w250', compact: true, eager: true });
    }
    resumeBarEl.hidden = false;
    resumeBtnEl.onclick = () => {
      resumeReaderForId(book.identifier, { immediate: false });
    };
  } else {
    resumeBarEl.hidden = true;
  }
}

function openBookDetail(book, originEl = null) {
  if (!book || detail.isOpen() || reader.isOpen()) return;
  lastOriginCoverEl = originEl;
  shelf.setOverlayOpen(true);
  const rect = originEl && originEl.isConnected
    ? originEl.getBoundingClientRect()
    : shelf.getActiveCoverRect();
  detail.open(book, rect);
}

function openBookReader(book, meta = null, { immediate = false } = {}) {
  if (!book || reader.isOpen()) return;
  shelf.setOverlayOpen(true);
  document.body.classList.add('reader-open');
  reader.open(book, meta, { immediate });
  const targetHash = `#read/${encodeURIComponent(book.identifier)}`;
  if (window.location.hash !== targetHash) {
    history.replaceState(null, '', targetHash);
  }
}

async function resumeReaderForId(rawId, { immediate = true } = {}) {
  if (!rawId) return;
  const pool = catalogBooks.length > 0 ? catalogBooks : seedBooks;
  const found = pool.find((b) => b.identifier === rawId);
  if (found) {
    openBookReader(found, null, { immediate });
    return;
  }
  const prog = getProgress(rawId);
  if (prog && prog.identifier) {
    openBookReader(
      {
        identifier: prog.identifier,
        title: prog.title || prog.identifier,
        creator: prog.creator || 'Khuyết danh',
        langCode: prog.langCode || 'vie',
        genreLabel: prog.genreLabel || 'Sách'
      },
      null,
      { immediate }
    );
    return;
  }
  const saved = getSaved().find((b) => b.identifier === rawId);
  if (saved) {
    openBookReader(saved, null, { immediate });
    return;
  }
  try {
    const meta = await fetchItemMetadata(rawId);
    openBookReader(
      {
        identifier: rawId,
        title: meta.title || rawId,
        creator: meta.creator || 'Khuyết danh',
        langCode: meta.langCode || 'vie',
        genreLabel: 'Sách'
      },
      meta,
      { immediate }
    );
  } catch {
    openBookReader({ identifier: rawId, title: rawId, creator: 'Khuyết danh' }, null, { immediate });
  }
}

const shelf = createShelf({
  shelfEl: shelfSectionEl,
  stageEl: document.getElementById('stage'),
  capTitleEl: document.getElementById('capTitle'),
  capSubEl: document.getElementById('capSub'),
  capYearEl: document.getElementById('capYear'),
  statusBoxEl: document.getElementById('shelfStatus'),
  statusMsgEl: document.getElementById('shelfStatusMsg'),
  statusActionEl: document.getElementById('shelfStatusBtn'),
  onOpenBook: (book, coverRect) => {
    if (!book) return;
    lastOriginCoverEl = null;
    shelf.setOverlayOpen(true);
    detail.open(book, coverRect);
  },
  onActiveChange: (book) => {
    if (book) syncHero(book);
  },
  onNeedMore: () => loadNextPage(),
  onResetFilters: () => resetAllFilters(),
  onRetryLoad: () => refreshShelf({ animateSlide: true })
});

const reader = createReader({
  readerEl: document.getElementById('reader'),
  closeBtnEl: document.getElementById('rdrCloseBtn'),
  titleBarEl: document.getElementById('rdrTitle'),
  view1BtnEl: document.getElementById('rdrView1Btn'),
  view2BtnEl: document.getElementById('rdrView2Btn'),
  viewThumbBtnEl: document.getElementById('rdrViewThumbBtn'),
  ttsBtnEl: document.getElementById('rdrTtsBtn'),
  zoomOutBtnEl: document.getElementById('rdrZoomOutBtn'),
  zoomResetBtnEl: document.getElementById('rdrZoomResetBtn'),
  zoomInBtnEl: document.getElementById('rdrZoomInBtn'),
  expandBtnEl: document.getElementById('rdrExpandBtn'),
  sidePrevBtnEl: document.getElementById('rdrSidePrevBtn'),
  sideNextBtnEl: document.getElementById('rdrSideNextBtn'),
  scanFrameWrapEl: document.getElementById('rdrScanWrap'),
  bookStageEl: document.getElementById('rdrBookStage'),
  spreadEl: document.getElementById('rdrSpread'),
  leafLeftEl: document.getElementById('rdrLeafLeft'),
  leafRightEl: document.getElementById('rdrLeafRight'),
  thumbGridEl: document.getElementById('rdrThumbGrid'),
  scanIframeEl: document.getElementById('rdrScanIframe'),
  stateBoxEl: document.getElementById('rdrStateBox'),
  stateMsgEl: document.getElementById('rdrStateMsg'),
  prevPageBtnEl: document.getElementById('rdrPrevBtn'),
  nextPageBtnEl: document.getElementById('rdrNextBtn'),
  pageInfoEl: document.getElementById('rdrPageInfo'),
  pageRangeEl: document.getElementById('rdrPageRange'),
  isReducedMotion: () => shelf.isReducedMotion(),
  onCloseReader: () => {
    document.body.classList.remove('reader-open');
    if (window.location.hash.startsWith('#read/')) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    detail.syncReadButton();
    syncHeroReadState();
    renderSidebarProgress();
    syncResumeBar();
    if (!detail.isOpen()) {
      shelf.setOverlayOpen(false);
    }
  }
});

const detail = createDetail({
  detailEl: document.getElementById('detail'),
  closeBtnEl: document.getElementById('detCloseBtn'),
  detSubEl: document.getElementById('detSub'),
  detBadgeEl: document.getElementById('detBadge'),
  detTitleEl: document.getElementById('detTitle'),
  detMetaEl: document.getElementById('detMeta'),
  detSynEl: document.getElementById('detSyn'),
  detReadBtnEl: document.getElementById('detReadBtn'),
  detSaveBtnEl: document.getElementById('detSaveBtn'),
  detExtLinkEl: document.getElementById('detExtLink'),
  detImgEl: document.getElementById('detImg'),
  inkBlobsEls: Array.from(document.querySelectorAll('#inkBlobs circle')),
  detLineEls: Array.from(document.querySelectorAll('.det-line')),
  getCoverRect: () => {
    if (lastOriginCoverEl && lastOriginCoverEl.isConnected) {
      return lastOriginCoverEl.getBoundingClientRect();
    }
    return shelf.getActiveCoverRect();
  },
  isReducedMotion: () => shelf.isReducedMotion(),
  onOpenReader: (book, meta) => {
    openBookReader(book, meta);
  },
  onCloseComplete: () => {
    if (!reader.isOpen()) {
      shelf.setOverlayOpen(false);
    }
  }
});

function syncHeroSaveState() {
  if (!heroBook) return;
  const saved = isSaved(heroBook.identifier);
  heroSaveBtnEl.classList.toggle('is-saved', saved);
  heroSaveLblEl.textContent = saved ? 'Đã lưu ✓' : 'Lưu sách';
}

function syncHeroReadState() {
  if (!heroBook) return;
  const prog = getProgress(heroBook.identifier);
  if (prog && prog.verified) {
    const pct = Math.max(1, Math.min(100, Math.round((prog.ratio || 0) * 100)));
    heroReadLblEl.textContent = `Đọc tiếp (${pct}%)`;
  } else {
    heroReadLblEl.textContent = 'Đọc ngay';
  }
}

function syncSidebarActiveHighlight() {
  sideNewListEl.querySelectorAll('.side-item').forEach((row) => {
    row.classList.toggle('is-active', Boolean(heroBook && row.dataset.bookId === heroBook.identifier));
  });
}

function formatPopularityStat(book) {
  if (!book) return '';
  if (state.sort === 'week desc' && book.week > 0) {
    return `${book.week.toLocaleString('vi-VN')} lượt/tuần`;
  }
  if (state.sort === 'month desc' && book.month > 0) {
    return `${book.month.toLocaleString('vi-VN')} lượt/tháng`;
  }
  if (book.downloads > 0) {
    return `${book.downloads.toLocaleString('vi-VN')} lượt đọc`;
  }
  return '';
}

function syncHero(book) {
  if (!book) return;
  heroBook = book;
  if (heroBookId === book.identifier) {
    syncHeroSaveState();
    syncHeroReadState();
    syncSidebarActiveHighlight();
    return;
  }
  heroBookId = book.identifier;

  heroTagsEl.innerHTML = '';
  const popStat = formatPopularityStat(book);
  const tags = [
    popStat || 'Tuyển chọn',
    book.genreLabel || 'Sách mở',
    [book.langCode, book.year].filter(Boolean).join(' · ')
  ].filter(Boolean);
  for (const label of tags) {
    const pill = document.createElement('span');
    pill.className = 'hero-tag';
    pill.textContent = label;
    heroTagsEl.appendChild(pill);
  }

  heroTitleEl.textContent = book.title;
  heroAuthorEl.textContent = book.creator || 'Khuyết danh';
  heroDescEl.textContent =
    book.description ||
    'Ấn bản in nguyên bản chất lượng cao — hỗ trợ thu phóng, xem 1–2 trang, nhiều trang và đọc thành tiếng.';

  heroCoverEl.setAttribute('aria-label', `Mở chi tiết sách ${book.title}`);
  renderCover(heroCoverEl, book, { eager: true, size: 'w500' });
  syncHeroSaveState();
  syncHeroReadState();
  syncSidebarActiveHighlight();
}

function formatCompactCount(num) {
  const n = Number(num) || 0;
  if (n >= 1_000_000) {
    const v = (n / 1_000_000).toFixed(1).replace(/\.0$/, '');
    return `${v}M`;
  }
  if (n >= 1_000) {
    const v = (n / 1_000).toFixed(1).replace(/\.0$/, '');
    return `${v}K`;
  }
  return n.toLocaleString('vi-VN');
}

function renderSidebarTrending(items) {
  const source = items && items.length > 0 ? items : seedBooks;
  const topItems = source.slice(0, 8);
  sideNewListEl.innerHTML = '';

  const frag = document.createDocumentFragment();
  for (const book of topItems) {
    const row = document.createElement('div');
    row.className = `side-item ${heroBook && heroBook.identifier === book.identifier ? 'is-active' : ''}`;
    row.dataset.bookId = book.identifier;

    const thumb = document.createElement('div');
    thumb.className = 'side-thumb';
    renderCover(thumb, book, { eager: false, compact: true });

    const meta = document.createElement('div');
    meta.className = 'side-meta';

    const title = document.createElement('div');
    title.className = 'side-title';
    title.textContent = book.title;
    title.title = book.title;

    const author = document.createElement('div');
    author.className = 'side-author';
    const weekStat = book.week > 0
      ? `${formatCompactCount(book.week)}/tuần`
      : book.downloads > 0
        ? `${formatCompactCount(book.downloads)} lượt`
        : '';
    const authorLine = [book.creator || 'Khuyết danh', weekStat].filter(Boolean).join(' · ');
    author.textContent = authorLine;
    author.title = authorLine;

    meta.appendChild(title);
    meta.appendChild(author);

    const bmBtn = document.createElement('button');
    bmBtn.type = 'button';
    const saved = isSaved(book.identifier);
    bmBtn.className = `side-bm-btn ${saved ? 'is-saved' : ''}`;
    bmBtn.dataset.saveId = book.identifier;
    bmBtn.setAttribute('aria-label', saved ? 'Bỏ lưu sách' : 'Lưu sách');
    bmBtn.innerHTML = BOOKMARK_SVG;
    bmBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSave(book);
    });

    row.appendChild(thumb);
    row.appendChild(meta);
    row.appendChild(bmBtn);

    row.addEventListener('click', () => {
      syncHero(book);
      shelf.focusBook(book.identifier);
      openBookDetail(book, thumb);
    });

    frag.appendChild(row);
  }

  sideNewListEl.appendChild(frag);
}

async function loadWeeklyTrending() {
  try {
    const { items } = await fetchArchiveBooksPage({
      genre: 'all',
      lang: 'all',
      era: 'all',
      author: 'all',
      sort: 'week desc',
      query: '',
      page: 1,
      rows: 16
    });
    if (items.length > 0) {
      trendingBooks = items;
      renderSidebarTrending(trendingBooks);
    }
  } catch {
    // Keep seed fallback in sidebar if offline
  }
}

function formatReadDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${h}g ${m}p đọc` : `${h} giờ đọc`;
  }
  if (s >= 60) {
    return `${Math.floor(s / 60)} phút đọc`;
  }
  return s > 0 ? `${s}s đọc` : 'Vừa mở';
}

function renderSidebarProgress() {
  const recent = getRecentProgress();
  sideProgressMetaEl.textContent = recent.length > 0 ? `${recent.length} cuốn` : 'Chưa có';
  sideProgressListEl.innerHTML = '';

  if (recent.length === 0) {
    const emptyBox = document.createElement('div');
    emptyBox.className = 'prog-empty-box';
    emptyBox.innerHTML = `
      <svg class="prog-empty-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
      </svg>
      <span class="prog-empty-text">Chưa có sách đang đọc dở</span>
    `;
    sideProgressListEl.appendChild(emptyBox);
    syncResumeBar();
    return;
  }

  const frag = document.createDocumentFragment();
  for (const book of recent) {
    const pct = Math.max(1, Math.min(100, Math.round((book.ratio || 0) * 100)));
    const row = document.createElement('div');
    row.className = 'prog-item';
    row.dataset.btn = '1';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Đọc tiếp ${book.title}`);

    const thumb = document.createElement('div');
    thumb.className = 'side-thumb';
    renderCover(thumb, book, { eager: false, compact: true });

    const body = document.createElement('div');
    body.className = 'prog-body';

    const top = document.createElement('div');
    top.className = 'prog-top';

    const title = document.createElement('span');
    title.className = 'side-title';
    title.textContent = book.title;
    title.title = book.title;

    const pctEl = document.createElement('span');
    pctEl.className = 'prog-pct';
    pctEl.textContent = `${pct}%`;

    top.appendChild(title);
    top.appendChild(pctEl);

    const detailLine = document.createElement('span');
    detailLine.className = 'side-author';
    const detailText = [book.posLabel || book.creator, formatReadDuration(book.readSeconds)]
      .filter(Boolean)
      .join(' · ');
    detailLine.textContent = detailText;
    detailLine.title = detailText;

    const track = document.createElement('div');
    track.className = 'prog-track';
    const fill = document.createElement('div');
    fill.className = 'prog-fill';
    fill.style.setProperty('--prog', `${pct}%`);
    track.appendChild(fill);

    body.appendChild(top);
    body.appendChild(detailLine);
    body.appendChild(track);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'prog-del-btn';
    delBtn.dataset.btn = '1';
    delBtn.setAttribute('aria-label', `Xoá ${book.title} khỏi danh sách đang đọc`);
    delBtn.textContent = '×';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeProgress(book.identifier);
    });

    row.appendChild(thumb);
    row.appendChild(body);
    row.appendChild(delBtn);

    row.addEventListener('click', () => {
      syncHero(book);
      openBookReader(book, null);
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        syncHero(book);
        openBookReader(book, null);
      }
    });

    frag.appendChild(row);
  }

  sideProgressListEl.appendChild(frag);
  syncResumeBar();
}

function createGridCardEl(book) {
  const card = document.createElement('article');
  card.className = 'grid-card';
  card.dataset.bookId = book.identifier;

  const coverBtn = document.createElement('button');
  coverBtn.type = 'button';
  coverBtn.className = 'grid-cover';
  coverBtn.setAttribute('aria-label', `Mở sách ${book.title}`);
  renderCover(coverBtn, book, { eager: false, size: 'w250' });

  const genrePill = document.createElement('span');
  genrePill.className = 'grid-genre-pill';
  genrePill.textContent = book.genreLabel || 'Sách';
  coverBtn.appendChild(genrePill);

  const foot = document.createElement('div');
  foot.className = 'grid-foot';

  const info = document.createElement('div');
  info.className = 'grid-info';

  const titleEl = document.createElement('h3');
  titleEl.className = 'grid-title';
  titleEl.textContent = book.title;
  titleEl.title = book.title;

  const authorEl = document.createElement('div');
  authorEl.className = 'grid-author';
  authorEl.textContent = book.creator || 'Khuyết danh';
  authorEl.title = book.creator || 'Khuyết danh';

  const metaEl = document.createElement('div');
  metaEl.className = 'grid-meta';
  const popStat = formatPopularityStat(book);
  metaEl.textContent = [book.year, book.langCode, popStat].filter(Boolean).join(' · ') || 'Bản in gốc';

  info.appendChild(titleEl);
  info.appendChild(authorEl);
  info.appendChild(metaEl);

  const saved = isSaved(book.identifier);
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = `grid-save-btn ${saved ? 'is-saved' : ''}`;
  saveBtn.setAttribute('aria-label', saved ? 'Bỏ lưu sách' : 'Lưu sách');
  saveBtn.innerHTML = BOOKMARK_SVG;
  saveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSave(book);
  });

  foot.appendChild(info);
  foot.appendChild(saveBtn);

  card.appendChild(coverBtn);
  card.appendChild(foot);

  card.addEventListener('click', () => {
    syncHero(book);
    shelf.focusBook(book.identifier);
    openBookDetail(book, coverBtn);
  });

  return card;
}

function syncGridBooks(items, { append = false, hasMore = false } = {}) {
  if (!append) {
    gridListEl.innerHTML = '';
    gridSeenIds.clear();
    gridViewEl.scrollTop = 0;
  }

  const frag = document.createDocumentFragment();
  for (const book of items) {
    if (!book || gridSeenIds.has(book.identifier)) continue;
    gridSeenIds.add(book.identifier);
    frag.appendChild(createGridCardEl(book));
  }
  gridListEl.appendChild(frag);
  gridMoreWrapEl.hidden = !hasMore || gridSeenIds.size === 0;
  gridMoreBtnEl.textContent = loadingMore ? 'Đang tải thêm…' : 'Tải thêm sách';
}

function refreshSavedStatesInLists() {
  gridListEl.querySelectorAll('.grid-card').forEach((card) => {
    const id = card.dataset.bookId;
    const btn = card.querySelector('.grid-save-btn');
    if (btn && id) {
      const saved = isSaved(id);
      btn.classList.toggle('is-saved', saved);
      btn.setAttribute('aria-label', saved ? 'Bỏ lưu sách' : 'Lưu sách');
    }
  });
  sideNewListEl.querySelectorAll('.side-bm-btn').forEach((btn) => {
    const id = btn.dataset.saveId;
    if (id) {
      const saved = isSaved(id);
      btn.classList.toggle('is-saved', saved);
      btn.setAttribute('aria-label', saved ? 'Bỏ lưu sách' : 'Lưu sách');
    }
  });
  syncHeroSaveState();
}

function setViewLayout(nextLayout, { persist = true } = {}) {
  state.layout = nextLayout === 'grid' ? 'grid' : 'shelf';
  if (persist) {
    setPrefs({ layout: state.layout });
  }
  const isGrid = state.layout === 'grid';

  viewShelfBtn.classList.toggle('active', !isGrid);
  viewGridBtn.classList.toggle('active', isGrid);
  shelfSectionEl.hidden = isGrid;
  gridViewEl.hidden = !isGrid;
  shelf.setLayoutMode(state.layout);
}

function updateCatalogHeading() {
  const q = state.query.trim();
  if (q) {
    catalogHeadingEl.textContent = `Kết quả cho "${q}"`;
  } else {
    catalogHeadingEl.textContent = GENRE_TITLES[state.genre] || 'Kho sách đề xuất';
  }
}

function syncAuthorDropdown(items) {
  let added = false;
  for (const item of items) {
    const raw = String(item.creator || '').split(/[·;,]/)[0].trim();
    if (!raw || raw === 'Khuyết danh' || raw.length > 42 || knownAuthors.has(raw)) continue;
    knownAuthors.add(raw);
    added = true;
  }
  if (!added) return;
  const curVal = authorSelect.value;
  const sorted = [...knownAuthors].sort((a, b) => a.localeCompare(b, 'vi'));
  authorSelect.innerHTML = '<option value="all">Tất cả tác giả</option>';
  for (const name of sorted) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    authorSelect.appendChild(opt);
  }
  if (curVal !== 'all' && knownAuthors.has(curVal)) {
    authorSelect.value = curVal;
  }
}

function updateTabIndicator() {
  tabBtns.forEach((btn) => {
    const isAct = btn.dataset.genre === state.genre;
    btn.classList.toggle('active', isAct);
    if (isAct) {
      tabInd.style.width = `${btn.offsetWidth}px`;
      tabInd.style.transform = `translateX(${btn.offsetLeft}px)`;
    }
  });
}

function updateSavedCountBadge() {
  const n = getSaved().length;
  savedCountEl.textContent = n > 0 ? ` (${n})` : '';
}

function updateFilterBadge() {
  const activeCount =
    (state.era !== 'all' ? 1 : 0) +
    (state.author !== 'all' ? 1 : 0);
  filterToggleBtn.textContent = activeCount > 0 ? `Bộ lọc (${activeCount})` : 'Bộ lọc';
  filterToggleBtn.classList.toggle('is-filtered', activeCount > 0);
}

function mergeCatalogBooks(items, append) {
  if (!append) {
    catalogBooks = Array.isArray(items) ? [...items] : [];
    return;
  }
  const seen = new Set(catalogBooks.map((b) => b.identifier));
  for (const b of items) {
    if (b && !seen.has(b.identifier)) {
      seen.add(b.identifier);
      catalogBooks.push(b);
    }
  }
}

async function refreshShelf({ initialIndex = 0, animateSlide = true, syncHeroOnLoad = true } = {}) {
  if (searchAbort) searchAbort.abort();
  if (moreAbort) moreAbort.abort();
  loadingMore = false;
  searchAbort = new AbortController();
  state.page = 1;
  updateCatalogHeading();

  gridListEl.innerHTML = '';
  gridSeenIds.clear();
  gridMoreWrapEl.hidden = true;

  shelf.setStatus(
    'loading',
    state.query.trim()
      ? `Đang tìm "${state.query.trim()}" trong kho sách…`
      : 'Đang tải kho sách…'
  );

  try {
    const { items, numFound, hasMore } = await fetchArchiveBooksPage({
      genre: state.genre,
      lang: state.lang,
      era: state.era,
      author: state.author,
      sort: state.sort,
      query: state.query,
      page: 1,
      rows: 60,
      savedList: getSaved(),
      signal: searchAbort.signal
    });

    state.hasMore = hasMore;
    archiveTotalEl.textContent = `${numFound.toLocaleString('vi-VN')} đầu sách`;
    mergeCatalogBooks(items, false);
    syncAuthorDropdown(items);

    if (items.length === 0) {
      if (state.genre === 'saved') {
        shelf.setStatus('empty', 'Bạn chưa lưu cuốn sách nào. Nhấn biểu tượng lưu trên sách để thêm vào đây.', 'explore');
      } else {
        shelf.setStatus('empty', 'Không có sách nào khớp bộ lọc hiện tại.');
      }
      syncGridBooks([], { append: false, hasMore: false });
    } else {
      shelf.setBooks(items, { initialIndex, animateSlide, hasMore, notifyActive: syncHeroOnLoad });
      syncGridBooks(items, { append: false, hasMore });
      if (syncHeroOnLoad) {
        const pick = items[Math.min(initialIndex, items.length - 1)];
        syncHero(pick);
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (seedBooks.length > 0 && state.genre === 'all' && !state.query.trim()) {
      mergeCatalogBooks(seedBooks, false);
      shelf.setBooks(seedBooks, { initialIndex: 0, animateSlide: false, hasMore: false, notifyActive: false });
      syncGridBooks(seedBooks, { append: false, hasMore: false });
      archiveTotalEl.textContent = `${seedBooks.length} đầu sách (ngoại tuyến)`;
    } else {
      mergeCatalogBooks([], false);
      syncGridBooks([], { append: false, hasMore: false });
      archiveTotalEl.textContent = '0 đầu sách';
      shelf.setStatus('error', 'Không kết nối được tới máy chủ kho sách. Vui lòng kiểm tra mạng và thử lại.');
    }
  }
}

let nextLoadAllowedAt = 0;

async function loadNextPage() {
  if (loadingMore || !state.hasMore || state.genre === 'saved') return;
  if (Date.now() < nextLoadAllowedAt) return;
  loadingMore = true;
  gridMoreBtnEl.textContent = 'Đang tải thêm…';
  moreAbort = new AbortController();
  const nextPage = state.page + 1;

  try {
    const { items, hasMore } = await fetchArchiveBooksPage({
      genre: state.genre,
      lang: state.lang,
      era: state.era,
      author: state.author,
      sort: state.sort,
      query: state.query,
      page: nextPage,
      rows: 60,
      savedList: getSaved(),
      signal: moreAbort.signal
    });
    state.page = nextPage;
    state.hasMore = hasMore;
    mergeCatalogBooks(items, true);
    syncAuthorDropdown(items);
    shelf.appendBooks(items, { hasMore });
    syncGridBooks(items, { append: true, hasMore });
    nextLoadAllowedAt = 0;
  } catch {
    // Cooldown 10s on failure to avoid bombarding Archive
    nextLoadAllowedAt = Date.now() + 10_000;
  } finally {
    loadingMore = false;
    gridMoreBtnEl.textContent = 'Tải thêm sách';
  }
}

function resetCatalogFilters() {
  state.lang = 'all';
  state.era = 'all';
  state.author = 'all';
  state.sort = 'downloads desc';
  langSelect.value = 'all';
  authorSelect.value = 'all';
  sortSelect.value = 'downloads desc';
  langSelect.classList.remove('is-filtered');
  eraBtns.forEach((b) => b.classList.toggle('active', b.dataset.era === 'all'));
  updateFilterBadge();
  refreshShelf({ initialIndex: 0, animateSlide: true, syncHeroOnLoad: false });
}

function resetAllFilters() {
  state.genre = 'all';
  state.query = '';
  searchInput.value = '';
  searchClearBtn.hidden = true;
  updateTabIndicator();
  resetCatalogFilters();
}

function stepHeroBook(delta) {
  if (state.layout === 'shelf' && catalogBooks.length > 0) {
    shelf.stepBy(delta);
    return;
  }
  const pool = catalogBooks.length > 0 ? catalogBooks : seedBooks;
  if (pool.length === 0) return;
  const curIdx = heroBook ? pool.findIndex((b) => b.identifier === heroBook.identifier) : 0;
  const nextIdx = ((curIdx >= 0 ? curIdx : 0) + delta + pool.length) % pool.length;
  const nextBook = pool[nextIdx];
  syncHero(nextBook);
  shelf.focusBook(nextBook.identifier, { immediate: true });
}

// Hero interactions
heroReadBtnEl.addEventListener('click', () => {
  if (heroBook) openBookReader(heroBook);
});

heroSaveBtnEl.addEventListener('click', () => {
  if (heroBook) toggleSave(heroBook);
});

heroDetailBtnEl.addEventListener('click', () => {
  if (heroBook) openBookDetail(heroBook, heroCoverEl);
});

heroCoverEl.addEventListener('click', () => {
  if (heroBook) openBookDetail(heroBook, heroCoverEl);
});

heroPrevBtnEl.addEventListener('click', () => stepHeroBook(-1));
heroNextBtnEl.addEventListener('click', () => stepHeroBook(1));

// Bounded Catalog View Switcher (swaps #shelf <-> #gridView inside #catalogBody)
viewShelfBtn.addEventListener('click', () => setViewLayout('shelf'));
viewGridBtn.addEventListener('click', () => setViewLayout('grid'));
gridMoreBtnEl.addEventListener('click', () => loadNextPage());

if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting) && state.layout === 'grid') {
        loadNextPage();
      }
    },
    { root: gridViewEl, rootMargin: '280px' }
  );
  io.observe(gridMoreWrapEl);
}

langSelect.addEventListener('change', () => {
  state.lang = langSelect.value;
  langSelect.classList.toggle('is-filtered', state.lang !== 'all');
  refreshShelf({ initialIndex: 0, animateSlide: true, syncHeroOnLoad: false });
});

tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (detail.isOpen() || reader.isOpen()) return;
    state.genre = btn.dataset.genre;
    updateTabIndicator();
    if (typeof btn.scrollIntoView === 'function') {
      btn.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    }
    refreshShelf({ initialIndex: 0, animateSlide: true, syncHeroOnLoad: true });
  });
});

searchInput.addEventListener('input', () => {
  state.query = searchInput.value;
  searchClearBtn.hidden = !searchInput.value;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    refreshShelf({ initialIndex: 0, animateSlide: true, syncHeroOnLoad: false });
  }, 350);
});

searchClearBtn.addEventListener('click', () => {
  searchInput.value = '';
  state.query = '';
  searchClearBtn.hidden = true;
  refreshShelf({ initialIndex: 0, animateSlide: true, syncHeroOnLoad: false });
  searchInput.focus();
});

function toggleFilterDrawer(force) {
  filterBarOpen = typeof force === 'boolean' ? force : !filterBarOpen;
  filterDrawer.classList.toggle('is-open', filterBarOpen);
  filterToggleBtn.classList.toggle('active', filterBarOpen);
}

filterToggleBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleFilterDrawer();
});

document.addEventListener('click', (e) => {
  if (filterBarOpen && filterAnchorEl && !filterAnchorEl.contains(e.target)) {
    toggleFilterDrawer(false);
  }
});

eraBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    state.era = btn.dataset.era;
    eraBtns.forEach((b) => b.classList.toggle('active', b === btn));
    updateFilterBadge();
    refreshShelf({ initialIndex: 0, animateSlide: true, syncHeroOnLoad: false });
  });
});

sortSelect.addEventListener('change', () => {
  state.sort = sortSelect.value;
  refreshShelf({ initialIndex: 0, animateSlide: true, syncHeroOnLoad: false });
});

authorSelect.addEventListener('change', () => {
  state.author = authorSelect.value;
  updateFilterBadge();
  refreshShelf({ initialIndex: 0, animateSlide: true, syncHeroOnLoad: false });
});

filterResetBtn.addEventListener('click', () => {
  resetCatalogFilters();
  toggleFilterDrawer(false);
});

document.getElementById('prevBtn').addEventListener('click', () => shelf.stepBy(-1));
document.getElementById('nextBtn').addEventListener('click', () => shelf.stepBy(1));

window.addEventListener('kesach:saved-change', () => {
  updateSavedCountBadge();
  shelf.refreshSavedRibbons();
  refreshSavedStatesInLists();
  if (state.genre === 'saved') {
    refreshShelf({ initialIndex: 0, animateSlide: false });
  }
});

window.addEventListener('kesach:progress-change', () => {
  renderSidebarProgress();
  syncHeroReadState();
});

window.addEventListener('resize', updateTabIndicator);

window.addEventListener('keydown', (e) => {
  const activeEl = document.activeElement;
  const activeTag = activeEl && activeEl.tagName;
  const isTextInput =
    (activeTag === 'INPUT' && activeEl.type !== 'range') ||
    activeTag === 'TEXTAREA' ||
    activeTag === 'SELECT';

  if (e.key === 'Escape') {
    if (reader.isOpen()) {
      if (reader.isImmersive()) {
        reader.exitImmersive();
      } else if (reader.isThumbMode()) {
        reader.setPageLayout('thumbs');
      } else {
        reader.close();
      }
      return;
    }
    if (detail.isOpen()) {
      detail.close();
      return;
    }
    if (filterBarOpen) {
      toggleFilterDrawer(false);
      return;
    }
    if (document.activeElement === searchInput) {
      searchInput.blur();
      return;
    }
  }

  if (isTextInput) return;

  if (reader.isOpen()) {
    if (e.key === ' ' && (activeTag === 'BUTTON' || activeTag === 'A')) {
      return; // allow focused buttons to be triggered with Space
    }
    if (e.key === 'ArrowRight' || e.key === ' ') {
      e.preventDefault();
      reader.stepPage(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      reader.stepPage(-1);
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      reader.zoomBy(0.25);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      reader.zoomBy(-0.25);
    } else if (e.key === '0') {
      e.preventDefault();
      reader.resetZoom();
    } else if (e.key === '1') {
      reader.setPageLayout('single');
    } else if (e.key === '2') {
      reader.setPageLayout('double');
    } else if (e.key === '3') {
      reader.setPageLayout('thumbs');
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      reader.toggleImmersive();
    }
    return;
  }

  if (detail.isOpen()) return;

  if (e.key === '/') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  } else if (e.key === 'ArrowLeft') {
    stepHeroBook(-1);
  } else if (e.key === 'ArrowRight') {
    stepHeroBook(1);
  } else if (
    state.layout === 'shelf' &&
    e.key === 'Enter' &&
    (document.activeElement === document.body || document.activeElement === shelfSectionEl)
  ) {
    const book = shelf.getActiveBook();
    if (book) openBookDetail(book, null);
  }
});

window.addEventListener('hashchange', () => {
  const hash = window.location.hash || '';
  if (hash.startsWith('#read/')) {
    const rawId = decodeURIComponent(hash.slice(6)).trim();
    if (rawId && (!reader.isOpen() || (heroBook && heroBook.identifier !== rawId))) {
      resumeReaderForId(rawId, { immediate: false });
    }
  } else if (reader.isOpen()) {
    reader.close();
  }
});

async function init() {
  await hydrateStore();
  updateSavedCountBadge();
  setViewLayout(state.layout, { persist: false });
  updateTabIndicator();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(updateTabIndicator);
  }

  // Register PWA Service Worker for offline app shell and scan page caching
  if (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    (window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  seedBooks = await loadSeedCatalog();
  if (seedBooks.length > 0) {
    mergeCatalogBooks(seedBooks, false);
    syncAuthorDropdown(seedBooks);
    renderSidebarTrending(seedBooks);
    renderSidebarProgress();
    syncResumeBar();
    shelf.setBooks(seedBooks, { initialIndex: 5, animateSlide: false, hasMore: true, notifyActive: false });
    syncGridBooks(seedBooks, { append: false, hasMore: true });
    syncHero(seedBooks[5] || seedBooks[0]);
  } else {
    renderSidebarProgress();
    syncResumeBar();
  }

  // Resume reading mode immediately if URL hash points to a book (e.g. after reload F5)
  const initialHash = window.location.hash || '';
  if (initialHash.startsWith('#read/')) {
    const rawId = decodeURIComponent(initialHash.slice(6)).trim();
    if (rawId) {
      resumeReaderForId(rawId, { immediate: true });
    }
  }

  // Load independent weekly-trending feed for "Sách nổi bật"
  loadWeeklyTrending();

  try {
    const { items, numFound, hasMore } = await fetchArchiveBooksPage({
      genre: 'all',
      lang: 'all',
      era: 'all',
      author: 'all',
      sort: 'downloads desc',
      query: '',
      page: 1,
      rows: 24,
      savedList: getSaved()
    });
    if (!searchAbort) {
      state.hasMore = hasMore;
      archiveTotalEl.textContent = `${numFound.toLocaleString('vi-VN')} đầu sách`;
      mergeCatalogBooks(items, false);
      syncAuthorDropdown(items);
      if (items.length > 0) {
        shelf.setBooks(items, { initialIndex: 0, animateSlide: false, hasMore, notifyActive: false });
        syncGridBooks(items, { append: false, hasMore });
      }
    }
  } catch {
    archiveTotalEl.textContent = `${catalogBooks.length} đầu sách`;
  }
}

init();
