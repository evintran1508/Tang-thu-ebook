import { cachedFetchResponse, cachedFetchText } from './store.js';

let catalogCache = null;
const metaCache = new Map();
const ocrCache = new Map();
const searchResultCache = new Map();

const JUNK_ID_RE = /^(?:haodbvn-|arc_googledrive|nhanxetmoinhat|bong-88|arxiv-|pubmed-|DTIC_|vnthuquan$)/i;
const JUNK_TITLE_RE = /\b(?:bong88|bong\s*88|nha\s*cai|casino|data-phim)\b/i;

export function stripMarks(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

const LANG_CLAUSES = {
  all: 'language:(vie OR vietnamese OR eng OR english OR fra OR french OR deu OR german OR spa OR spanish OR zho OR chinese OR jpn OR japanese OR rus OR russian)',
  vie: 'language:(vie OR vietnamese)',
  eng: 'language:(eng OR english)',
  fra: 'language:(fra OR fre OR french)',
  zho: 'language:(zho OR chi OR chinese)',
  jpn: 'language:(jpn OR japanese)',
  deu: 'language:(deu OR ger OR german)',
  spa: 'language:(spa OR spanish)',
  rus: 'language:(rus OR russian)'
};

function normalizeLangCode(rawLang) {
  const first = Array.isArray(rawLang) ? rawLang[0] : rawLang;
  const s = String(first || '').trim().toLowerCase();
  if (!s) return 'SÁCH';
  if (s.startsWith('vi')) return 'VIE';
  if (s.startsWith('en')) return 'ENG';
  if (s.startsWith('fr')) return 'FRA';
  if (s.startsWith('zh') || s.startsWith('chi')) return 'ZHO';
  if (s.startsWith('ja') || s.startsWith('jp')) return 'JPN';
  if (s.startsWith('de') || s.startsWith('ger')) return 'DEU';
  if (s.startsWith('sp') || s.startsWith('es')) return 'SPA';
  if (s.startsWith('ru')) return 'RUS';
  return s.slice(0, 3).toUpperCase();
}

function buildCorsDownloadUrl(identifier, fileName) {
  const encoded = fileName.split('/').map(encodeURIComponent).join('/');
  return `https://archive.org/cors/${encodeURIComponent(identifier)}/${encoded}`;
}

export async function loadSeedCatalog() {
  if (!catalogCache) {
    try {
      const res = await fetch('./data/catalog.json');
      catalogCache = res.ok ? await res.json() : [];
    } catch {
      catalogCache = [];
    }
  }
  return catalogCache;
}

export function inferGenre(doc) {
  const hay = stripMarks(
    [
      doc.title || '',
      Array.isArray(doc.subject) ? doc.subject.join(' ') : doc.subject || ''
    ].join(' ')
  );
  if (/\b(dac\s+nhan\s+tam|tu\s+hoc|thanh\s+cong|lam\s+giau|ky\s+nang|tam\s+ly|song\s+dep|thoi\s+quen|self-help|personal\s+development|psychology)\b/.test(hay)) {
    return { genre: 'selfhelp', genreLabel: 'Kỹ năng & Sống đẹp' };
  }
  if (/\b(tho|thi\s+tap|ngam|kieu|van\s+tien|ca\s+dao|luc\s+bat|thi\s+nhan|poetry|poems|verse|sonnets)\b/.test(hay)) {
    return { genre: 'poetry', genreLabel: 'Thơ ca' };
  }
  if (/\b(su|lich\s+su|phong\s+tuc|nho\s+giao|phat\s+giao|kinh\s+dich|mac\s+tu|hoi\s+ky|triet|van\s+hoa|tu\s+dien|khao\s+cuu|history|philosophy|biography|civilization|science)\b/.test(hay)) {
    return { genre: 'history', genreLabel: 'Sử & Khảo cứu' };
  }
  if (/\b(truyen\s+ngan|tuy\s+but|tap\s+van|but\s+ky|truyen\s+ky|pho\s+phuong|tap\s+chi|short\s+stories|essays|tales)\b/.test(hay)) {
    return { genre: 'short', genreLabel: 'Truyện & Ký' };
  }
  return { genre: 'novel', genreLabel: 'Tiểu thuyết' };
}

function cleanCreator(rawCreator) {
  if (!rawCreator) return 'Khuyết danh';
  const str = Array.isArray(rawCreator) ? rawCreator.slice(0, 2).join('; ') : String(rawCreator);
  const cleaned = str.replace(/\s+/g, ' ').trim();
  return cleaned || 'Khuyết danh';
}

function normalizeDoc(doc) {
  if (!doc || !doc.identifier) return null;
  if (JUNK_ID_RE.test(doc.identifier)) return null;
  const title = String(doc.title || doc.identifier).replace(/\s+/g, ' ').trim();
  if (!title || JUNK_TITLE_RE.test(title)) return null;

  const creator = cleanCreator(doc.creator);
  if (JUNK_TITLE_RE.test(creator)) return null;

  const { genre, genreLabel } = inferGenre(doc);
  const langCode = normalizeLangCode(doc.language);
  const desc = Array.isArray(doc.description)
    ? doc.description.join(' ')
    : String(doc.description || '');

  const yearNum = parseInt(doc.year, 10);
  const year = Number.isFinite(yearNum) ? yearNum : '';

  return {
    identifier: doc.identifier,
    title,
    creator,
    langCode,
    year,
    genre,
    genreLabel,
    downloads: Number(doc.downloads || 0),
    week: Number(doc.week || 0),
    month: Number(doc.month || 0),
    description:
      desc.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').slice(0, 320).trim() ||
      `Ấn bản in lưu trữ nguyên bản (Mã: ${doc.identifier}).`
  };
}

function buildGenreClause(genre, lang, hasQuery) {
  switch (genre) {
    case 'selfhelp':
      return '(title:("đắc nhân tâm" OR "dac nhan tam" OR "tự học" OR "thành công" OR "làm giàu" OR "kỹ năng" OR "tâm lý" OR "hạnh phúc" OR "thói quen" OR habits OR confidence) OR creator:("Dale Carnegie" OR "Napoleon Hill" OR "Nguyễn Hiến Lê" OR "Nguyễn Duy Cần") OR subject:(self-help OR psychology OR "kỹ năng sống"))';
    case 'novel':
      return '(title:("tiểu thuyết" OR "truyện dài" OR novel) OR subject:("tiểu thuyết" OR fiction OR novel OR novels OR literature OR "văn học"))';
    case 'short':
      return '(title:("truyện ngắn" OR "tùy bút" OR "bút ký" OR "tuyển tập" OR tales OR stories) OR subject:("truyện ngắn" OR "tùy bút" OR "short stories" OR essays OR tales))';
    case 'poetry':
      return '(title:(thơ OR "thi tập" OR ngâm OR kiều OR poems OR poetry) OR subject:(thơ OR poetry OR poems OR ballads))';
    case 'history':
      return '(title:(sử OR "lịch sử" OR "phong tục" OR "triết học" OR "khảo cứu" OR history OR philosophy) OR subject:("lịch sử" OR history OR philosophy OR biography OR "văn hóa"))';
    default:
      if (!hasQuery && lang !== 'vie') {
        return '(subject:(fiction OR literature OR novel OR history OR philosophy OR poetry OR "văn học" OR "tiểu thuyết") OR language:(vie OR vietnamese))';
      }
      return '';
  }
}

function buildEraClause(era) {
  switch (era) {
    case 'pre1945':
      return 'year:[1000 TO 1945]';
    case '1946-1975':
      return 'year:[1946 TO 1975]';
    case '1976-2000':
      return 'year:[1976 TO 2000]';
    case 'post2000':
      return 'year:[2001 TO 2099]';
    default:
      return '';
  }
}

export async function fetchArchiveBooksPage({
  genre = 'all',
  lang = 'all',
  era = 'all',
  author = 'all',
  sort = 'downloads desc',
  query = '',
  page = 1,
  rows = 24,
  savedList = [],
  signal
}) {
  const trimmedQ = query.trim();
  const foldedQ = stripMarks(trimmedQ);

  if (genre === 'saved') {
    const filtered = savedList.filter((b) => {
      if (lang !== 'all' && (b.langCode || '').toLowerCase() !== lang.toLowerCase()) return false;
      if (era !== 'all') {
        const y = Number(b.year || 0);
        if (era === 'pre1945' && !(y > 0 && y <= 1945)) return false;
        if (era === '1946-1975' && !(y >= 1946 && y <= 1975)) return false;
        if (era === '1976-2000' && !(y >= 1976 && y <= 2000)) return false;
        if (era === 'post2000' && !(y >= 2001)) return false;
      }
      if (author !== 'all' && !stripMarks(b.creator).includes(stripMarks(author))) return false;
      if (foldedQ) {
        const hay = stripMarks(`${b.title} ${b.creator} ${b.description || ''}`);
        if (!hay.includes(foldedQ)) return false;
      }
      return true;
    });
    filtered.sort((a, b) => {
      if (sort === 'year desc') return Number(b.year || 0) - Number(a.year || 0);
      if (sort === 'year asc') return (Number(a.year) || 9999) - (Number(b.year) || 9999);
      if (sort === 'week desc') return Number(b.week || 0) - Number(a.week || 0);
      if (sort === 'month desc') return Number(b.month || 0) - Number(a.month || 0);
      return Number(b.downloads || 0) - Number(a.downloads || 0);
    });
    return {
      items: filtered,
      numFound: filtered.length,
      hasMore: false
    };
  }

  const cacheKey = `${genre}|${lang}|${era}|${author}|${sort}|${foldedQ}|${page}|${rows}`;
  if (searchResultCache.has(cacheKey)) {
    return searchResultCache.get(cacheKey);
  }

  const clauses = [
    'mediatype:texts',
    'NOT collection:(inlibrary OR printdisabled OR pubmed OR arxiv)',
    'format:"Single Page Processed JP2 ZIP"',
    'format:"Item Tile"'
  ];

  if (lang !== 'all' && LANG_CLAUSES[lang] && !(trimmedQ && lang === 'vie')) {
    clauses.push(LANG_CLAUSES[lang]);
  } else if (!trimmedQ && LANG_CLAUSES.all) {
    clauses.push(LANG_CLAUSES.all);
  }

  const gClause = buildGenreClause(genre, lang, Boolean(trimmedQ));
  if (gClause) clauses.push(gClause);

  const eClause = buildEraClause(era);
  if (eClause) clauses.push(eClause);

  if (author !== 'all') {
    const safeAuthor = author.replace(/"/g, '');
    clauses.push(`(creator:"${safeAuthor}" OR title:"${safeAuthor}")`);
  }

  if (trimmedQ) {
    const safeQ = trimmedQ.replace(/"/g, '');
    const safeFold = foldedQ.replace(/"/g, '');
    if (safeFold && safeFold !== safeQ.toLowerCase()) {
      clauses.push(`("${safeQ}" OR "${safeFold}" OR title:(${safeQ}) OR title:(${safeFold}) OR creator:(${safeQ}))`);
    } else {
      clauses.push(`("${safeQ}" OR title:(${safeQ}) OR creator:(${safeQ}))`);
    }
  }

  const iaQuery = clauses.join(' AND ');
  const url =
    `https://archive.org/advancedsearch.php?q=${encodeURIComponent(iaQuery)}` +
    '&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=language&fl[]=year&fl[]=subject&fl[]=downloads&fl[]=week&fl[]=month' +
    `&sort[]=${encodeURIComponent(sort)}` +
    `&rows=${rows}&page=${page}&output=json`;

  const res = await fetch(url, { signal, mode: 'cors' });
  if (!res.ok) throw new Error(`Internet Archive HTTP ${res.status}`);
  const data = await res.json();
  const resp = (data && data.response) || {};
  const docs = Array.isArray(resp.docs) ? resp.docs : [];
  const numFound = Number(resp.numFound || 0);

  const normalized = [];
  const seen = new Set();

  function pushUnique(item) {
    if (!item || seen.has(item.identifier)) return;
    seen.add(item.identifier);
    normalized.push(item);
  }

  // Preserve Internet Archive's true automatic ranking order (downloads, week, month, year)
  for (const doc of docs) {
    pushUnique(normalizeDoc(doc));
  }

  // Append accent-folded matches from curated catalog when user searches by keyword
  if (page === 1 && foldedQ) {
    const seeds = await loadSeedCatalog();
    for (const sItem of seeds) {
      if (genre !== 'all' && sItem.genre !== genre) continue;
      if (lang !== 'all' && (sItem.langCode || '').toLowerCase() !== lang.toLowerCase()) continue;
      const hay = stripMarks(`${sItem.title} ${sItem.creator} ${sItem.description || ''}`);
      if (hay.includes(foldedQ)) {
        pushUnique(sItem);
      }
    }
  }

  const result = {
    items: normalized,
    numFound: Math.max(numFound, normalized.length),
    hasMore: page * rows < numFound
  };
  if (searchResultCache.size > 100) {
    const firstKey = searchResultCache.keys().next().value;
    searchResultCache.delete(firstKey);
  }
  searchResultCache.set(cacheKey, result);
  return result;
}

export function buildScanPageUrl(identifier, leafIndex, width = 1200) {
  const leaf = Math.max(0, Math.floor(Number(leafIndex) || 0));
  return `https://archive.org/download/${encodeURIComponent(identifier)}/page/n${leaf}_w${width}.jpg`;
}

export async function fetchItemMetadata(bookOrId, signal) {
  const identifier = typeof bookOrId === 'string' ? bookOrId : bookOrId.identifier;
  if (metaCache.has(identifier)) return metaCache.get(identifier);

  const url = `https://archive.org/metadata/${encodeURIComponent(identifier)}`;
  const res = await fetch(url, { signal, mode: 'cors' });
  if (!res.ok) throw new Error(`Metadata HTTP ${res.status}`);
  const raw = await res.json();
  const files = Array.isArray(raw.files) ? raw.files : [];

  const scandataFile = files.find(
    (f) => f.name && (/scandata/i.test(f.format || '') || /_scandata\.xml$/i.test(f.name))
  );
  const pageNumFile = files.find(
    (f) => f.name && (/Page Numbers JSON/i.test(f.format || '') || /_page_numbers\.json$/i.test(f.name))
  );
  const pageIndexFile = files.find(
    (f) => f.name && (/OCR Page Index/i.test(f.format || '') || /_hocr_pageindex\.json\.gz$/i.test(f.name))
  );
  const searchTextFile = files.find(
    (f) => f.name && (/OCR Search Text/i.test(f.format || '') || /_hocr_searchtext\.txt\.gz$/i.test(f.name))
  );
  const djvuTxtFile = files.find(
    (f) => f.name && /_djvu\.txt$/i.test(f.name)
  );

  const metaDesc = raw.metadata && raw.metadata.description
    ? (Array.isArray(raw.metadata.description)
      ? raw.metadata.description.join(' ')
      : String(raw.metadata.description))
      .replace(/<[^>]+>/g, '')
      .trim()
    : '';

  const imgCount = Number(raw.metadata && raw.metadata.imagecount) || 0;

  const info = {
    identifier,
    description: metaDesc,
    leafCount: imgCount > 0 ? imgCount : 0,
    scandataUrl: scandataFile ? buildCorsDownloadUrl(identifier, scandataFile.name) : null,
    pageNumbersUrl: pageNumFile ? buildCorsDownloadUrl(identifier, pageNumFile.name) : null,
    pageIndexUrl: pageIndexFile ? buildCorsDownloadUrl(identifier, pageIndexFile.name) : null,
    searchTextUrl: searchTextFile ? buildCorsDownloadUrl(identifier, searchTextFile.name) : null,
    djvuTxtUrl: djvuTxtFile ? buildCorsDownloadUrl(identifier, djvuTxtFile.name) : null,
    embedUrl: `https://archive.org/embed/${encodeURIComponent(identifier)}`,
    archivePageUrl: `https://archive.org/details/${encodeURIComponent(identifier)}`
  };

  metaCache.set(identifier, info);
  return info;
}

export async function resolveLeafCount(meta, signal) {
  if (!meta) return 0;
  if (meta.leafCount > 0) return meta.leafCount;

  if (meta.scandataUrl) {
    try {
      const xml = await cachedFetchText(meta.scandataUrl, signal);
      const m = xml.match(/<leafCount>\s*(\d+)\s*<\/leafCount>/i);
      if (m && Number(m[1]) > 0) {
        meta.leafCount = Number(m[1]);
        return meta.leafCount;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
    }
  }

  if (meta.pageNumbersUrl) {
    try {
      const raw = await cachedFetchText(meta.pageNumbersUrl, signal);
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.pages) && parsed.pages.length > 0) {
        meta.leafCount = parsed.pages.length;
        return meta.leafCount;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
    }
  }

  return 0;
}

async function fetchGunzipText(url, signal) {
  const res = await cachedFetchResponse(url, signal);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (typeof DecompressionStream !== 'undefined' && res.body) {
    const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  return res.text();
}

export async function fetchLeafSpeechText(meta, leafIndex, totalLeaves, signal) {
  if (!meta) return '';
  let ocr = ocrCache.get(meta.identifier);

  if (!ocr) {
    if (meta.pageIndexUrl && meta.searchTextUrl) {
      const [idxRaw, fullText] = await Promise.all([
        fetchGunzipText(meta.pageIndexUrl, signal),
        fetchGunzipText(meta.searchTextUrl, signal)
      ]);
      ocr = { type: 'indexed', index: JSON.parse(idxRaw), text: fullText };
      ocrCache.set(meta.identifier, ocr);
    } else if (meta.djvuTxtUrl) {
      const fullText = await cachedFetchText(meta.djvuTxtUrl, signal);
      ocr = { type: 'plain', text: fullText };
      ocrCache.set(meta.identifier, ocr);
    } else {
      return '';
    }
  }

  let rawSlice = '';
  if (ocr.type === 'indexed' && Array.isArray(ocr.index[leafIndex])) {
    const [start, end] = ocr.index[leafIndex];
    rawSlice = ocr.text.slice(start, end);
  } else if (ocr.type === 'plain' && totalLeaves > 0) {
    if (!ocr.pages && ocr.text.includes('\f')) {
      ocr.pages = ocr.text.split('\f');
    }
    if (ocr.pages && leafIndex < ocr.pages.length) {
      rawSlice = ocr.pages[leafIndex];
    } else {
      const len = ocr.text.length;
      const start = Math.floor((leafIndex / totalLeaves) * len);
      const end = Math.floor(((leafIndex + 1) / totalLeaves) * len);
      rawSlice = ocr.text.slice(start, end);
    }
  }

  return rawSlice
    .replace(/\s+/g, ' ')
    .replace(/[|_~^`]+/g, ' ')
    .trim();
}

export async function getBookOcrData(meta, signal) {
  if (!meta) return null;
  const identifier = typeof meta === 'string' ? meta : meta.identifier;
  if (!identifier) return null;
  let ocr = ocrCache.get(identifier);
  if (!ocr) {
    let resolvedMeta = meta;
    if (!resolvedMeta.pageIndexUrl && !resolvedMeta.djvuTxtUrl) {
      try {
        resolvedMeta = await fetchItemMetadata(identifier, signal);
      } catch {
        return null;
      }
    }
    if (resolvedMeta.pageIndexUrl && resolvedMeta.searchTextUrl) {
      const [idxRaw, fullText] = await Promise.all([
        fetchGunzipText(resolvedMeta.pageIndexUrl, signal),
        fetchGunzipText(resolvedMeta.searchTextUrl, signal)
      ]);
      ocr = { type: 'indexed', index: JSON.parse(idxRaw), text: fullText };
      ocrCache.set(identifier, ocr);
    } else if (resolvedMeta.djvuTxtUrl) {
      const fullText = await cachedFetchText(resolvedMeta.djvuTxtUrl, signal);
      ocr = { type: 'plain', text: fullText };
      ocrCache.set(identifier, ocr);
    } else {
      return null;
    }
  }
  return ocr;
}
