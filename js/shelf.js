import { renderSpine, renderCover } from './cover.js';
import { isSaved } from './store.js';

const POOL_SIZE = 36;

function mod(n, m) {
  return ((n % m) + m) % m;
}

function smoothstep(x) {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

function stepB(r) {
  if (r <= -1) return -0.5;
  if (r >= 1) return 0.5;
  return (r + Math.sin(Math.PI * r) / Math.PI) / 2;
}

function pointInRect(px, py, rect) {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    px >= rect.left &&
    px <= rect.right &&
    py >= rect.top &&
    py <= rect.bottom
  );
}

export function createShelf({
  shelfEl,
  stageEl,
  capTitleEl,
  capSubEl,
  capYearEl,
  statusBoxEl,
  statusMsgEl,
  statusActionEl,
  onOpenBook,
  onActiveChange,
  onNeedMore,
  onResetFilters,
  onRetryLoad
}) {
  const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reducedMotion = reduceMotionQuery.matches;
  reduceMotionQuery.addEventListener('change', (e) => {
    reducedMotion = e.matches;
  });

  let W = 860;
  let SH = 360;
  let shelfLeft = 0;
  let shelfTop = 0;
  let H = 260;
  let ws = 44;
  let d = 173;
  let gap = 8;

  let books = [];
  let hasMorePages = false;
  let loopMode = false;
  let status = 'loading'; // 'ready' | 'loading' | 'empty' | 'error'

  let s = 0;
  let T = 0;
  let hoverSlot = -1;
  let activeBookId = '';
  let activeIdx = 0;

  let mx = window.innerWidth / 2;
  let my = window.innerHeight / 2;
  let tiltX = 0;
  let tiltY = 0;
  let onCover = false;
  let layoutMode = 'shelf'; // 'shelf' | 'grid'
  let overlayOpen = false;

  let isDragging = false;
  let dragMoved = false;
  let dragStartX = 0;
  let dragStartT = 0;
  let wheelTimer = null;
  let lastNeedMoreTime = 0;

  function posX(r) {
    return r * (ws + gap) + (d - ws + 1.6 * gap) * stepB(r);
  }

  function measure() {
    const rect = shelfEl.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      W = rect.width;
      SH = rect.height;
      shelfLeft = rect.left;
      shelfTop = rect.top;
    }
    H = Math.max(142, Math.min(SH - 74, W * 0.29, 320));
    ws = H * (142 / 840);
    d = H * (600 / 900);
    gap = H * 0.03;
    shelfEl.style.setProperty('--H', `${H}px`);
    stageEl.style.setProperty('--ws', `${ws}px`);
    stageEl.style.setProperty('--d', `${d}px`);
  }

  function getSlotVisibleRect(slot) {
    const spRect = slot.sp.getBoundingClientRect();
    const cvRect = slot.cv.getBoundingClientRect();
    return cvRect.width >= spRect.width ? cvRect : spRect;
  }

  // Create reusable pool of 36 book cuboid elements
  const pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const el = document.createElement('div');
    el.className = 'tape';

    const sp = document.createElement('div');
    sp.className = 'face sp';

    const cv = document.createElement('div');
    cv.className = 'face cv';

    el.appendChild(sp);
    el.appendChild(cv);
    stageEl.appendChild(el);

    pool.push({
      slotIdx: i,
      el,
      sp,
      cv,
      lift: 0,
      relR: 99,
      v: i,
      bookRef: null,
      boundKey: ''
    });
  }

  function setTarget(nextT) {
    if (books.length === 0) return;
    if (loopMode) {
      T = nextT;
    } else {
      T = Math.max(0, Math.min(books.length - 1, nextT));
    }
  }

  // Fast zero-reflow hover test for 60fps animation loop
  function checkHoverMath(px, py) {
    if (status !== 'ready' || books.length === 0 || overlayOpen) {
      return { onCover: false, hoverSlot: -1 };
    }
    const cx = shelfLeft + W / 2;
    const cy = shelfTop + SH / 2 - 20;
    const relX = px - cx;
    const relY = py - cy;
    if (Math.abs(relY) > H * 0.58) {
      return { onCover: false, hoverSlot: -1 };
    }

    if (Math.abs(T - s) < 0.45 && Math.abs(relX) <= (d / 2) * 1.05) {
      return { onCover: true, hoverSlot: -1 };
    }

    const spineHalf = (ws + gap) * 0.75;
    let bestDist = spineHalf;
    let foundSlot = -1;
    for (let i = 0; i < POOL_SIZE; i++) {
      const sl = pool[i];
      if (sl.el.style.visibility === 'hidden' || !sl.bookRef) continue;
      if (Math.round(T) === sl.v && Math.abs(sl.relR) < 0.45) continue;
      const dist = Math.abs(relX - posX(sl.relR));
      if (dist < bestDist) {
        bestDist = dist;
        foundSlot = i;
      }
    }
    return { onCover: false, hoverSlot: foundSlot };
  }

  // Exact 2D screen-space hit-test so clicking ANYWHERE on the open cover opens it,
  // and clicking any closed spine turns it to the center first
  function hitTestShelf(px, py) {
    if (status !== 'ready' || books.length === 0) return null;

    // 1. Check active centered cover first (full 2D bounding box from top to bottom)
    if (Math.abs(T - s) < 0.45) {
      const targetV = Math.round(T);
      for (const sl of pool) {
        if (sl.el.style.visibility === 'hidden' || !sl.bookRef) continue;
        if (sl.v === targetV && Math.abs(sl.relR) < 0.45) {
          const cvRect = sl.cv.getBoundingClientRect();
          if (pointInRect(px, py, cvRect)) {
            return { type: 'cover', slot: sl, rect: cvRect };
          }
        }
      }
    }

    // 2. Otherwise check visible spines on left & right
    let bestSpine = null;
    let bestDist = Infinity;
    for (const sl of pool) {
      if (sl.el.style.visibility === 'hidden' || !sl.bookRef) continue;
      if (Math.round(T) === sl.v && Math.abs(sl.relR) < 0.45) continue;
      const rect = getSlotVisibleRect(sl);
      if (pointInRect(px, py, rect)) {
        const dist = Math.abs(px - (rect.left + rect.width / 2));
        if (dist < bestDist) {
          bestDist = dist;
          bestSpine = sl;
        }
      }
    }
    if (bestSpine) {
      return { type: 'spine', slot: bestSpine, rect: getSlotVisibleRect(bestSpine) };
    }
    return null;
  }

  // Click handler using exact 2D screen-space geometry:
  // Click anywhere on centered cover -> open detail; click any other spine -> setTarget(slot.v)
  shelfEl.addEventListener('click', (e) => {
    if (dragMoved || overlayOpen || status !== 'ready') return;
    if (e.target && e.target.closest('button')) return;
    const hit = hitTestShelf(e.clientX, e.clientY);
    if (!hit) return;
    if (hit.type === 'cover') {
      onOpenBook(hit.slot.bookRef, hit.rect);
    } else {
      setTarget(hit.slot.v);
    }
  });

  function swapMaskText(container, text, dir, immediate) {
    if (immediate || reducedMotion) {
      container.innerHTML = '';
      const span = document.createElement('span');
      span.textContent = text;
      container.appendChild(span);
      return;
    }

    const oldSpans = Array.from(container.children);
    oldSpans.forEach((old) => {
      if (old.dataset.leaving) return;
      old.dataset.leaving = '1';
      const curTf = getComputedStyle(old).transform;
      const anim = old.animate(
        [
          { transform: curTf === 'none' ? 'translateY(0%)' : curTf },
          { transform: `translateY(${-dir * 105}%)` }
        ],
        { duration: 650, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: 'both' }
      );
      anim.onfinish = () => old.remove();
    });

    const next = document.createElement('span');
    next.textContent = text;
    container.appendChild(next);
    next.animate(
      [
        { transform: `translateY(${dir * 105}%)` },
        { transform: 'translateY(0%)' }
      ],
      { duration: 650, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: 'both' }
    );
  }

  function updateCaption(idx, dir, immediate = false, notify = true) {
    if (books.length === 0) {
      swapMaskText(capTitleEl, '', 1, true);
      swapMaskText(capSubEl, '', 1, true);
      swapMaskText(capYearEl, '', 1, true);
      activeBookId = '';
      return;
    }
    activeIdx = loopMode ? mod(idx, books.length) : Math.max(0, Math.min(books.length - 1, idx));
    const book = books[activeIdx];
    if (!book) return;
    activeBookId = book.identifier;

    swapMaskText(capTitleEl, book.title, dir, immediate);
    swapMaskText(capSubEl, book.creator || 'Khuyết danh', dir, immediate);
    const yrPart = book.year ? `${book.year} · ` : '';
    const lgPart = book.langCode ? `${book.langCode} · ` : '';
    swapMaskText(
      capYearEl,
      `${yrPart}${lgPart}${book.genreLabel || 'Sách'} · #${activeIdx + 1}/${books.length}${hasMorePages ? '+' : ''}`,
      dir,
      immediate
    );
    if (notify && onActiveChange) {
      onActiveChange(book, activeIdx);
    }
  }

  function setStatus(nextStatus, message = '', actionType = 'reset') {
    status = nextStatus;
    if (status === 'ready') {
      statusBoxEl.hidden = true;
      stageEl.classList.remove('is-skeleton');
      return;
    }

    if (status === 'loading') {
      stageEl.classList.add('is-skeleton');
      statusBoxEl.hidden = false;
      statusMsgEl.textContent = message || 'ĐANG TẢI KHO SÁCH…';
      statusActionEl.hidden = true;
      swapMaskText(capTitleEl, 'Đang tải kho sách…', 1, true);
      swapMaskText(capSubEl, 'TÀNG THƯ · THƯ VIỆN MỞ', 1, true);
      swapMaskText(capYearEl, '', 1, true);
      return;
    }

    stageEl.classList.remove('is-skeleton');
    books = [];
    pool.forEach((sl) => {
      sl.el.style.visibility = 'hidden';
      sl.bookRef = null;
    });
    statusBoxEl.hidden = false;
    statusMsgEl.textContent = message;
    statusActionEl.hidden = false;
    statusActionEl.textContent = status === 'error' ? 'THỬ LẠI' : (actionType === 'explore' ? 'KHÁM PHÁ SÁCH' : 'XOÁ BỘ LỌC');
    statusActionEl.onclick = () => {
      if (status === 'error') onRetryLoad();
      else onResetFilters();
    };
    updateCaption(0, 1, true, false);
  }

  function setBooks(nextBooks, { initialIndex = 0, animateSlide = true, hasMore = false, notifyActive = true } = {}) {
    books = Array.isArray(nextBooks) ? nextBooks : [];
    hasMorePages = Boolean(hasMore);
    if (books.length === 0) {
      setStatus('empty', 'Không có sách nào khớp bộ lọc hiện tại.');
      return;
    }

    setStatus('ready');
    loopMode = !hasMorePages && books.length >= 12;

    pool.forEach((sl) => {
      sl.boundKey = '';
      sl.bookRef = null;
    });

    const targetIdx = Math.max(0, Math.min(books.length - 1, initialIndex));
    T = targetIdx;
    if (animateSlide && !reducedMotion) {
      s = Math.max(0, targetIdx - 1.8);
    } else {
      s = targetIdx;
    }
    activeBookId = '';
    updateCaption(targetIdx, 1, !animateSlide, notifyActive);
  }

  function appendBooks(moreBooks, { hasMore = false } = {}) {
    if (!Array.isArray(moreBooks) || moreBooks.length === 0) {
      hasMorePages = false;
      loopMode = books.length >= 12;
      return;
    }
    const existing = new Set(books.map((b) => b.identifier));
    for (const item of moreBooks) {
      if (!existing.has(item.identifier)) {
        existing.add(item.identifier);
        books.push(item);
      }
    }
    hasMorePages = Boolean(hasMore);
    loopMode = !hasMorePages && books.length >= 12;
    updateCaption(activeIdx, 1, true);
  }

  function refreshSavedRibbons() {
    if (status !== 'ready' || books.length === 0) return;
    pool.forEach((sl) => {
      sl.boundKey = '';
    });
  }

  function getActiveBook() {
    if (books.length === 0) return null;
    const idx = loopMode
      ? mod(Math.round(s), books.length)
      : Math.max(0, Math.min(books.length - 1, Math.round(s)));
    return books[idx] || books[0];
  }

  function getActiveCoverRect() {
    let best = pool[0];
    let bestDist = Infinity;
    for (const sl of pool) {
      if (sl.el.style.visibility === 'hidden') continue;
      const dist = Math.abs(sl.relR);
      if (dist < bestDist) {
        bestDist = dist;
        best = sl;
      }
    }
    return getSlotVisibleRect(best);
  }

  function stepBy(delta) {
    if (status !== 'ready' || overlayOpen || books.length === 0) return;
    setTarget(Math.round(T) + delta);
  }

  function focusBook(identifier, { immediate = false } = {}) {
    if (!identifier || books.length === 0) return false;
    const idx = books.findIndex((b) => b.identifier === identifier);
    if (idx < 0) return false;
    if (loopMode) {
      const curMod = mod(Math.round(T), books.length);
      let diff = idx - curMod;
      if (diff > books.length / 2) diff -= books.length;
      if (diff < -books.length / 2) diff += books.length;
      setTarget(Math.round(T) + diff);
    } else {
      setTarget(idx);
    }
    if (immediate || reducedMotion) {
      s = T;
      updateCaption(idx, 1, true);
    }
    return true;
  }

  function setOverlayOpen(flag) {
    overlayOpen = Boolean(flag);
  }

  function setLayoutMode(nextMode) {
    layoutMode = nextMode === 'grid' ? 'grid' : 'shelf';
    if (layoutMode === 'shelf') measure();
  }

  // Pointer & wheel listeners scoped to shelfEl
  shelfEl.addEventListener('pointerdown', (e) => {
    if (layoutMode !== 'shelf' || overlayOpen || status !== 'ready' || e.button !== 0) return;
    if (e.target && e.target.closest('button')) return;
    isDragging = true;
    dragMoved = false;
    dragStartX = e.clientX;
    dragStartT = T;
  });

  window.addEventListener('pointermove', (e) => {
    mx = e.clientX;
    my = e.clientY;
    if (!isDragging) return;
    const dx = mx - dragStartX;
    if (!dragMoved && Math.abs(dx) > 5) {
      dragMoved = true;
    }
    if (dragMoved) {
      setTarget(dragStartT - dx / (ws + gap));
    }
  });

  window.addEventListener('pointerup', () => {
    if (!isDragging) return;
    isDragging = false;
    if (dragMoved) {
      setTarget(Math.round(T));
      setTimeout(() => {
        dragMoved = false;
      }, 40);
    }
  });

  shelfEl.addEventListener('wheel', (e) => {
    if (layoutMode !== 'shelf' || overlayOpen || status !== 'ready' || books.length === 0) return;
    e.preventDefault();
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    setTarget(T + (delta / (ws + gap)) * 0.5);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      setTarget(Math.round(T));
    }, 160);
  }, { passive: false });

  window.addEventListener('resize', measure);
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => {
      if (layoutMode === 'shelf') measure();
    }).observe(shelfEl);
  }
  measure();

  // Main single rAF loop
  let lastTime = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    let onSpine = false;

    if (layoutMode !== 'shelf' || overlayOpen) {
      onCover = false;
      hoverSlot = -1;
      requestAnimationFrame(frame);
      return;
    } else if (status === 'loading') {
      const mid = Math.floor(POOL_SIZE / 2);
      for (let i = 0; i < POOL_SIZE; i++) {
        const sl = pool[i];
        const r = i - mid;
        if (Math.abs(r) > 8) {
          sl.el.style.visibility = 'hidden';
          continue;
        }
        sl.el.style.visibility = 'visible';
        if (sl.boundKey !== '__skeleton__') {
          sl.boundKey = '__skeleton__';
          sl.bookRef = null;
          sl.sp.innerHTML = '<div class="sp-skel"></div>';
          sl.cv.innerHTML = '';
        }
        const x = r * (ws + gap);
        sl.el.style.transform = `translate3d(${x}px, 0px, 0px)`;
      }
      onCover = false;
      hoverSlot = -1;
    } else if (status === 'ready' && books.length > 0) {
      // 1. Spring
      if (reducedMotion) {
        s = T;
      } else {
        const k = isDragging ? 18 : 5.2;
        s += (T - s) * (1 - Math.exp(-k * dt));
        if (Math.abs(T - s) < 1e-4) s = T;
      }

      if (loopMode && Math.abs(s) > books.length * 12) {
        const shift = Math.trunc(s / books.length) * books.length;
        s -= shift;
        T -= shift;
      }

      // Auto-load next page from Internet Archive when approaching the end (throttled)
      if (hasMorePages && onNeedMore && Math.max(s, T) >= books.length - 14) {
        if (now - lastNeedMoreTime > 2500) {
          lastNeedMoreTime = now;
          onNeedMore();
        }
      }

      // 2. Caption update
      const curIdx = loopMode
        ? mod(Math.round(s), books.length)
        : Math.max(0, Math.min(books.length - 1, Math.round(s)));
      const curBook = books[curIdx];
      if (curBook && curBook.identifier !== activeBookId) {
        const dir = T - s >= 0 ? 1 : -1;
        updateCaption(curIdx, dir, false);
      }

      // 3. Fast mathematical hover check over full book cover & spines (0 layout reflows)
      const { onCover: isCov, hoverSlot: hSlot } = checkHoverMath(mx, my);
      onCover = isCov;
      hoverSlot = hSlot;
      onSpine = hoverSlot !== -1;

      const centreX = shelfLeft + W / 2;
      const centreY = shelfTop + SH / 2 - 18;
      const relMx = Math.max(-W / 2, Math.min(W / 2, mx - centreX));
      const targetTiltY = onCover
        ? (relMx / (0.55 * d)) * 9
        : (relMx / Math.max(1, W)) * 5;
      const targetTiltX = onCover
        ? -((my - centreY) / Math.max(1, H / 2)) * 6
        : 0;

      const tiltEase = reducedMotion ? 1 : 1 - Math.exp(-7 * dt);
      tiltY += (targetTiltY - tiltY) * tiltEase;
      tiltX += (targetTiltX - tiltX) * tiltEase;

      // 4. Virtualized 3D cuboids
      const cullLimit = W / 2 + 1.5 * d;
      const liftEase = reducedMotion ? 1 : 1 - Math.exp(-12 * dt);
      const baseV = Math.round(s) - Math.floor(POOL_SIZE / 2);

      for (let i = 0; i < POOL_SIZE; i++) {
        const sl = pool[i];
        const v = baseV + i;

        if (!loopMode && (v < 0 || v >= books.length)) {
          sl.el.style.visibility = 'hidden';
          sl.relR = 99;
          sl.bookRef = null;
          continue;
        }

        const r = v - s;
        sl.v = v;
        sl.relR = r;
        const absR = Math.abs(r);
        const x = posX(r);

        if (Math.abs(x) > cullLimit) {
          sl.el.style.visibility = 'hidden';
          continue;
        }
        sl.el.style.visibility = 'visible';

        const bIdx = loopMode ? mod(v, books.length) : v;
        const book = books[bIdx];
        sl.bookRef = book;
        const saved = isSaved(book.identifier);
        const key = `${book.identifier}::${saved ? 1 : 0}`;
        if (sl.boundKey !== key) {
          sl.boundKey = key;
          renderSpine(sl.sp, book, saved);
          renderCover(sl.cv, book, { eager: false, size: 'w250' });
        }

        const liftTarget = !overlayOpen && hoverSlot === i && absR > 0.5 ? 1 : 0;
        sl.lift += (liftTarget - sl.lift) * liftEase;

        const o = smoothstep(Math.max(0, 1 - absR));
        const rY = -90 * o + tiltY * o;
        const rX = tiltX * o;
        const rZ = -4.5 * o;
        const tZ = o * 0.42 * H;
        const tY = -o * 0.025 * H - sl.lift * 0.045 * H;

        sl.cv.style.pointerEvents = absR < 0.5 ? 'auto' : 'none';
        sl.sp.style.pointerEvents = absR < 0.5 ? 'none' : 'auto';
        sl.el.style.zIndex = String(Math.round(100 - absR * 4));
        sl.el.style.transform = `translate3d(${x}px, ${tY}px, ${tZ}px) rotateZ(${rZ}deg) rotateX(${rX}deg) rotateY(${rY}deg)`;
        sl.sp.style.setProperty('--shade', (o * 0.55).toFixed(3));
        sl.cv.style.setProperty('--shade', ((1 - o) * 0.5).toFixed(3));
      }
    } else {
      onCover = false;
      hoverSlot = -1;
    }

    if (layoutMode === 'shelf') {
      shelfEl.style.cursor = isDragging ? 'grabbing' : (onCover || onSpine ? 'pointer' : 'grab');
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  return {
    setBooks,
    appendBooks,
    setStatus,
    stepBy,
    focusBook,
    setOverlayOpen,
    setLayoutMode,
    refreshSavedRibbons,
    getActiveBook,
    getActiveCoverRect,
    isReducedMotion: () => reducedMotion
  };
}
