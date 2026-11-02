import { buildPosterDataUrl, getCoverImageUrls } from './cover.js';
import { fetchItemMetadata } from './archive.js';
import { isSaved, toggleSave, getProgress } from './store.js';

const BLOB_DELAYS = [0, 120, 220, 300, 360, 420, 180];

export function createDetail({
  detailEl,
  closeBtnEl,
  detSubEl,
  detBadgeEl,
  detTitleEl,
  detMetaEl,
  detSynEl,
  detReadBtnEl,
  detSaveBtnEl,
  detExtLinkEl,
  detImgEl,
  inkBlobsEls,
  detLineEls,
  getCoverRect,
  isReducedMotion,
  onOpenReader,
  onCloseComplete
}) {
  let currentBook = null;
  let currentMeta = null;
  let isOpen = false;
  let detailAnims = [];
  let inkRaf = 0;
  let metaAbort = null;

  function syncSaveButton() {
    if (!currentBook) return;
    const saved = isSaved(currentBook.identifier);
    detSaveBtnEl.textContent = saved ? 'ĐÃ LƯU ✓' : 'LƯU SÁCH';
    detSaveBtnEl.classList.toggle('is-saved', saved);
  }

  function syncReadButton() {
    if (!currentBook) return;
    const prog = getProgress(currentBook.identifier);
    if (prog && prog.verified) {
      const pct = Math.max(1, Math.min(100, Math.round((prog.ratio || 0) * 100)));
      detReadBtnEl.textContent = prog.posLabel
        ? `ĐỌC TIẾP · ${prog.posLabel.toUpperCase()} (${pct}%)`
        : `ĐỌC TIẾP (${pct}%)`;
    } else {
      detReadBtnEl.textContent = 'ĐỌC SÁCH';
    }
  }

  function open(book, initialRect) {
    if (!book || isOpen) return;
    isOpen = true;
    currentBook = book;
    currentMeta = null;
    const reduced = isReducedMotion();

    detSubEl.textContent = book.creator || 'Khuyết danh';
    detBadgeEl.textContent = 'BẢN IN GỐC';
    detTitleEl.textContent = book.title;
    const yr = book.year ? `${book.year} · ` : '';
    const lg = book.langCode ? `${book.langCode} · ` : '';
    const dl = book.downloads > 0 ? `${book.downloads.toLocaleString('vi-VN')} LƯỢT ĐỌC · ` : '';
    detMetaEl.textContent = `${yr}${lg}${dl}${book.genreLabel || 'Sách'} · MÃ: ${book.identifier}`;
    detSynEl.textContent = book.description || 'Ấn bản in nguyên bản sưu tầm trong kho sách mở.';
    detExtLinkEl.href = book.archivePageUrl || `https://archive.org/details/${encodeURIComponent(book.identifier)}`;

    syncSaveButton();
    syncReadButton();

    const fallbackPoster = buildPosterDataUrl(book);
    detImgEl.setAttribute('href', fallbackPoster);
    detImgEl.setAttribute('x', '0');
    detImgEl.setAttribute('y', '0');
    detImgEl.setAttribute('width', '600');
    detImgEl.setAttribute('height', '900');
    detImgEl.setAttribute('preserveAspectRatio', 'xMidYMid slice');

    const [hiUrl, thumbUrl] = getCoverImageUrls(book.identifier);
    const probeImg = new Image();
    let triedThumb = false;
    probeImg.onload = () => {
      if (!currentBook || currentBook.identifier !== book.identifier) return;
      const w = probeImg.naturalWidth;
      const h = probeImg.naturalHeight;
      if (w < 85 || h < 95) {
        if (!triedThumb) {
          triedThumb = true;
          probeImg.src = thumbUrl;
        }
        return;
      }
      const ratio = w / h;
      const fitMode = ratio >= 0.50 && ratio <= 0.84 && w >= 140 ? 'xMidYMid slice' : 'xMidYMid meet';
      detImgEl.setAttribute('preserveAspectRatio', fitMode);
      detImgEl.setAttribute('href', probeImg.src);
    };
    probeImg.onerror = () => {
      if (!triedThumb) {
        triedThumb = true;
        probeImg.src = thumbUrl;
      }
    };
    probeImg.src = hiUrl;

    if (metaAbort) metaAbort.abort();
    metaAbort = new AbortController();
    fetchItemMetadata(book, metaAbort.signal)
      .then((meta) => {
        if (!currentBook || currentBook.identifier !== book.identifier) return;
        currentMeta = meta;
        detBadgeEl.textContent = meta.leafCount > 0 ? `BẢN IN · ${meta.leafCount} TRANG` : 'BẢN IN GỐC';
        if (!book.description && meta.description) {
          detSynEl.textContent = meta.description.slice(0, 320);
        }
      })
      .catch((err) => {
        if (err && err.name === 'AbortError') return;
        detBadgeEl.textContent = 'BẢN IN GỐC';
      });

    inkBlobsEls.forEach((c) => c.setAttribute('r', '0'));

    const W = window.innerWidth;
    const VH = window.innerHeight;
    const rect = initialRect || getCoverRect();
    const top = Math.max(0, rect.top);
    const left = Math.max(0, rect.left);
    const right = Math.max(0, W - rect.right);
    const bottom = Math.max(0, VH - rect.bottom);
    const cxRect = rect.left + rect.width / 2;
    const cyRect = rect.top + rect.height / 2;

    detailEl.style.visibility = 'visible';
    detailEl.style.transformOrigin = `${cxRect}px ${cyRect}px`;

    detailAnims.forEach((a) => a.cancel());
    detailAnims = [];

    const sheetAnim = detailEl.animate(
      [
        {
          clipPath: `inset(${top}px ${right}px ${bottom}px ${left}px round 3px)`,
          transform: 'rotate(-4.5deg)'
        },
        {
          clipPath: 'inset(0px 0px 0px 0px round 0px)',
          transform: 'rotate(0deg)'
        }
      ],
      {
        duration: reduced ? 1 : 1050,
        easing: 'cubic-bezier(.76, 0, .18, 1)',
        fill: 'both'
      }
    );
    detailAnims.push(sheetAnim);

    detLineEls.forEach((line, idx) => {
      const lineAnim = line.animate(
        [
          { transform: 'translateY(110%)' },
          { transform: 'translateY(0%)' }
        ],
        {
          duration: reduced ? 1 : 900,
          delay: reduced ? 0 : 620 + idx * 75,
          easing: 'cubic-bezier(.2, .8, .2, 1)',
          fill: 'both'
        }
      );
      detailAnims.push(lineAnim);
    });

    cancelAnimationFrame(inkRaf);
    const startInk = performance.now() - (reduced ? 5000 : 0);
    function tickInk(now) {
      const elapsed = now - startInk - 520;
      for (let i = 0; i < inkBlobsEls.length; i++) {
        const t = elapsed - BLOB_DELAYS[i];
        if (t <= 0) {
          inkBlobsEls[i].setAttribute('r', '0');
        } else {
          const p = Math.min(1, t / 1250);
          const eased = 1 - Math.pow(1 - p, 3);
          inkBlobsEls[i].setAttribute('r', String(eased * 720));
        }
      }
      if (now - startInk < 2400) {
        inkRaf = requestAnimationFrame(tickInk);
      }
    }
    inkRaf = requestAnimationFrame(tickInk);
  }

  function close() {
    if (!isOpen) return;
    if (metaAbort) metaAbort.abort();
    cancelAnimationFrame(inkRaf);

    const reduced = isReducedMotion();
    const W = window.innerWidth;
    const VH = window.innerHeight;
    const rect = getCoverRect();
    const top = Math.max(0, rect.top);
    const left = Math.max(0, rect.left);
    const right = Math.max(0, W - rect.right);
    const bottom = Math.max(0, VH - rect.bottom);
    const cxRect = rect.left + rect.width / 2;
    const cyRect = rect.top + rect.height / 2;

    detailEl.style.transformOrigin = `${cxRect}px ${cyRect}px`;

    const closeAnim = detailEl.animate(
      [
        {
          clipPath: 'inset(0px 0px 0px 0px round 0px)',
          transform: 'rotate(0deg)'
        },
        {
          clipPath: `inset(${top}px ${right}px ${bottom}px ${left}px round 3px)`,
          transform: 'rotate(-4.5deg)'
        }
      ],
      {
        duration: reduced ? 1 : 850,
        easing: 'cubic-bezier(.76, 0, .18, 1)',
        fill: 'both'
      }
    );

    closeAnim.onfinish = () => {
      detailEl.style.visibility = 'hidden';
      detailAnims.forEach((a) => a.cancel());
      detailAnims = [];
      closeAnim.cancel();
      isOpen = false;
      onCloseComplete();
    };
  }

  closeBtnEl.addEventListener('click', close);

  detSaveBtnEl.addEventListener('click', () => {
    if (!currentBook) return;
    toggleSave(currentBook);
    syncSaveButton();
  });

  detReadBtnEl.addEventListener('click', () => {
    if (!currentBook) return;
    onOpenReader(currentBook, currentMeta);
  });

  window.addEventListener('kesach:saved-change', () => {
    if (isOpen) syncSaveButton();
  });

  return {
    open,
    close,
    syncReadButton,
    isOpen: () => isOpen
  };
}
