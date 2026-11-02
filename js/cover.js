const PALETTES = [
  { bg: '#F3F0E8', ink: '#141414', accent: '#1F3FB0', spineBg: '#1F3FB0', spineFg: '#F4F2ED' },
  { bg: '#F2EDE4', ink: '#141414', accent: '#9E3321', spineBg: '#9E3321', spineFg: '#F4F2ED' },
  { bg: '#EAE6DC', ink: '#141414', accent: '#274437', spineBg: '#1E2421', spineFg: '#EDEBE6' },
  { bg: '#EFECE4', ink: '#141414', accent: '#7A5019', spineBg: '#2C2620', spineFg: '#F4F2ED' }
];

export function hashStr(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function getBookVisual(book) {
  const h = hashStr(book.identifier || book.title);
  const palette = PALETTES[h % PALETTES.length];
  const motif = (h >>> 3) % 4;
  return { palette, motif, hash: h };
}

export function getCoverImageUrls(identifier) {
  const enc = encodeURIComponent(identifier);
  return [
    `https://archive.org/download/${enc}/page/cover_w500.jpg`,
    `https://archive.org/services/img/${enc}`
  ];
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortCreator(creator) {
  const clean = String(creator || 'Khuyết danh').split(/[·;,]/)[0].trim();
  return clean.length > 22 ? `${clean.slice(0, 20)}…` : clean;
}

function motifSvg(motif, accent, ink) {
  switch (motif) {
    case 0:
      return `<svg viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r="42" fill="${accent}" />
        <circle cx="60" cy="60" r="24" fill="none" stroke="${ink}" stroke-width="1.5" />
        <line x1="12" y1="60" x2="108" y2="60" stroke="${ink}" stroke-width="1.2" />
      </svg>`;
    case 1:
      return `<svg viewBox="0 0 120 120" aria-hidden="true">
        <rect x="20" y="18" width="80" height="84" fill="none" stroke="${ink}" stroke-width="1.5" />
        <rect x="32" y="30" width="56" height="60" fill="${accent}" />
        <line x1="20" y1="60" x2="100" y2="60" stroke="#F4F2ED" stroke-width="1.5" />
      </svg>`;
    case 2:
      return `<svg viewBox="0 0 120 120" aria-hidden="true">
        <polygon points="18,100 60,20 102,100" fill="${accent}" />
        <circle cx="60" cy="70" r="16" fill="#F4F2ED" />
      </svg>`;
    default:
      return `<svg viewBox="0 0 120 120" aria-hidden="true">
        <path d="M26 102 V54 A34 34 0 0 1 94 54 V102 Z" fill="${accent}" />
        <line x1="60" y1="20" x2="60" y2="102" stroke="#F4F2ED" stroke-width="1.5" />
      </svg>`;
  }
}

export function renderSpine(el, book, saved) {
  const { palette } = getBookVisual(book);
  el.style.setProperty('--sp-bg', palette.spineBg);
  el.style.setProperty('--sp-fg', palette.spineFg);
  el.style.setProperty('--sp-accent', palette.accent);

  const authorShort = shortCreator(book.creator);
  const langTag = escapeHtml(book.langCode || 'SÁCH');
  el.innerHTML = `
    <div class="sp-inner">
      <div class="sp-ribbon ${saved ? 'is-on' : ''}" aria-hidden="true"></div>
      <div class="sp-year">${escapeHtml(book.year || langTag)}</div>
      <div class="sp-title">${escapeHtml(book.title)}</div>
      <div class="sp-foot">
        <span class="sp-author">${escapeHtml(authorShort)}</span>
        <span class="sp-badge">${langTag}</span>
      </div>
    </div>
  `;
}

// Bộ nhớ đệm trạng thái ảnh bìa: bookIdentifier -> 'ok' | 'failed'
const coverStatusCache = new Map();

let coverObserver = null;
function getCoverObserver() {
  if (!coverObserver && typeof window !== 'undefined' && 'IntersectionObserver' in window) {
    coverObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const el = entry.target;
          coverObserver.unobserve(el);
          if (typeof el.__triggerCoverLoad === 'function') {
            el.__triggerCoverLoad();
            delete el.__triggerCoverLoad;
          }
        }
      }
    }, { rootMargin: '250px 0px' });
  }
  return coverObserver;
}

export function renderCover(el, book, { eager = false, compact = false, size = 'w250' } = {}) {
  const { palette, motif } = getBookVisual(book);
  el.style.setProperty('--cv-bg', palette.bg);
  el.style.setProperty('--cv-ink', palette.ink);
  el.style.setProperty('--cv-accent', palette.accent);

  const [hiUrl, fallbackUrl] = getCoverImageUrls(book.identifier);
  const targetCoverUrl = size === 'w250' ? hiUrl.replace('_w500.jpg', '_w250.jpg') : hiUrl;
  const badge = (book.langCode || 'SÁCH').toUpperCase().slice(0, 7);

  el.innerHTML = compact
    ? `
      <div class="cv-mini-fallback" aria-hidden="true">${motifSvg(motif, palette.accent, palette.ink)}</div>
      <img class="cv-full-img cv-mini-img" alt="" loading="${eager ? 'eager' : 'lazy'}" decoding="async" />
    `
    : `
      <div class="cv-inner">
        <div class="cv-top">
          <span class="cv-kicker">${escapeHtml(shortCreator(book.creator))}</span>
          <span class="cv-yr">${escapeHtml(book.year || '')}</span>
        </div>
        <div class="cv-title-wrap">
          <div class="cv-title">${escapeHtml(book.title)}</div>
        </div>
        <div class="cv-art">
          <div class="cv-motif">${motifSvg(motif, palette.accent, palette.ink)}</div>
        </div>
        <div class="cv-bottom">
          <span class="cv-pub">TÀNG THƯ</span>
          <span class="cv-tag">${escapeHtml(badge)}</span>
        </div>
      </div>
      <img class="cv-full-img" alt="" loading="${eager ? 'eager' : 'lazy'}" decoding="async" />
    `;

  const img = el.querySelector('.cv-full-img');
  if (!img) return;

  // Nếu cuốn sách này đã xác định không có ảnh bìa trên mạng -> dùng luôn bìa vẽ mặc định
  if (coverStatusCache.get(book.identifier) === 'failed') {
    img.remove();
    return;
  }

  function startLoad() {
    let triedFallback = false;

    img.addEventListener('load', () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w < 85 || h < 95) {
        if (!triedFallback) {
          triedFallback = true;
          img.src = fallbackUrl;
        } else {
          coverStatusCache.set(book.identifier, 'failed');
          img.remove();
        }
        return;
      }
      coverStatusCache.set(book.identifier, 'ok');
      const ratio = w / h;
      // Portrait book covers fill cleanly; wide/square/skinny covers frame with object-fit: contain so nothing stretches
      if (ratio < 0.50 || ratio > 0.84 || w < 140) {
        img.classList.add('is-contain');
      }
      img.classList.add('is-ready');
    });

    img.addEventListener('error', () => {
      if (!triedFallback) {
        triedFallback = true;
        img.src = fallbackUrl;
      } else {
        coverStatusCache.set(book.identifier, 'failed');
        img.remove();
      }
    });

    img.src = targetCoverUrl;
  }

  // Tải ngay nếu là banner tiêu điểm Hero, hộp thoại chi tiết hoặc thanh đang đọc dở
  // Với các thẻ sách trong danh sách cuộn: chỉ kích hoạt khi lọt vào vùng nhìn thấy (IntersectionObserver)
  if (eager) {
    startLoad();
  } else {
    const observer = getCoverObserver();
    if (observer) {
      el.__triggerCoverLoad = startLoad;
      observer.observe(el);
    } else {
      startLoad();
    }
  }
}

export function buildPosterDataUrl(book) {
  const { palette, motif } = getBookVisual(book);
  const title = escapeHtml(book.title || '');
  const creator = escapeHtml(shortCreator(book.creator).toUpperCase());
  const year = escapeHtml(book.year || 'THƯ VIỆN MỞ');
  const langTag = escapeHtml(book.langCode || 'SÁCH');

  const words = title.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > 22 && lines.length < 2) {
      lines.push(cur.trim());
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) lines.push(cur);

  const titleSvg = lines.slice(0, 3).map((ln, idx) =>
    `<text x="52" y="${152 + idx * 56}" font-family="Newsreader, Georgia, serif" font-size="46" fill="${palette.ink}">${ln}</text>`
  ).join('');

  const artY = 340;
  let geo = `<circle cx="300" cy="${artY + 190}" r="145" fill="${palette.accent}" />`;
  if (motif === 1) {
    geo = `<rect x="130" y="${artY + 40}" width="340" height="300" fill="${palette.accent}" />
           <line x1="130" y1="${artY + 190}" x2="470" y2="${artY + 190}" stroke="#F4F2ED" stroke-width="3" />`;
  } else if (motif === 2) {
    geo = `<polygon points="130,${artY + 330} 300,${artY + 40} 470,${artY + 330}" fill="${palette.accent}" />`;
  } else if (motif === 3) {
    geo = `<path d="M160 ${artY + 340} V${artY + 165} A140 140 0 0 1 440 ${artY + 165} V${artY + 340} Z" fill="${palette.accent}" />`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
    <rect width="600" height="900" fill="${palette.bg}" />
    <rect x="24" y="24" width="552" height="852" fill="none" stroke="${palette.ink}" stroke-width="1.5" />
    <text x="52" y="72" font-family="Inter Tight, sans-serif" font-size="15" font-weight="600" letter-spacing="3" fill="${palette.accent}">${creator}</text>
    <line x1="52" y1="92" x2="548" y2="92" stroke="${palette.ink}" stroke-width="1" />
    ${titleSvg}
    <rect x="52" y="${artY}" width="496" height="420" fill="none" stroke="${palette.ink}" stroke-width="1.2" />
    ${geo}
    <text x="52" y="835" font-family="Inter Tight, sans-serif" font-size="14" font-weight="600" letter-spacing="2" fill="${palette.ink}">TÀNG THƯ · ${year}</text>
    <rect x="478" y="814" width="70" height="28" fill="none" stroke="${palette.ink}" stroke-width="1.2" />
    <text x="513" y="833" text-anchor="middle" font-family="Inter Tight, sans-serif" font-size="13" font-weight="600" letter-spacing="2" fill="${palette.ink}">${langTag}</text>
  </svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
