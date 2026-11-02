import {
  fetchItemMetadata,
  resolveLeafCount,
  buildScanPageUrl,
  fetchLeafSpeechText,
  getBookOcrData,
  stripMarks
} from './archive.js';
import { getProgress, setProgress, getPrefs, setPrefs } from './store.js';

const VERIFY_DWELL_SEC = 5;
const IDLE_LIMIT_MS = 90_000;
const MIN_ZOOM = 0.75;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.25;

const VOICE_BCP47 = {
  VIE: 'vi-VN',
  ENG: 'en-US',
  FRA: 'fr-FR',
  ZHO: 'zh-CN',
  JPN: 'ja-JP',
  DEU: 'de-DE',
  SPA: 'es-ES',
  RUS: 'ru-RU'
};

function splitSpeechChunks(text, maxLen = 230) {
  const sentences = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?…;:\n])\s+/);
  const chunks = [];
  let cur = '';
  for (const part of sentences) {
    if (!part) continue;
    if ((cur + ' ' + part).trim().length <= maxLen) {
      cur = (cur + ' ' + part).trim();
    } else {
      if (cur) chunks.push(cur);
      if (part.length <= maxLen) {
        cur = part;
      } else {
        for (let i = 0; i < part.length; i += maxLen) {
          chunks.push(part.slice(i, i + maxLen));
        }
        cur = '';
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let availableVoices = [];
function refreshVoices() {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    availableVoices = window.speechSynthesis.getVoices() || [];
  }
}
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  refreshVoices();
  window.speechSynthesis.onvoiceschanged = refreshVoices;
}

export function createReader({
  readerEl,
  closeBtnEl,
  titleBarEl,
  view1BtnEl,
  view2BtnEl,
  viewThumbBtnEl,
  ttsBtnEl,
  zoomOutBtnEl,
  zoomResetBtnEl,
  zoomInBtnEl,
  expandBtnEl,
  sidePrevBtnEl,
  sideNextBtnEl,
  scanFrameWrapEl,
  bookStageEl,
  spreadEl,
  leafLeftEl,
  leafRightEl,
  thumbGridEl,
  scanIframeEl,
  stateBoxEl,
  stateMsgEl,
  prevPageBtnEl,
  nextPageBtnEl,
  pageInfoEl,
  pageRangeEl,
  isReducedMotion,
  onCloseReader
}) {
  let isOpen = false;
  let isImmersive = false;
  let currentBook = null;
  let currentMeta = null;

  let scanLeaf = 0;
  let scanTotal = 0;
  let scanFallbackIframe = false;
  let renderedThumbBookId = '';

  let prefs = getPrefs();
  let pageLayout = prefs.pageLayout === 'single' ? 'single' : 'double'; // 'single' | 'double' | 'thumbs'
  let lastPageLayout = pageLayout; // remembers 'single' or 'double' when toggling 'thumbs'
  let zoom = 1;

  // Read Aloud (Sách đọc) state
  let isSpeaking = false;
  let isTtsPaused = false;
  let ttsRate = 1.0;
  let ttsSessionId = 0;
  let ttsAbort = null;
  let activeUtterance = null;
  let statusNoticeTimer = null;
  let lastTurnDir = 1;

  // Bookmarks, Notes & Secondary OCR Text Viewer state
  let bookBookmarks = [];
  let bookNotes = {};
  let textFontSize = 18;
  let textTheme = 'light';

  const bookmarkBtnEl = document.getElementById('rdrBookmarkBtn');
  const noteBtnEl = document.getElementById('rdrNoteBtn');
  const searchBtnEl = document.getElementById('rdrSearchBtn');
  const textAltBtnEl = document.getElementById('rdrTextAltBtn');

  const searchBoxEl = document.getElementById('rdrSearchBox');
  const searchInpEl = document.getElementById('rdrSearchInp');
  const searchGoBtnEl = document.getElementById('rdrSearchGoBtn');
  const searchCloseBtnEl = document.getElementById('rdrSearchCloseBtn');
  const searchResultsEl = document.getElementById('rdrSearchResults');

  const notePopEl = document.getElementById('rdrNotePop');
  const notePopTitleEl = document.getElementById('rdrNotePopTitle');
  const noteTextEl = document.getElementById('rdrNoteText');
  const noteSaveBtnEl = document.getElementById('rdrNoteSaveBtn');
  const notePopCloseEl = document.getElementById('rdrNotePopClose');

  const textViewerEl = document.getElementById('rdrTextViewer');
  const textBodyEl = document.getElementById('rdrTextBody');
  const textCloseBtnEl = document.getElementById('rdrTextCloseBtn');
  const textFontUpEl = document.getElementById('rdrTextFontUp');
  const textFontDownEl = document.getElementById('rdrTextFontDown');
  const textThemeBtnEl = document.getElementById('rdrTextThemeBtn');

  // Panning state when zoom > 1
  let isPanning = false;
  let panMoved = false;
  let panStartX = 0;
  let panStartY = 0;
  let panScrollLeft = 0;
  let panScrollTop = 0;

  let loadAbort = null;
  let sheetAnim = null;
  let pageTurnAnim = null;
  let lastSnap = null; // ảnh chụp trạng thái trang TRƯỚC khi đổi (dùng cho hiệu ứng lật)
  let flipCleanup = null;
  let flipToken = 0;
  let wheelCooldown = false;

  // Verified reading session state ("xác định đọc thật")
  let bookReady = false;
  let sessionVerified = false;
  let dwellSecThisOpen = 0;
  let unflushedSec = 0;
  let lastActivityAt = Date.now();
  let heartbeatId = null;

  function markActivity() {
    lastActivityAt = Date.now();
  }

  function currentScanState(atLeaf = scanLeaf) {
    const activeMode = pageLayout === 'thumbs' ? lastPageLayout : pageLayout;
    const useDouble = activeMode === 'double' && atLeaf > 0 && scanTotal > 1;
    const leftLeaf = useDouble ? (atLeaf % 2 === 0 ? atLeaf - 1 : atLeaf) : atLeaf;
    const rightLeaf = useDouble && leftLeaf + 1 < scanTotal ? leftLeaf + 1 : -1;
    const endLeaf = rightLeaf >= 0 ? rightLeaf : leftLeaf;
    const ratio = scanTotal > 0 ? Math.min(1, (endLeaf + 1) / scanTotal) : 0;
    const posLabel = rightLeaf >= 0
      ? `Trang ${leftLeaf + 1}–${rightLeaf + 1} / ${scanTotal}`
      : leftLeaf === 0 && scanTotal > 1
        ? `Trang bìa (1 / ${scanTotal})`
        : `Trang ${leftLeaf + 1} / ${Math.max(1, scanTotal)}`;
    return { useDouble, leftLeaf, rightLeaf, endLeaf, ratio, posLabel };
  }

  function syncPageInfoLabel(prefix = '') {
    if (scanFallbackIframe) {
      pageInfoEl.textContent = 'BẢN IN GỐC';
      return;
    }
    if (scanTotal <= 0) return;
    const { ratio, posLabel } = currentScanState();
    const pct = Math.max(1, Math.min(100, Math.round(ratio * 100)));
    const head = prefix ? `${prefix} · ` : '';
    pageInfoEl.textContent = `${head}${posLabel.toUpperCase()} · ${pct}%`;
  }

  function flashStatusNotice(msg, durationMs = 2800) {
    clearTimeout(statusNoticeTimer);
    pageInfoEl.textContent = msg;
    statusNoticeTimer = setTimeout(() => {
      syncPageInfoLabel(isSpeaking ? 'ĐANG ĐỌC' : '');
    }, durationMs);
  }

  function syncToolbarState() {
    const nativeReady = !scanFallbackIframe && scanTotal > 0;
    const isThumbs = pageLayout === 'thumbs';

    view1BtnEl.classList.toggle('active', nativeReady && pageLayout === 'single');
    view2BtnEl.classList.toggle('active', nativeReady && pageLayout === 'double');
    viewThumbBtnEl.classList.toggle('active', nativeReady && isThumbs);

    view1BtnEl.disabled = !nativeReady;
    view2BtnEl.disabled = !nativeReady || scanTotal <= 1;
    viewThumbBtnEl.disabled = !nativeReady || scanTotal <= 1;

    ttsBtnEl.disabled = !nativeReady || typeof window === 'undefined' || !('speechSynthesis' in window);
    ttsBtnEl.classList.toggle('is-speaking', isSpeaking && !isTtsPaused);
    ttsBtnEl.classList.toggle('is-paused', isSpeaking && isTtsPaused);
    ttsBtnEl.title = isSpeaking
      ? (isTtsPaused ? 'Tiếp tục đọc thành tiếng' : 'Tạm dừng đọc thành tiếng')
      : 'Sách đọc — Đọc thành tiếng';

    zoomResetBtnEl.textContent = `${Math.round(zoom * 100)}%`;
    zoomOutBtnEl.disabled = !nativeReady || isThumbs || zoom <= MIN_ZOOM;
    zoomInBtnEl.disabled = !nativeReady || isThumbs || zoom >= MAX_ZOOM;
    zoomResetBtnEl.disabled = !nativeReady || isThumbs || zoom === 1;

    expandBtnEl.classList.toggle('active', isImmersive);
    expandBtnEl.title = isImmersive ? 'Thoát toàn màn hình (Esc)' : 'Toàn màn hình (F)';

    sidePrevBtnEl.hidden = !nativeReady || isThumbs;
    sideNextBtnEl.hidden = !nativeReady || isThumbs;
    prevPageBtnEl.hidden = !nativeReady;
    nextPageBtnEl.hidden = !nativeReady;
    pageRangeEl.hidden = !nativeReady;

    if (bookmarkBtnEl) {
      bookmarkBtnEl.disabled = !nativeReady || isThumbs;
      const { leftLeaf, rightLeaf } = currentScanState();
      const isBm = bookBookmarks.includes(leftLeaf) || (rightLeaf >= 0 && bookBookmarks.includes(rightLeaf));
      bookmarkBtnEl.classList.toggle('active', isBm);
      bookmarkBtnEl.title = isBm ? 'Bỏ đánh dấu trang này' : 'Đánh dấu trang này';
    }
    if (noteBtnEl) {
      noteBtnEl.disabled = !nativeReady || isThumbs;
      const { leftLeaf, rightLeaf } = currentScanState();
      const hasNote = Boolean(bookNotes[leftLeaf] || (rightLeaf >= 0 && bookNotes[rightLeaf]));
      noteBtnEl.classList.toggle('active', hasNote);
      noteBtnEl.title = hasNote ? 'Xem hoặc sửa ghi chú trang' : 'Ghi chú trang này';
    }
    if (searchBtnEl) {
      searchBtnEl.disabled = !nativeReady;
    }
    if (textAltBtnEl) {
      textAltBtnEl.disabled = !nativeReady;
    }
  }

  function applyZoom(nextZoom) {
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(nextZoom * 100) / 100));
    spreadEl.style.setProperty('--zoom', String(zoom));
    bookStageEl.classList.toggle('is-zoomed', zoom > 1);
    if (zoom <= 1) {
      bookStageEl.scrollLeft = 0;
      bookStageEl.scrollTop = 0;
    } else if (currentBook && scanTotal > 0 && !scanFallbackIframe) {
      // Upgrade image resolution to 1600px when zoomed closely
      const { leftLeaf, rightLeaf } = currentScanState();
      const targetWidth = zoom >= 1.5 ? 1600 : 1200;
      leafLeftEl.src = buildScanPageUrl(currentBook.identifier, leftLeaf, targetWidth);
      if (rightLeaf >= 0) {
        leafRightEl.src = buildScanPageUrl(currentBook.identifier, rightLeaf, targetWidth);
      }
    }
    if (currentBook) {
      setProgress(currentBook, { zoom });
    }
    syncToolbarState();
  }

  function zoomBy(delta) {
    if (!isOpen || scanFallbackIframe || scanTotal <= 0 || pageLayout === 'thumbs') return;
    markActivity();
    applyZoom(zoom + delta);
  }

  function resetZoom() {
    if (!isOpen) return;
    markActivity();
    applyZoom(1);
  }

  function commitReadingProgress(forceVerify = false) {
    if (!currentBook) return;
    if (forceVerify) {
      sessionVerified = true;
    }
    if (!sessionVerified) return;

    const addSeconds = unflushedSec;
    unflushedSec = 0;

    if (scanTotal > 0 && !scanFallbackIframe) {
      const { leftLeaf, ratio, posLabel } = currentScanState();
      setProgress(currentBook, {
        mode: 'scan',
        scanLeaf: leftLeaf,
        scanTotal,
        ratio: Math.max(0.01, ratio),
        posLabel,
        addSeconds
      });
    } else {
      const prev = getProgress(currentBook.identifier);
      setProgress(currentBook, {
        mode: 'scan',
        ratio: prev && prev.ratio ? prev.ratio : 0.02,
        posLabel: prev && prev.posLabel ? prev.posLabel : 'Bản in gốc',
        addSeconds
      });
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatId = setInterval(() => {
      if (!isOpen || !bookReady) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (Date.now() - lastActivityAt > IDLE_LIMIT_MS && !isSpeaking) return;

      dwellSecThisOpen += 1;
      unflushedSec += 1;

      if (!sessionVerified && dwellSecThisOpen >= VERIFY_DWELL_SEC) {
        sessionVerified = true;
        commitReadingProgress(true);
      } else if (sessionVerified && unflushedSec >= 5) {
        commitReadingProgress(false);
      }
    }, 1000);
  }

  function stopHeartbeat() {
    if (heartbeatId) {
      clearInterval(heartbeatId);
      heartbeatId = null;
    }
  }

  // Read Aloud (Sách đọc — Web Speech API + Archive per-leaf OCR)
  function pickBestVoice(langCode) {
    if (typeof window === 'undefined' || !window.speechSynthesis) return { lang: 'vi-VN', voice: null };
    refreshVoices();
    const voices = availableVoices.length > 0 ? availableVoices : (window.speechSynthesis.getVoices() || []);
    const bcp = VOICE_BCP47[langCode] || 'vi-VN';
    const prefix = bcp.slice(0, 2).toLowerCase();

    // Ưu tiên giọng tự nhiên tiếng Việt (Google, Microsoft, Natural)
    let best = voices.find((v) => {
      const l = String(v.lang || '').toLowerCase();
      const n = String(v.name || '').toLowerCase();
      return l.startsWith(prefix) && (n.includes('natural') || n.includes('google') || n.includes('viet'));
    });
    if (!best) {
      best = voices.find((v) => String(v.lang || '').toLowerCase().startsWith(prefix));
    }
    return { lang: bcp, voice: best || null };
  }

  function stopSpeaking() {
    ttsSessionId += 1;
    isSpeaking = false;
    isTtsPaused = false;
    activeUtterance = null;
    if (ttsAbort) {
      ttsAbort.abort();
      ttsAbort = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore synthesis cancel errors
      }
    }
    syncToolbarState();
    syncPageInfoLabel('');
  }

  function speakChunkList(chunks, voiceInfo, sessionToken) {
    return new Promise((resolve) => {
      let idx = 0;
      function nextChunk() {
        if (!isSpeaking || sessionToken !== ttsSessionId || idx >= chunks.length) {
          resolve(sessionToken === ttsSessionId && isSpeaking);
          return;
        }
        const utter = new SpeechSynthesisUtterance(chunks[idx++]);
        utter.lang = voiceInfo.lang;
        if (voiceInfo.voice) utter.voice = voiceInfo.voice;
        utter.rate = ttsRate;
        activeUtterance = utter;
        utter.onend = () => nextChunk();
        utter.onerror = () => resolve(false);
        window.speechSynthesis.speak(utter);
      }
      nextChunk();
    });
  }

  async function runSpeechLoop(sessionToken) {
    if (!currentBook || scanTotal <= 0 || scanFallbackIframe) {
      stopSpeaking();
      return;
    }

    if (ttsAbort) ttsAbort.abort();
    ttsAbort = new AbortController();
    const { signal } = ttsAbort;

    syncToolbarState();
    syncPageInfoLabel('ĐANG TẢI GIỌNG ĐỌC');

    try {
      const meta = currentMeta || (await fetchItemMetadata(currentBook, signal));
      currentMeta = meta;
      if (signal.aborted || sessionToken !== ttsSessionId) return;

      if (!meta.pageIndexUrl && !meta.djvuTxtUrl) {
        stopSpeaking();
        flashStatusNotice('BẢN IN NÀY CHƯA CÓ LỚP CHỮ ĐỂ ĐỌC THÀNH TIẾNG', 3500);
        return;
      }

      // Skip past image-only cover/flyleaves (up to 8 leaves) to find readable text
      let combinedText = '';
      let skipped = 0;
      while (skipped <= 8 && isSpeaking && sessionToken === ttsSessionId) {
        const { leftLeaf, rightLeaf, endLeaf } = currentScanState();
        const leaves = rightLeaf >= 0 ? [leftLeaf, rightLeaf] : [leftLeaf];
        const parts = [];
        for (const lf of leaves) {
          const t = await fetchLeafSpeechText(meta, lf, scanTotal, signal);
          if (signal.aborted || sessionToken !== ttsSessionId) return;
          if (t && t.length >= 3) parts.push(t);
        }
        combinedText = parts.join('. ').trim();
        if (combinedText.length >= 4 || endLeaf >= scanTotal - 1) break;

        skipped += 1;
        scanLeaf = Math.min(scanTotal - 1, endLeaf + 1);
        renderScanSpread();
      }

      if (!combinedText || combinedText.length < 4) {
        stopSpeaking();
        flashStatusNotice('TRANG NÀY KHÔNG CÓ VĂN BẢN ĐỂ ĐỌC', 2800);
        return;
      }

      const voiceInfo = pickBestVoice(currentBook.langCode);
      const chunks = splitSpeechChunks(combinedText);
      syncPageInfoLabel('ĐANG ĐỌC');

      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
      }

      const completed = await speakChunkList(chunks, voiceInfo, sessionToken);
      if (!completed || !isSpeaking || sessionToken !== ttsSessionId) return;

      const { endLeaf } = currentScanState();
      if (endLeaf < scanTotal - 1) {
        scanLeaf = endLeaf + 1;
        renderScanSpread();
        commitReadingProgress(true);
        runSpeechLoop(sessionToken);
      } else {
        stopSpeaking();
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      stopSpeaking();
      flashStatusNotice('KHÔNG TẢI ĐƯỢC DỮ LIỆU ĐỌC THÀNH TIẾNG', 3000);
    }
  }

  function toggleTts() {
    if (!isOpen || scanFallbackIframe || scanTotal <= 0) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    markActivity();

    if (isSpeaking) {
      if (window.speechSynthesis.speaking && !isTtsPaused) {
        window.speechSynthesis.pause();
        isTtsPaused = true;
        flashStatusNotice('TẠM DỪNG ĐỌC THÀNH TIẾNG', 2200);
        syncToolbarState();
        return;
      }
      if (isTtsPaused) {
        window.speechSynthesis.resume();
        isTtsPaused = false;
        flashStatusNotice('TIẾP TỤC ĐỌC THÀNH TIẾNG', 2200);
        syncToolbarState();
        return;
      }
      stopSpeaking();
      return;
    }

    if (pageLayout === 'thumbs') {
      setPageLayout(lastPageLayout);
    }
    isSpeaking = true;
    isTtsPaused = false;
    ttsSessionId += 1;
    commitReadingProgress(true);
    runSpeechLoop(ttsSessionId);
  }

  // Thumbnail contact-sheet grid ("Nhiều trang")
  function syncThumbHighlight(scrollIntoCenter = false) {
    if (renderedThumbBookId !== (currentBook && currentBook.identifier)) return;
    const { leftLeaf, rightLeaf } = currentScanState();
    let targetEl = null;
    const items = thumbGridEl.children;
    for (let i = 0; i < items.length; i++) {
      const el = items[i];
      const lf = Number(el.dataset.leaf);
      const isCur = lf === leftLeaf || lf === rightLeaf;
      el.classList.toggle('is-current', isCur);
      el.classList.toggle('is-bookmarked', bookBookmarks.includes(lf));
      if (lf === leftLeaf) targetEl = el;
    }
    for (let i = 0; i < items.length; i++) {
      const el = items[i];
      const lf = Number(el.dataset.leaf);
      const isCur = lf === leftLeaf || lf === rightLeaf;
      el.classList.toggle('is-current', isCur);
      if (lf === leftLeaf) targetEl = el;
    }
    if (scrollIntoCenter && targetEl && typeof targetEl.scrollIntoView === 'function') {
      targetEl.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }

  function ensureThumbGridRendered() {
    if (!currentBook || scanTotal <= 0) return;
    if (renderedThumbBookId === currentBook.identifier && thumbGridEl.childElementCount === scanTotal) {
      syncThumbHighlight(true);
      return;
    }
    renderedThumbBookId = currentBook.identifier;
    thumbGridEl.innerHTML = '';

    const frag = document.createDocumentFragment();
    for (let i = 0; i < scanTotal; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rdr-thumb-item';
      btn.dataset.leaf = String(i);
      btn.setAttribute('aria-label', `Mở trang ${i + 1}`);

      const wrap = document.createElement('span');
      wrap.className = 'rdr-thumb-img-wrap';

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = `Trang ${i + 1}`;
      img.src = buildScanPageUrl(currentBook.identifier, i, 300);
      wrap.appendChild(img);

      const num = document.createElement('span');
      num.className = 'rdr-thumb-num';
      num.textContent = i === 0 ? 'Bìa (1)' : String(i + 1);

      btn.appendChild(wrap);
      btn.appendChild(num);
      frag.appendChild(btn);
    }
    thumbGridEl.appendChild(frag);
    requestAnimationFrame(() => syncThumbHighlight(true));
  }

  thumbGridEl.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest('.rdr-thumb-item');
    if (!btn) return;
    const leaf = Number(btn.dataset.leaf);
    if (!Number.isFinite(leaf)) return;
    markActivity();
    const oldLeaf = scanLeaf;
    scanLeaf = Math.max(0, Math.min(scanTotal - 1, leaf));
    pageLayout = lastPageLayout;
    renderActiveScanView();
    if (oldLeaf !== scanLeaf) {
      triggerPageTurnAnim(scanLeaf > oldLeaf ? 1 : -1);
    }
    commitReadingProgress(true);
    if (isSpeaking) {
      ttsSessionId += 1;
      runSpeechLoop(ttsSessionId);
    }
  });

  function setPageLayout(nextMode) {
    if (!isOpen || scanFallbackIframe || scanTotal <= 0) return;
    markActivity();
    finishFlip();

    if (nextMode === 'thumbs') {
      if (pageLayout === 'thumbs') {
        pageLayout = lastPageLayout;
      } else {
        lastPageLayout = pageLayout;
        pageLayout = 'thumbs';
      }
      renderActiveScanView();
      return;
    }

    const cleanMode = nextMode === 'single' ? 'single' : 'double';
    pageLayout = cleanMode;
    lastPageLayout = cleanMode;
    prefs = setPrefs({ pageLayout: cleanMode });
    renderActiveScanView();
  }

  function setImmersive(flag) {
    const next = Boolean(flag);
    if (isImmersive === next) return;
    isImmersive = next;
    readerEl.classList.toggle('is-immersive', isImmersive);
    syncToolbarState();

    if (isImmersive) {
      if (readerEl.requestFullscreen && !document.fullscreenElement) {
        readerEl.requestFullscreen().catch(() => {});
      }
    } else if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  }

  document.addEventListener('fullscreenchange', () => {
    if (isImmersive && !document.fullscreenElement) {
      setImmersive(false);
    }
  });

  readerEl.addEventListener('pointermove', markActivity);
  readerEl.addEventListener('pointerdown', markActivity);
  readerEl.addEventListener('wheel', markActivity, { passive: true });

  function showLoading(msg) {
    bookReady = false;
    stateBoxEl.hidden = false;
    stateMsgEl.textContent = msg;
    scanFrameWrapEl.hidden = true;
  }

  function enableIframeFallback() {
    scanFallbackIframe = true;
    bookStageEl.hidden = true;
    thumbGridEl.hidden = true;
    scanIframeEl.hidden = false;
    stateBoxEl.hidden = true;
    scanFrameWrapEl.hidden = false;

    const embedSrc = currentMeta && currentMeta.embedUrl
      ? currentMeta.embedUrl
      : `https://archive.org/embed/${encodeURIComponent(currentBook.identifier)}`;
    if (scanIframeEl.src !== embedSrc) {
      scanIframeEl.src = embedSrc;
    }
    syncPageInfoLabel('');
    syncToolbarState();
    bookReady = true;
  }

  function preloadLeaves(identifier, fromLeaf) {
    if (!identifier || scanTotal <= 0) return;
    const conn = typeof navigator !== 'undefined' && navigator.connection ? navigator.connection : null;
    const isSlow = Boolean(conn && (conn.saveData || conn.effectiveType === '2g' || conn.effectiveType === '3g'));
    const targetWidth = isSlow ? 800 : (zoom >= 1.5 ? 1600 : 1200);

    // Ưu tiên tải theo chiều đang lật trang (lastTurnDir) và hạ tải khi mạng yếu
    const offsets = isSlow
      ? (lastTurnDir >= 0 ? [1, 2, -1] : [-1, -2, 1])
      : (lastTurnDir >= 0 ? [1, 2, 3, 4, -1, -2] : [-1, -2, -3, -4, 1, 2]);

    for (const offset of offsets) {
      const target = fromLeaf + offset;
      if (target >= 0 && target < scanTotal) {
        const pre = new Image();
        pre.decoding = 'async';
        pre.src = buildScanPageUrl(identifier, target, targetWidth);
      }
    }
  }

  function renderScanSpread() {
    if (!currentBook || scanTotal <= 0 || scanFallbackIframe) return;
    lastSnap = snapshotSpread();
    scanLeaf = Math.max(0, Math.min(scanTotal - 1, scanLeaf));
    const { leftLeaf, rightLeaf, endLeaf } = currentScanState();
    scanLeaf = leftLeaf;

    const targetWidth = zoom >= 1.5 ? 1600 : 1200;
    spreadEl.classList.toggle('is-double', rightLeaf >= 0);
    leafLeftEl.src = buildScanPageUrl(currentBook.identifier, leftLeaf, targetWidth);
    leafLeftEl.alt = `Trang ${leftLeaf + 1}`;

    if (rightLeaf >= 0) {
      leafRightEl.hidden = false;
      leafRightEl.src = buildScanPageUrl(currentBook.identifier, rightLeaf, targetWidth);
      leafRightEl.alt = `Trang ${rightLeaf + 1}`;
    } else {
      leafRightEl.hidden = true;
      leafRightEl.removeAttribute('src');
    }

    syncPageInfoLabel(isSpeaking ? 'ĐANG ĐỌC' : '');
    pageRangeEl.min = '1';
    pageRangeEl.max = String(scanTotal);
    pageRangeEl.value = String(leftLeaf + 1);

    const atStart = leftLeaf <= 0;
    const atEnd = endLeaf >= scanTotal - 1;
    prevPageBtnEl.disabled = atStart;
    nextPageBtnEl.disabled = atEnd;
    sidePrevBtnEl.disabled = atStart;
    sideNextBtnEl.disabled = atEnd;
    syncToolbarState();
    syncThumbHighlight(false);

    preloadLeaves(currentBook.identifier, endLeaf);
  }

  function renderActiveScanView() {
    if (!currentBook || scanTotal <= 0 || scanFallbackIframe) return;
    stateBoxEl.hidden = true;
    scanFrameWrapEl.hidden = false;
    scanIframeEl.hidden = true;

    if (pageLayout === 'thumbs') {
      bookStageEl.hidden = true;
      thumbGridEl.hidden = false;
      ensureThumbGridRendered();
      syncPageInfoLabel('NHIỀU TRANG');
      syncToolbarState();
    } else {
      thumbGridEl.hidden = true;
      bookStageEl.hidden = false;
      renderScanSpread();
    }
  }

  leafLeftEl.addEventListener('load', () => {
    if (isOpen) {
      bookReady = true;
    }
  });

  leafLeftEl.addEventListener('error', () => {
    if (isOpen && scanLeaf === 0 && !scanFallbackIframe) {
      enableIframeFallback();
    }
  });

  async function loadPrintedBook() {
    if (!currentBook) return;
    if (loadAbort) loadAbort.abort();
    loadAbort = new AbortController();
    const { signal } = loadAbort;

    if (scanTotal > 0 && !scanFallbackIframe) {
      renderActiveScanView();
      return;
    }

    showLoading('Đang mở bản in gốc…');
    syncToolbarState();

    try {
      const meta = currentMeta || (await fetchItemMetadata(currentBook, signal));
      currentMeta = meta;
      const count = await resolveLeafCount(meta, signal);
      if (signal.aborted) return;

      if (count > 0) {
        scanTotal = count;
        scanFallbackIframe = false;
        scanLeaf = Math.max(0, Math.min(scanTotal - 1, scanLeaf));
        renderActiveScanView();
      } else {
        enableIframeFallback();
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      enableIframeFallback();
    }
  }

  // ===== Hiệu ứng lật trang giấy mềm (page curl) =====
  // Trang được gập theo một đường gấp (trung trực của góc trang và vị trí ngón tay/chuột):
  // phần trước đường gấp là mặt trước, phần sau được phản chiếu qua đường gấp thành mặt sau.
  // Người dùng có thể giữ và kéo qua kéo lại; thả tay mới quyết định lật hay trả về.
  const CURL_MS = 680;
  const CURL_FAST_MS = 380;

  function snapshotSpread() {
    const l = leafLeftEl;
    const r = leafRightEl;
    if (!l.getAttribute('src') || !l.offsetWidth || bookStageEl.hidden) return null;
    const dbl = spreadEl.classList.contains('is-double') && !r.hidden && r.offsetWidth > 0;
    return {
      double: dbl,
      leftSrc: l.currentSrc || l.src,
      rightSrc: dbl ? (r.currentSrc || r.src) : '',
      left: { x: l.offsetLeft, y: l.offsetTop, w: l.offsetWidth, h: l.offsetHeight },
      right: dbl ? { x: r.offsetLeft, y: r.offsetTop, w: r.offsetWidth, h: r.offsetHeight } : null
    };
  }

  function finishFlip() {
    if (!flipCleanup) return false;
    const fn = flipCleanup;
    flipCleanup = null;
    fn();
    return true;
  }

  function whenLoaded(img) {
    return new Promise((resolve) => {
      if (img.hidden || !img.getAttribute('src') || (img.complete && img.naturalWidth > 0)) {
        resolve();
        return;
      }
      const done = () => {
        img.removeEventListener('load', done);
        img.removeEventListener('error', done);
        resolve();
      };
      img.addEventListener('load', done);
      img.addEventListener('error', done);
    });
  }

  function newSpreadLoaded(maxWait = 650) {
    const imgs = [whenLoaded(leafLeftEl)];
    if (!leafRightEl.hidden) imgs.push(whenLoaded(leafRightEl));
    return Promise.race([Promise.all(imgs), new Promise((r) => setTimeout(r, maxWait))]);
  }

  function boxStyle(el, rect) {
    el.style.left = `${rect.x}px`;
    el.style.top = `${rect.y}px`;
    el.style.width = `${rect.w}px`;
    el.style.height = `${rect.h}px`;
  }

  function makeDiv(cls, parent) {
    const el = document.createElement('div');
    el.className = cls;
    if (parent) parent.appendChild(el);
    return el;
  }

  function makeFace(src, mirror, parent) {
    const el = makeDiv('rdr-curl-face', parent);
    if (src) el.style.backgroundImage = `url("${src}")`;
    if (mirror) el.style.transform = 'scaleX(-1)';
    return el;
  }

  // Cắt đa giác theo nửa mặt phẳng (Sutherland–Hodgman với 1 cạnh cắt)
  function clipHalfPlane(poly, px, py, nx, ny, keepPositive) {
    const out = [];
    const side = (p) => {
      const s = (p[0] - px) * nx + (p[1] - py) * ny;
      return keepPositive ? s : -s;
    };
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const sa = side(a);
      const sb = side(b);
      if (sa >= 0) out.push(a);
      if ((sa >= 0) !== (sb >= 0)) {
        const t = sa / (sa - sb);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  }

  function polyCss(poly) {
    if (poly.length < 3) return 'polygon(0 0, 0 0, 0 0)';
    return `polygon(${poly.map((p) => `${p[0].toFixed(2)}px ${p[1].toFixed(2)}px`).join(', ')})`;
  }

  // Gradient vuông góc với đường gấp; stops tính theo khoảng cách (px) từ đường gấp vào phía góc trang
  function foldGradient(W, H, px, py, nx, ny, stops) {
    const ux = -nx;
    const uy = -ny;
    const deg = Math.atan2(ux, -uy) * 180 / Math.PI;
    const L = Math.abs(W * ux) + Math.abs(H * uy);
    const t0 = (px - W / 2) * ux + (py - H / 2) * uy + L / 2;
    const parts = stops.map(([d, c]) => `${c} ${(t0 + d).toFixed(1)}px`);
    return `linear-gradient(${deg.toFixed(2)}deg, ${parts.join(', ')})`;
  }

  /**
   * Tạo một trang giấy có thể gập.
   * Hệ toạ độ chuẩn hoá: gáy sách ở x = 0, trang trải từ 0..W. Trang bên trái được lật gương (mirrored).
   */
  function createCurl({ rect, mirrored, front, back, under, staticSrc, staticRect, fadeFlap }) {
    const W = rect.w;
    const H = rect.h;
    const diag = Math.hypot(W, H);
    const layer = makeDiv('rdr-flip-layer');
    if (staticSrc && staticRect) {
      const st = makeDiv('rdr-flip-page', layer);
      st.style.backgroundImage = `url("${staticSrc}")`;
      boxStyle(st, staticRect);
    }
    const page = makeDiv('rdr-curl', layer);
    boxStyle(page, rect);
    if (mirrored) page.style.transform = 'scaleX(-1)';

    makeFace(under, mirrored, page);
    const underShade = makeDiv('rdr-curl-shade', page);
    const frontClip = makeDiv('rdr-curl-clip', page);
    makeFace(front, mirrored, frontClip);
    const frontShade = makeDiv('rdr-curl-shade', frontClip);
    const flapWrap = makeDiv('rdr-curl-flap', page);
    const flapClip = makeDiv('rdr-curl-clip', flapWrap);
    makeFace(back, !mirrored, flapClip);
    const flapShade = makeDiv('rdr-curl-shade', flapClip);

    spreadEl.appendChild(layer);
    const rectPoly = [[0, 0], [W, 0], [W, H], [0, H]];

    function constrain(mx, my, cy) {
      // Giữ trang dính vào gáy: góc trang không thể xa điểm gáy quá chiều rộng / đường chéo trang
      let x = mx;
      let y = my;
      const s1y = cy;
      const s2y = H - cy;
      let d1 = Math.hypot(x, y - s1y);
      if (d1 > W) {
        x = (x / d1) * W;
        y = s1y + ((y - s1y) / d1) * W;
      }
      const d2 = Math.hypot(x, y - s2y);
      if (d2 > diag) {
        x = (x / d2) * diag;
        y = s2y + ((y - s2y) / d2) * diag;
      }
      return [x, y];
    }

    function set(mx0, my0, cy) {
      const [mx, my] = constrain(mx0, my0, cy);
      const dx = mx - W;
      const dy = my - cy;
      const len = Math.hypot(dx, dy);
      if (len < 0.5) {
        frontClip.style.clipPath = 'none';
        flapWrap.style.visibility = 'hidden';
        underShade.style.opacity = '0';
        frontShade.style.opacity = '0';
        return;
      }
      flapWrap.style.visibility = 'visible';
      underShade.style.opacity = '1';
      frontShade.style.opacity = '1';
      const nx = dx / len;
      const ny = dy / len;
      const px = (W + mx) / 2;
      const py = (cy + my) / 2;

      frontClip.style.clipPath = polyCss(clipHalfPlane(rectPoly, px, py, nx, ny, true));
      flapClip.style.clipPath = polyCss(clipHalfPlane(rectPoly, px, py, nx, ny, false));

      // Ma trận phản chiếu qua đường gấp
      const pn = px * nx + py * ny;
      const a = 1 - 2 * nx * nx;
      const b = -2 * nx * ny;
      const d = 1 - 2 * ny * ny;
      flapWrap.style.transform = `matrix(${a}, ${b}, ${b}, ${d}, ${2 * pn * nx}, ${2 * pn * ny})`;

      const progress = Math.max(0, Math.min(1, (W - mx) / (2 * W)));
      const lift = Math.min(1, len / (W * 0.18));
      const band = Math.min(W * 0.34, len * 0.55) + 6;
      const sUnder = (0.55 * lift * (1 - progress * 0.55)).toFixed(3);
      underShade.style.background = foldGradient(W, H, px, py, nx, ny, [
        [0, `rgba(0,0,0,${sUnder})`],
        [band * 0.9, 'rgba(0,0,0,0)']
      ]);
      // Mặt sau: tối ở chỗ cong, có vệt sáng nhẹ như giấy thật
      flapShade.style.background = foldGradient(W, H, px, py, nx, ny, [
        [0, `rgba(0,0,0,${(0.32 * lift).toFixed(3)})`],
        [band * 0.28, `rgba(0,0,0,${(0.08 * lift).toFixed(3)})`],
        [band * 0.55, `rgba(255,255,255,${(0.16 * lift).toFixed(3)})`],
        [band * 1.2, 'rgba(255,255,255,0)'],
        [len * 0.5 + 1, 'rgba(0,0,0,0.05)']
      ]);
      // Mặt trước: hơi tối dần về phía mép đang nhấc lên
      frontShade.style.background = foldGradient(W, H, px, py, nx, ny, [
        [-band * 1.4, 'rgba(0,0,0,0)'],
        [0, `rgba(0,0,0,${(0.2 * lift).toFixed(3)})`]
      ]);

      if (fadeFlap) {
        // Chế độ 1 trang: không có trang trái để đỡ, phần lật qua gáy mờ dần
        const f = Math.max(0, Math.min(1, (mx + W * 0.75) / (W * 0.75)));
        flapWrap.style.opacity = f.toFixed(3);
      }
    }

    return { W, H, layer, set, constrain, destroy: () => layer.remove() };
  }

  // Cấu hình trang lật theo hướng & trạng thái (old = ảnh hiện tại, neu = ảnh trang đích)
  function curlConfig(dir, snap, neu) {
    const fwd = dir > 0;
    if (snap.double) {
      return fwd
        ? { rect: snap.right, mirrored: false, front: snap.rightSrc, back: neu.left, under: neu.right, staticSrc: snap.leftSrc, staticRect: snap.left, startX: 1, endX: -1 }
        : { rect: snap.left, mirrored: true, front: snap.leftSrc, back: neu.right, under: neu.left, staticSrc: snap.rightSrc, staticRect: snap.right, startX: 1, endX: -1 };
    }
    return fwd
      ? { rect: snap.left, mirrored: false, front: snap.leftSrc, back: '', under: neu.left, fadeFlap: true, startX: 1, endX: -1 }
      : { rect: snap.left, mirrored: false, front: neu.left, back: '', under: snap.leftSrc, fadeFlap: true, startX: -1, endX: 1 };
  }

  function easeInOut(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function easeOut(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function slideFallback(dir) {
    finishFlip();
    if (pageTurnAnim) pageTurnAnim.cancel();
    pageTurnAnim = spreadEl.animate(
      [
        { transform: `translateX(${dir > 0 ? 38 : -38}px) scale(0.975)`, opacity: 0.6 },
        { transform: 'translateX(0px) scale(1)', opacity: 1 }
      ],
      { duration: 260, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'both' }
    );
    pageTurnAnim.onfinish = () => {
      pageTurnAnim = null;
    };
  }

  // Lật tự động (nút bấm, bàn phím, cuộn chuột): góc dưới trang được nhấc lên theo đường cong
  function runFlip(dir, snap, nowDouble, fast) {
    const token = ++flipToken;
    const neu = { left: leafLeftEl.src, right: nowDouble ? leafRightEl.src : '' };
    const cfg = curlConfig(dir, snap, neu);
    const curl = createCurl(cfg);
    const { W, H } = curl;
    const cy = H;
    const x0 = cfg.startX * W;
    const x1 = cfg.endX * W;
    let raf = 0;
    curl.set(x0, cy, cy);

    flipCleanup = () => {
      cancelAnimationFrame(raf);
      curl.destroy();
    };

    const dur = fast ? CURL_FAST_MS : CURL_MS;
    newSpreadLoaded().then(() => {
      if (token !== flipToken || !curl.layer.isConnected) return;
      const t0 = performance.now();
      const tick = (now) => {
        if (token !== flipToken) return;
        const t = Math.min(1, (now - t0) / dur);
        const e = easeInOut(t);
        const x = x0 + (x1 - x0) * e;
        const y = cy - Math.sin(Math.PI * e) * H * 0.14;
        curl.set(x, y, cy);
        if (t < 1) {
          raf = requestAnimationFrame(tick);
        } else {
          flipCleanup = null;
          curl.destroy();
        }
      };
      raf = requestAnimationFrame(tick);
    });
  }

  function triggerPageTurnAnim(dir, fast = false) {
    const snap = lastSnap;
    lastSnap = null;
    if (!dir || isReducedMotion() || zoom > 1 || !spreadEl) return;
    const wasFlipping = finishFlip() || fast;
    const nowDouble = !leafRightEl.hidden && spreadEl.classList.contains('is-double');
    if (!snap || snap.double !== nowDouble) {
      slideFallback(dir);
      return;
    }
    runFlip(dir, snap, nowDouble, wasFlipping);
  }

  function targetLeafFor(dir) {
    const { useDouble, leftLeaf, rightLeaf } = currentScanState();
    let nextLeaf = leftLeaf;
    if (dir > 0) {
      if (leftLeaf === 0) {
        nextLeaf = 1;
      } else {
        nextLeaf = (rightLeaf >= 0 ? rightLeaf : leftLeaf) + 1;
      }
    } else if (dir < 0) {
      if (leftLeaf <= 1) {
        nextLeaf = 0;
      } else {
        const step = lastPageLayout === 'double' ? 2 : 1;
        nextLeaf = Math.max(0, leftLeaf - step);
      }
    }
    nextLeaf = Math.max(0, Math.min(scanTotal - 1, nextLeaf));
    if (nextLeaf === leftLeaf) return null;
    return nextLeaf;
  }

  function applyStep(nextLeaf, dir, userAction, animate, fast = false) {
    lastTurnDir = dir;
    scanLeaf = nextLeaf;
    renderActiveScanView();
    if (animate) triggerPageTurnAnim(dir, fast);
    else lastSnap = null;
    commitReadingProgress(userAction);

    if (isSpeaking && userAction) {
      ttsSessionId += 1;
      runSpeechLoop(ttsSessionId);
    }
  }

  function stepPage(dir, userAction = true) {
    if (!isOpen || scanFallbackIframe || scanTotal <= 0) return;
    markActivity();
    lastTurnDir = dir;

    if (pageLayout === 'thumbs') {
      pageLayout = lastPageLayout;
    }

    // Kết thúc hiệu ứng đang chạy trước (kể cả lượt kéo tay đang chờ áp dụng)
    const wasBusy = finishFlip();
    const nextLeaf = targetLeafFor(dir);
    if (nextLeaf === null) return;
    applyStep(nextLeaf, dir, userAction, true, wasBusy);
  }

  // ===== Kéo trang bằng tay (chuột / cảm ứng) =====
  let drag = null; // { id, x0, y0, started, ... }
  let suppressClick = false;

  function localPoint(d, clientX, clientY) {
    const sr = spreadEl.getBoundingClientRect();
    let x = clientX - sr.left - d.rect.x;
    const y = clientY - sr.top - d.rect.y;
    if (d.mirrored) x = d.rect.w - x;
    return [x, y];
  }

  function beginDrag(e) {
    if (!isOpen || scanFallbackIframe || scanTotal <= 0 || pageLayout === 'thumbs') return false;
    if (zoom > 1 || isReducedMotion() || !currentBook) return false;
    finishFlip();
    const snap = snapshotSpread();
    if (!snap) return false;

    const sr = spreadEl.getBoundingClientRect();
    const relX = drag.x0 - sr.left;
    const dir = snap.double
      ? (relX >= snap.right.x ? 1 : -1)
      : (e.clientX - drag.x0 < 0 ? 1 : -1);
    const nextLeaf = targetLeafFor(dir);
    if (nextLeaf === null) return false;
    const tgt = currentScanState(nextLeaf);
    if ((tgt.rightLeaf >= 0) !== snap.double) return false; // bìa / trang cuối đứng một mình: dùng vuốt thường

    if (pageTurnAnim) {
      pageTurnAnim.cancel();
      pageTurnAnim = null;
    }
    const url = (lf) => (lf >= 0 ? buildScanPageUrl(currentBook.identifier, lf, 1200) : '');
    const cfg = curlConfig(dir, snap, { left: url(tgt.leftLeaf), right: url(tgt.rightLeaf) });
    const curl = createCurl(cfg);
    const token = ++flipToken;

    Object.assign(drag, {
      started: true,
      token,
      dir,
      nextLeaf,
      curl,
      rect: cfg.rect,
      mirrored: cfg.mirrored,
      startX: cfg.startX * curl.W,
      endX: cfg.endX * curl.W,
      kx: cfg.startX < 0 ? 1.4 : 1,
      raf: 0,
      released: false,
      samples: []
    });
    const [gx, gy] = localPoint(drag, drag.x0, drag.y0);
    drag.gx = gx;
    drag.gy = gy;
    drag.cy = gy < curl.H / 2 ? 0 : curl.H;
    drag.mx = drag.startX;
    drag.my = drag.cy;
    drag.tx = drag.mx;
    drag.ty = drag.my;
    curl.set(drag.mx, drag.my, drag.cy);

    const d = drag;
    flipCleanup = () => {
      cancelAnimationFrame(d.raf);
      d.curl.destroy();
      d.dead = true;
      // Bị ngắt giữa lúc đang lật nốt: vẫn áp dụng việc chuyển trang
      if (d.commit && !d.applied) {
        d.applied = true;
        applyStep(d.nextLeaf, d.dir, true, false);
      }
    };
    bookStageEl.classList.add('is-curling');
    try {
      bookStageEl.setPointerCapture(e.pointerId);
    } catch {
      // Ignore capture errors
    }
    const loop = () => {
      if (d.dead || d.released) return;
      d.mx += (d.tx - d.mx) * 0.38;
      d.my += (d.ty - d.my) * 0.38;
      d.curl.set(d.mx, d.my, d.cy);
      d.raf = requestAnimationFrame(loop);
    };
    d.raf = requestAnimationFrame(loop);
    return true;
  }

  function moveDrag(e) {
    const d = drag;
    const [lx, ly] = localPoint(d, e.clientX, e.clientY);
    d.tx = d.startX + (lx - d.gx) * d.kx;
    d.ty = d.cy + (ly - d.gy);
    // Giới hạn vị trí đích để buông tay không bị "nhảy"
    [d.tx, d.ty] = d.curl.constrain(d.tx, d.ty, d.cy);
    const now = performance.now();
    d.samples.push([now, lx]);
    while (d.samples.length > 2 && now - d.samples[0][0] > 120) d.samples.shift();
  }

  function releaseDrag() {
    const d = drag;
    d.released = true;
    cancelAnimationFrame(d.raf);
    bookStageEl.classList.remove('is-curling');
    if (d.dead) return;

    const span = d.endX - d.startX;
    const frac = (d.mx - d.startX) / span;
    let v = 0; // px/ms theo hệ chuẩn hoá
    if (d.samples.length >= 2) {
      const [ta, xa] = d.samples[0];
      const [tb, xb] = d.samples[d.samples.length - 1];
      if (tb - ta > 0) v = ((xb - xa) / (tb - ta)) * d.kx;
    }
    const vTo = v * Math.sign(span);
    const commit = (frac > 0.5 && vTo > -0.35) || (frac > 0.04 && vTo > 0.45);
    d.commit = commit;

    const fromX = d.mx;
    const fromY = d.my;
    const toX = commit ? d.endX : d.startX;
    const remain = Math.abs(toX - fromX) / Math.abs(span);
    const dur = 160 + 380 * remain;
    const t0 = performance.now();
    const tick = (now) => {
      if (d.dead) return;
      const t = Math.min(1, (now - t0) / dur);
      const e = easeOut(t);
      const x = fromX + (toX - fromX) * e;
      const y = fromY + (d.cy - fromY) * e;
      d.curl.set(x, y, d.cy);
      if (t < 1) {
        d.raf = requestAnimationFrame(tick);
        return;
      }
      if (!commit) {
        finishFlip();
        return;
      }
      // Lớp phủ đang hiển thị đúng trang đích: đổi ảnh thật bên dưới rồi gỡ lớp phủ khi ảnh tải xong
      d.applied = true;
      applyStep(d.nextLeaf, d.dir, true, false);
      newSpreadLoaded().then(() => {
        if (!d.dead && flipToken === d.token) finishFlip();
      });
    };
    d.raf = requestAnimationFrame(tick);
  }

  function open(book, preloadedMeta = null, { immediate = false } = {}) {
    if (!book || isOpen) return;
    isOpen = true;
    const isSameBook = currentBook && currentBook.identifier === book.identifier;
    currentBook = book;
    currentMeta = preloadedMeta || (isSameBook ? currentMeta : null);

    stopSpeaking();

    // Restore user's preferred 1-page or 2-page view (default 2-page on desktop)
    const prefMode = getPrefs().pageLayout === 'single' ? 'single' : 'double';
    pageLayout = window.innerWidth < 700 ? 'single' : prefMode;
    lastPageLayout = pageLayout;

    if (!isSameBook) {
      scanTotal = 0;
      scanFallbackIframe = false;
      renderedThumbBookId = '';
      thumbGridEl.innerHTML = '';
      leafLeftEl.removeAttribute('src');
      leafRightEl.removeAttribute('src');
    }

    const existingProg = getProgress(book.identifier);
    bookBookmarks = Array.isArray(existingProg && existingProg.bookmarks) ? [...existingProg.bookmarks] : [];
    bookNotes = existingProg && existingProg.notes && typeof existingProg.notes === 'object' ? { ...existingProg.notes } : {};
    zoom = existingProg && typeof existingProg.zoom === 'number' ? existingProg.zoom : 1;
    applyZoom(zoom);

    sessionVerified = Boolean(existingProg && existingProg.verified);
    dwellSecThisOpen = 0;
    unflushedSec = 0;
    bookReady = false;
    markActivity();
    startHeartbeat();

    scanLeaf = existingProg && typeof existingProg.scanLeaf === 'number' ? existingProg.scanLeaf : 0;

    titleBarEl.textContent = `${book.title} — ${book.creator}`;
    readerEl.style.visibility = 'visible';

    if (sheetAnim) sheetAnim.cancel();
    sheetAnim = readerEl.animate(
      [
        { transform: immediate ? 'translateY(0%)' : 'translateY(100%)' },
        { transform: 'translateY(0%)' }
      ],
      {
        duration: immediate || isReducedMotion() ? 1 : 600,
        easing: 'cubic-bezier(.2, .8, .2, 1)',
        fill: 'both'
      }
    );

    loadPrintedBook();
  }

  function close() {
    if (!isOpen) return;
    if (loadAbort) loadAbort.abort();
    finishFlip();
    if (pageTurnAnim) pageTurnAnim.cancel();
    stopSpeaking();
    if (sessionVerified && unflushedSec > 0) {
      commitReadingProgress(false);
    }
    stopHeartbeat();
    setImmersive(false);

    if (searchBoxEl) searchBoxEl.hidden = true;
    if (notePopEl) notePopEl.hidden = true;
    if (textViewerEl) textViewerEl.hidden = true;
    if (textAltBtnEl) textAltBtnEl.classList.remove('active');

    const closeAnim = readerEl.animate(
      [
        { transform: 'translateY(0%)' },
        { transform: 'translateY(100%)' }
      ],
      {
        duration: isReducedMotion() ? 1 : 480,
        easing: 'cubic-bezier(.76, 0, .18, 1)',
        fill: 'both'
      }
    );

    closeAnim.onfinish = () => {
      readerEl.style.visibility = 'hidden';
      scanIframeEl.src = 'about:blank';
      if (sheetAnim) sheetAnim.cancel();
      closeAnim.cancel();
      isOpen = false;
      onCloseReader();
    };
  }

  function toggleBookmark() {
    if (!currentBook || scanTotal <= 0) return;
    markActivity();
    const { leftLeaf } = currentScanState();
    const idx = bookBookmarks.indexOf(leftLeaf);
    if (idx >= 0) {
      bookBookmarks.splice(idx, 1);
      flashStatusNotice(`ĐÃ BỎ ĐÁNH DẤU TRANG ${leftLeaf + 1}`);
    } else {
      bookBookmarks.push(leftLeaf);
      bookBookmarks.sort((a, b) => a - b);
      flashStatusNotice(`ĐÃ ĐÁNH DẤU TRANG ${leftLeaf + 1}`);
    }
    setProgress(currentBook, { bookmarks: bookBookmarks });
    syncToolbarState();
    syncThumbHighlight(false);
  }

  function openNotePopup() {
    if (!currentBook || scanTotal <= 0 || !notePopEl) return;
    markActivity();
    const { leftLeaf } = currentScanState();
    notePopTitleEl.textContent = `GHI CHÚ TRANG ${leftLeaf + 1}`;
    noteTextEl.value = bookNotes[leftLeaf] || '';
    notePopEl.hidden = !notePopEl.hidden;
    if (!notePopEl.hidden) {
      noteTextEl.focus();
    }
  }

  function saveNote() {
    if (!currentBook || !notePopEl) return;
    markActivity();
    const { leftLeaf } = currentScanState();
    const text = noteTextEl.value.trim();
    if (text) {
      bookNotes[leftLeaf] = text;
      flashStatusNotice(`ĐÃ LƯU GHI CHÚ TRANG ${leftLeaf + 1}`);
    } else {
      delete bookNotes[leftLeaf];
      flashStatusNotice(`ĐÃ XÓA GHI CHÚ TRANG ${leftLeaf + 1}`);
    }
    setProgress(currentBook, { notes: bookNotes });
    notePopEl.hidden = true;
    syncToolbarState();
  }

  function toggleSearchBox() {
    if (!currentBook || !searchBoxEl) return;
    markActivity();
    searchBoxEl.hidden = !searchBoxEl.hidden;
    if (!searchBoxEl.hidden) {
      searchInpEl.focus();
      searchInpEl.select();
    }
  }

  async function performBookSearch() {
    if (!currentBook || !searchInpEl || !searchResultsEl) return;
    markActivity();
    const q = searchInpEl.value.trim().toLowerCase();
    if (!q) return;

    searchResultsEl.innerHTML = '<div class="rdr-search-status">Đang tìm trong văn bản sách…</div>';
    try {
      const meta = currentMeta || (await fetchItemMetadata(currentBook));
      currentMeta = meta;
      const ocr = await getBookOcrData(meta);
      if (!ocr || !ocr.text) {
        searchResultsEl.innerHTML = '<div class="rdr-search-status">Sách này chưa có lớp văn bản OCR để tìm kiếm.</div>';
        return;
      }

      let pages = [];
      if (ocr.type === 'indexed' && ocr.index) {
        for (let i = 0; i < ocr.index.length; i++) {
          const range = ocr.index[i];
          if (Array.isArray(range)) {
            pages.push(ocr.text.slice(range[0], range[1]));
          } else {
            pages.push('');
          }
        }
      } else if (ocr.pages) {
        pages = ocr.pages;
      } else if (ocr.text.includes('\f')) {
        pages = ocr.text.split('\f');
      } else if (scanTotal > 0) {
        const len = ocr.text.length;
        for (let i = 0; i < scanTotal; i++) {
          const start = Math.floor((i / scanTotal) * len);
          const end = Math.floor(((i + 1) / scanTotal) * len);
          pages.push(ocr.text.slice(start, end));
        }
      } else {
        pages = [ocr.text];
      }

      const qNorm = stripMarks(q);
      const matches = [];
      for (let i = 0; i < pages.length; i++) {
        const pText = pages[i] || '';
        const pNorm = stripMarks(pText);
        const matchIdx = pNorm.indexOf(qNorm);
        if (matchIdx >= 0) {
          const start = Math.max(0, matchIdx - 40);
          const end = Math.min(pText.length, matchIdx + q.length + 50);
          const snippet = pText.slice(start, end).replace(/\s+/g, ' ');
          matches.push({ leaf: i, pageNum: i + 1, snippet });
          if (matches.length >= 30) break;
        }
      }

      if (matches.length === 0) {
        searchResultsEl.innerHTML = `<div class="rdr-search-status">Không tìm thấy "${escapeHtml(q)}" trong sách.</div>`;
        return;
      }

      searchResultsEl.innerHTML = '';
      const listFrag = document.createDocumentFragment();
      for (const m of matches) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'rdr-search-item';
        item.innerHTML = `<span class="rdr-search-page">Trang ${m.pageNum}</span><span class="rdr-search-snippet">…${escapeHtml(m.snippet)}…</span>`;
        item.onclick = () => {
          scanLeaf = m.leaf;
          if (pageLayout === 'thumbs') pageLayout = lastPageLayout;
          renderActiveScanView();
          commitReadingProgress(true);
          searchBoxEl.hidden = true;
        };
        listFrag.appendChild(item);
      }
      searchResultsEl.appendChild(listFrag);
    } catch {
      searchResultsEl.innerHTML = '<div class="rdr-search-status">Lỗi tải dữ liệu tìm kiếm.</div>';
    }
  }

  async function toggleTextViewer() {
    if (!currentBook || !textViewerEl) return;
    markActivity();
    textViewerEl.hidden = !textViewerEl.hidden;
    textAltBtnEl.classList.toggle('active', !textViewerEl.hidden);
    if (textViewerEl.hidden) return;

    textBodyEl.innerHTML = '<div class="rdr-text-loading">Đang tải văn bản OCR…</div>';
    try {
      const meta = currentMeta || (await fetchItemMetadata(currentBook));
      currentMeta = meta;
      const ocr = await getBookOcrData(meta);
      if (!ocr || !ocr.text) {
        textBodyEl.innerHTML = '<div class="rdr-text-empty">Bản in này chưa có dữ liệu văn bản OCR. Vui lòng đọc ở chế độ xem ảnh scan.</div>';
        return;
      }

      let pages = [];
      if (ocr.type === 'indexed' && ocr.index) {
        for (let i = 0; i < ocr.index.length; i++) {
          const range = ocr.index[i];
          if (Array.isArray(range)) {
            pages.push(ocr.text.slice(range[0], range[1]));
          } else {
            pages.push('');
          }
        }
      } else if (ocr.pages) {
        pages = ocr.pages;
      } else if (ocr.text.includes('\f')) {
        pages = ocr.text.split('\f');
      } else if (scanTotal > 0) {
        const len = ocr.text.length;
        for (let i = 0; i < scanTotal; i++) {
          const start = Math.floor((i / scanTotal) * len);
          const end = Math.floor(((i + 1) / scanTotal) * len);
          pages.push(ocr.text.slice(start, end));
        }
      } else {
        pages = [ocr.text];
      }

      textBodyEl.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (let i = 0; i < pages.length; i++) {
        const text = (pages[i] || '').trim();
        if (!text) continue;
        const pageBox = document.createElement('div');
        pageBox.className = 'rdr-text-page';
        pageBox.id = `rdrTextPage_${i}`;
        if (i === scanLeaf) pageBox.classList.add('is-current');
        pageBox.innerHTML = `<div class="rdr-text-page-hdr">TRANG ${i + 1}</div><div class="rdr-text-page-content">${escapeHtml(text)}</div>`;
        frag.appendChild(pageBox);
      }
      textBodyEl.appendChild(frag);

      const target = document.getElementById(`rdrTextPage_${scanLeaf}`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch {
      textBodyEl.innerHTML = '<div class="rdr-text-empty">Không tải được văn bản OCR của sách này.</div>';
    }
  }

  // Toolbar & side page-turn button events
  closeBtnEl.addEventListener('click', close);
  prevPageBtnEl.addEventListener('click', () => stepPage(-1, true));
  nextPageBtnEl.addEventListener('click', () => stepPage(1, true));
  sidePrevBtnEl.addEventListener('click', () => stepPage(-1, true));
  sideNextBtnEl.addEventListener('click', () => stepPage(1, true));

  view1BtnEl.addEventListener('click', () => setPageLayout('single'));
  view2BtnEl.addEventListener('click', () => setPageLayout('double'));
  viewThumbBtnEl.addEventListener('click', () => setPageLayout('thumbs'));
  ttsBtnEl.addEventListener('click', toggleTts);

  zoomOutBtnEl.addEventListener('click', () => zoomBy(-ZOOM_STEP));
  zoomResetBtnEl.addEventListener('click', resetZoom);
  zoomInBtnEl.addEventListener('click', () => zoomBy(ZOOM_STEP));

  expandBtnEl.addEventListener('click', () => setImmersive(!isImmersive));

  if (bookmarkBtnEl) bookmarkBtnEl.addEventListener('click', toggleBookmark);
  if (noteBtnEl) noteBtnEl.addEventListener('click', openNotePopup);
  if (noteSaveBtnEl) noteSaveBtnEl.addEventListener('click', saveNote);
  if (notePopCloseEl) notePopCloseEl.addEventListener('click', () => { notePopEl.hidden = true; });
  if (searchBtnEl) searchBtnEl.addEventListener('click', toggleSearchBox);
  if (searchCloseBtnEl) searchCloseBtnEl.addEventListener('click', () => { searchBoxEl.hidden = true; });
  if (searchGoBtnEl) searchGoBtnEl.addEventListener('click', performBookSearch);
  if (searchInpEl) {
    searchInpEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        performBookSearch();
      }
    });
  }
  if (textAltBtnEl) textAltBtnEl.addEventListener('click', toggleTextViewer);
  if (textCloseBtnEl) textCloseBtnEl.addEventListener('click', () => {
    textViewerEl.hidden = true;
    textAltBtnEl.classList.remove('active');
  });
  if (textFontUpEl) textFontUpEl.addEventListener('click', () => {
    textFontSize = Math.min(32, textFontSize + 2);
    textBodyEl.style.fontSize = `${textFontSize}px`;
  });
  if (textFontDownEl) textFontDownEl.addEventListener('click', () => {
    textFontSize = Math.max(12, textFontSize - 2);
    textBodyEl.style.fontSize = `${textFontSize}px`;
  });
  if (textThemeBtnEl) textThemeBtnEl.addEventListener('click', () => {
    textTheme = textTheme === 'light' ? 'sepia' : (textTheme === 'sepia' ? 'dark' : 'light');
    textViewerEl.dataset.theme = textTheme;
    textThemeBtnEl.textContent = textTheme === 'light' ? '🌙' : (textTheme === 'sepia' ? '🌑' : '☀️');
  });

  pageRangeEl.addEventListener('input', () => {
    markActivity();
    if (scanFallbackIframe || scanTotal <= 0) return;
    finishFlip();
    const val = Math.max(1, Number(pageRangeEl.value || 1));
    scanLeaf = val - 1;
    if (pageLayout === 'thumbs') {
      pageLayout = lastPageLayout;
    }
    renderActiveScanView();
    commitReadingProgress(true);
    if (isSpeaking) {
      ttsSessionId += 1;
      runSpeechLoop(ttsSessionId);
    }
  });

  // Stage pointer interaction: pan when zoomed > 1, swipe / edge-click when zoom <= 1
  bookStageEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panMoved = false;
    suppressClick = false;
    if (zoom > 1) {
      isPanning = true;
      panScrollLeft = bookStageEl.scrollLeft;
      panScrollTop = bookStageEl.scrollTop;
      bookStageEl.classList.add('is-panning');
    } else if (!drag) {
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, started: false };
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (drag && drag.id === e.pointerId) {
      if (!drag.started) {
        const dx = e.clientX - drag.x0;
        const dy = e.clientY - drag.y0;
        if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) {
          if (!beginDrag(e)) {
            drag = null; // không kéo được (bìa, trang cuối…): để thao tác vuốt/nhấp xử lý
          }
        } else if (Math.abs(dy) > 24) {
          drag = null;
        }
      }
      if (drag && drag.started && !drag.released) {
        e.preventDefault();
        markActivity();
        moveDrag(e);
      }
      return;
    }
    if (!isPanning) return;
    const dx = e.clientX - panStartX;
    const dy = e.clientY - panStartY;
    if (!panMoved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      panMoved = true;
    }
    if (panMoved) {
      bookStageEl.scrollLeft = panScrollLeft - dx;
      bookStageEl.scrollTop = panScrollTop - dy;
    }
  });

  function endPointer(e) {
    if (drag && drag.id === e.pointerId) {
      if (drag.started && !drag.released) {
        suppressClick = true;
        releaseDrag();
      }
      drag = null;
    }
    if (isPanning) {
      isPanning = false;
      bookStageEl.classList.remove('is-panning');
    }
  }
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  bookStageEl.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (zoom > 1 || panMoved) return;
    const dx = e.clientX - panStartX;
    const dy = e.clientY - panStartY;
    if (Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      stepPage(dx < 0 ? 1 : -1, true);
      return;
    }
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) {
      const rect = bookStageEl.getBoundingClientRect();
      const rel = (e.clientX - rect.left) / Math.max(1, rect.width);
      if (rel < 0.3) stepPage(-1, true);
      else if (rel > 0.7) stepPage(1, true);
    }
  });

  // Ctrl + Wheel zoom & single-page wheel flip with inertia damping (when unzoomed)
  let wheelAccum = 0;
  let wheelResetTimer = null;
  bookStageEl.addEventListener('wheel', (e) => {
    if (!isOpen || scanFallbackIframe || scanTotal <= 0) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
      return;
    }
    if (zoom > 1) return; // let browser scroll zoomed book naturally
    e.preventDefault();
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    wheelAccum += delta;
    clearTimeout(wheelResetTimer);
    wheelResetTimer = setTimeout(() => {
      wheelAccum = 0;
      wheelCooldown = false;
    }, 280);

    if (Math.abs(wheelAccum) >= 65 && !wheelCooldown) {
      wheelCooldown = true;
      stepPage(wheelAccum > 0 ? 1 : -1, true);
      wheelAccum = 0;
      setTimeout(() => {
        wheelCooldown = false;
      }, 380);
    }
  }, { passive: false });

  return {
    open,
    close,
    stepPage,
    zoomBy,
    resetZoom,
    setPageLayout,
    toggleTts,
    enterImmersive: () => setImmersive(true),
    exitImmersive: () => setImmersive(false),
    toggleImmersive: () => setImmersive(!isImmersive),
    isThumbMode: () => pageLayout === 'thumbs',
    isOpen: () => isOpen,
    isImmersive: () => isImmersive
  };
}
