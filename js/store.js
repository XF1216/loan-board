/** LoanBoardStore — HTTP file sync (A←B) + static data/live + localStorage cache */
(function (global) {
  const PREFIX = 'loanBoard.';
  const META_KEY = PREFIX + 'meta';
  const CHANNEL = 'loan-board-sync';
  const KEYS = { repayment: PREFIX + 'repayment', anomaly: PREFIX + 'anomaly', t7: PREFIX + 't7' };
  const cache = {};
  let metaCache = {};
  let readyPromise = null;

  function defaults() { return (global.LOAN_BOARD_DEFAULTS || {}); }
  function deepClone(x) { return JSON.parse(JSON.stringify(x)); }
  function isHttp() { return location.protocol === 'http:' || location.protocol === 'https:'; }
  function apiBase() {
    if (global.LOAN_BOARD_API_BASE) return String(global.LOAN_BOARD_API_BASE).replace(/\/$/, '');
    return '';
  }
  /** Relative to current page: panels/* → ../data/live ; root → data/live */
  function liveUrl(file) {
    if (global.LOAN_BOARD_LIVE_BASE) {
      return String(global.LOAN_BOARD_LIVE_BASE).replace(/\/$/, '') + '/' + file;
    }
    const inPanels = /\/panels\//i.test(location.pathname || '');
    return (inPanels ? '../data/live/' : 'data/live/') + file;
  }

  function readMetaLocal() {
    try { return JSON.parse(localStorage.getItem(META_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function writeMetaLocal(patch) {
    const m = Object.assign(readMetaLocal(), patch, { updatedAt: new Date().toISOString() });
    localStorage.setItem(META_KEY, JSON.stringify(m));
    metaCache = m;
    return m;
  }

  function validate(kind, data) {
    if (!data || typeof data !== 'object') return 'JSON 必须是对象';
    if (kind === 'repayment') {
      if (!data.asOf) return '缺少 asOf';
      if (!Array.isArray(data.rows)) return '缺少 rows 数组';
      return null;
    }
    if (kind === 'anomaly') {
      if (!data.wm || !data.tg) return '缺少 wm/tg';
      if (!Array.isArray(data.cities)) return '缺少 cities';
      if (!data.maxDate && !data.defaultCurr) return '缺少 maxDate';
      return null;
    }
    if (kind === 't7') {
      if (!Array.isArray(data.periods)) return '缺少 periods';
      for (let i = 0; i < data.periods.length; i++) {
        const p = data.periods[i];
        if (!p || !p.date || !Array.isArray(p.rows)) return 'periods[' + i + '] 格式错误';
      }
      return null;
    }
    return '未知类型';
  }

  function summarize(kind, data) {
    if (kind === 'repayment') return { asOf: data.asOf, rows: (data.rows || []).length };
    if (kind === 'anomaly') return {
      maxDate: data.maxDate || data.defaultCurr,
      cities: (data.cities || []).length,
      minDate: data.minDate
    };
    if (kind === 't7') {
      const periods = data.periods || [];
      return {
        generatedAt: data.generatedAt,
        periods: periods.length,
        lastDate: periods.length ? periods[periods.length - 1].date : null,
        lastRows: periods.length ? (periods[periods.length - 1].rows || []).length : 0
      };
    }
    return {};
  }

  function load(kind) {
    if (cache[kind]) return cache[kind];
    try {
      const raw = localStorage.getItem(KEYS[kind]);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') { cache[kind] = obj; return obj; }
      }
    } catch (e) {}
    const d = defaults()[kind];
    if (d) { cache[kind] = deepClone(d); return cache[kind]; }
    throw new Error('无数据: ' + kind);
  }

  function readMeta() {
    return metaCache && Object.keys(metaCache).length ? metaCache : readMetaLocal();
  }

  async function fetchJson(url, opt) {
    const res = await fetch(url, opt);
    const text = await res.text();
    let obj = null;
    try { obj = text ? JSON.parse(text) : null; } catch (e) {
      throw new Error('接口返回非 JSON：' + text.slice(0, 120));
    }
    if (!res.ok) throw new Error((obj && (obj.error || obj.message)) || ('HTTP ' + res.status));
    return obj;
  }

  function rememberKind(kind, data, meta) {
    cache[kind] = data;
    try { localStorage.setItem(KEYS[kind], JSON.stringify(data)); } catch (e) {}
    if (meta) {
      metaCache = Object.assign(readMetaLocal(), meta);
      try { localStorage.setItem(META_KEY, JSON.stringify(metaCache)); } catch (e) {}
    }
  }

  async function hydrateFromLiveFile(kind) {
    const file = kind === 'meta' ? 'meta.json' : (kind + '.json');
    const obj = await fetchJson(liveUrl(file));
    if (kind === 'meta') return obj;
    if (obj && typeof obj === 'object') return obj;
    throw new Error('live 文件无效');
  }

  async function hydrate(kind) {
    if (!isHttp()) { cache[kind] = load(kind); return cache[kind]; }
    try {
      const obj = await fetchJson(apiBase() + '/api/data/' + kind);
      if (obj && obj.data) {
        rememberKind(kind, obj.data, obj.meta);
        return cache[kind];
      }
    } catch (e) { console.warn('[LoanBoard] API 读取失败', kind, e); }
    try {
      const data = await hydrateFromLiveFile(kind);
      rememberKind(kind, data, null);
      return cache[kind];
    } catch (e) { console.warn('[LoanBoard] live 文件读取失败', kind, e); }
    cache[kind] = load(kind);
    return cache[kind];
  }

  async function hydrateMeta() {
    if (!isHttp()) { metaCache = readMetaLocal(); return metaCache; }
    try {
      const obj = await fetchJson(apiBase() + '/api/data/meta');
      if (obj && obj.meta) {
        metaCache = obj.meta;
        try { localStorage.setItem(META_KEY, JSON.stringify(metaCache)); } catch (e) {}
        return metaCache;
      }
    } catch (e) {}
    try {
      const obj = await hydrateFromLiveFile('meta');
      if (obj && typeof obj === 'object') {
        metaCache = obj.meta ? obj.meta : obj;
        try { localStorage.setItem(META_KEY, JSON.stringify(metaCache)); } catch (e) {}
        return metaCache;
      }
    } catch (e) {}
    metaCache = readMetaLocal();
    return metaCache;
  }

  function ready() {
    if (readyPromise) return readyPromise;
    readyPromise = Promise.all([
      hydrate('repayment'), hydrate('anomaly'), hydrate('t7'), hydrateMeta()
    ]).then(function () { return true; });
    return readyPromise;
  }

  let bc = null;
  try { bc = new BroadcastChannel(CHANNEL); } catch (e) { bc = null; }
  function broadcast(msg) { try { if (bc) bc.postMessage(msg); } catch (e) {} }

  async function pollMetaStamp() {
    try {
      const obj = await fetchJson(apiBase() + '/api/data/meta');
      return (obj && obj.meta && obj.meta.updatedAt) || '';
    } catch (e) {}
    try {
      const obj = await hydrateFromLiveFile('meta');
      const m = obj && (obj.meta || obj);
      return (m && m.updatedAt) || '';
    } catch (e) {}
    return '';
  }

  function onUpdate(fn) {
    if (bc) bc.addEventListener('message', function (ev) { if (ev && ev.data) fn(ev.data); });
    global.addEventListener('storage', function (ev) {
      if (!ev.key || ev.key.indexOf(PREFIX) !== 0) return;
      var kind = null;
      Object.keys(KEYS).forEach(function (k) { if (KEYS[k] === ev.key) kind = k; });
      if (kind) fn({ type: 'updated', kind: kind, via: 'storage' });
    });
    if (isHttp()) {
      var last = '';
      setInterval(async function () {
        try {
          const stamp = await pollMetaStamp();
          if (stamp && last && stamp !== last) {
            await Promise.all([hydrate('repayment'), hydrate('anomaly'), hydrate('t7'), hydrateMeta()]);
            fn({ type: 'updated', via: 'poll', meta: metaCache });
          }
          if (stamp) last = stamp;
        } catch (e) {}
      }, 4000);
    }
  }

  async function save(kind, data, source) {
    const err = validate(kind, data);
    if (err) throw new Error(err);
    if (isHttp()) {
      const obj = await fetchJson(apiBase() + '/api/data/' + kind, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ data: data, source: source || 'upload' })
      });
      cache[kind] = data;
      try { localStorage.setItem(KEYS[kind], JSON.stringify(data)); } catch (e) {}
      if (obj && obj.meta) metaCache = obj.meta;
      broadcast({ type: 'updated', kind: kind, meta: metaCache });
      return metaCache;
    }
    localStorage.setItem(KEYS[kind], JSON.stringify(data));
    cache[kind] = data;
    const meta = writeMetaLocal({
      [kind]: { source: source || 'upload', savedAt: new Date().toISOString(), summary: summarize(kind, data) }
    });
    broadcast({ type: 'updated', kind: kind, meta: meta });
    return meta;
  }

  async function reset(kind) {
    const d = defaults()[kind];
    if (!d) throw new Error('无默认数据');
    return save(kind, deepClone(d), 'default');
  }

  async function exportAll() {
    await ready();
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      meta: readMeta(),
      repayment: load('repayment'),
      anomaly: load('anomaly'),
      t7: load('t7')
    };
  }

  async function importAll(pack) {
    if (!pack || typeof pack !== 'object') throw new Error('无效备份包');
    for (const k of ['repayment', 'anomaly', 't7']) {
      if (pack[k]) await save(k, pack[k], 'import');
    }
    return readMeta();
  }

  function tryExtractDataFromHtml(text) {
    const m = text.match(/const\s+DATA\s*=\s*(\{[\s\S]*?\});\s*(?:\n|const|<\/script|\(function)/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }

  function parseIncoming(kind, text, filename) {
    const name = (filename || '').toLowerCase();
    const trimmed = String(text || '').trim();
    if (!trimmed) throw new Error('内容为空');
    if (name.endsWith('.json') || trimmed[0] === '{' || trimmed[0] === '[') {
      let obj;
      try { obj = JSON.parse(trimmed); } catch (e) {
        throw new Error('JSON 解析失败：' + e.message);
      }
      if (kind === 't7' && Array.isArray(obj)) {
        obj = { generatedAt: new Date().toISOString().slice(0, 10), rule: 'T-7订单量=0 且外卖借款余额>0', periods: obj };
      }
      if (obj.repayment && obj.anomaly && obj.t7 && !obj.asOf && !obj.wm) return { pack: obj };
      const err = validate(kind, obj);
      if (err) throw new Error(err);
      return { data: obj };
    }
    if (name.endsWith('.shtml') || name.endsWith('.html') || /<\s*html/i.test(trimmed) || /const\s+DATA\s*=/.test(trimmed)) {
      const extracted = tryExtractDataFromHtml(trimmed);
      if (!extracted) throw new Error('未能从 HTML 中提取 const DATA = {...}');
      const err = validate(kind, extracted);
      if (err) throw new Error('提取到的 DATA 不符合 ' + kind + '：' + err);
      return { data: extracted };
    }
    throw new Error('不支持的文件类型，请上传 .json 或含 DATA 的 .shtml/.html');
  }

  global.LoanBoardStore = {
    KEYS: KEYS, load: load, save: save, reset: reset, validate: validate,
    readMeta: readMeta, summarize: summarize, exportAll: exportAll, importAll: importAll,
    onUpdate: onUpdate, parseIncoming: parseIncoming, defaults: defaults,
    ready: ready, hydrate: hydrate
  };
})(window);
