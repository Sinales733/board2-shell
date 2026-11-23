/* kit/mock.js：补练。做错一道真题，从同一小节拉几道模拟题来练；也能随时按小节进来练。补练题不做讲解：
   题图 → 点答案（或做完点“看解析”）→ 判对错 / 自己报 → 原书解析图 → 下一题。一组 3 道，做完可以再来一组。
   三个入口：讲完一道做错 / 不会的真题，左栏底下淡淡出一个入口（同小节，三级小节相同的优先）；薄弱点页每行最右一格；抽屉右上角的哑铃（科目 → 章 → 节，数学按讲次）。
   题库 bank/mock/（另一个代理在建）：index.json 每个 tag 的题数；408 是 408/<科目>-<章>.<节>.json，数学是 math/L<两位讲次>.json，
     每个文件 {tag, title, items: [{id, src, no, type, q, ans, sol: [...], sub, auto}]}，图片路径相对题库目录。题库里没有的 tag，相应入口不出。
   地址带 ?bank=demo 用演示题库 bank/mock/_demo/（开发、测试用；作答存 data/mock/_demo/，本机记录也分开）。
   练习界面叠在讲解上面（.app.mock），讲解那一页原样留在底下：退出就回到进来之前那道题的那一步。不发 /state。
   作答单独记：本机 localStorage b2mock，电脑上 POST /mock（data/mock/<日期>.json，做错的进 data/mock/wrong.json）；不进真题的答题记录和当天小结。 */
(function () {
  'use strict';
  const S = window.Board2, A = S && S.api; if (!A) return;
  const $ = (s) => document.querySelector(s), esc = A.esc, U = A.U;
  const DEMO = new URLSearchParams(location.search).get('bank') === 'demo';
  const BASE = DEMO ? 'bank/mock/_demo/' : 'bank/mock/', LS = DEMO ? 'b2mockDemo' : 'b2mock', GROUP = 3;
  const stored = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const DB = '<svg viewBox="0 0 24 24"><path d="M6.5 7v10M17.5 7v10M3.5 9.5v5M20.5 9.5v5M6.5 12h11"/></svg>';
  const SUBJ = ['ds', 'co', 'os', 'cn'];
  /* idx 题库里有的 tag {tag: {n, title}}；toc 书上的章节名、数学讲次名（kit/toc.json，tools/mocktoc.py 照书和题库抄的）；
     hist 每道补练题 {tag, n 做过几次, nOk, ok 最近一次对不对, t}；cur 正在练的这一组 */
  const M = { idx: {}, toc: { '408': {}, math: { names: {}, mathTag: {} } }, files: {}, hist: stored(LS, {}), cur: null, nav: null };

  /* ---------- 题库 ---------- */
  const okTag = (t) => /^(ds|co|os|cn)-\d+\.\d+$/.test(t) || /^L\d{2}$/.test(t);
  const isMath = (t) => /^L\d{2}$/.test(t);
  /* index.json 的写法还没定死：{tag: n}、{tag: {n|count|total|items}}、{tags: …}、按 408 / math 分两层、或 [{tag, n}] 都认 */
  function normIndex(d) {
    const out = {};
    const cnt = (v) => (typeof v === 'number' ? v : v && typeof v === 'object' ? +(v.n != null ? v.n : v.count != null ? v.count : v.total != null ? v.total : Array.isArray(v.items) ? v.items.length : v.items) || 0 : 0);
    const put = (k, v) => { k = String(k || '').replace(/\.json$/, '').split('/').pop(); const n = cnt(v); if (okTag(k) && n > 0) out[k] = { n, title: (v && v.title) || '' }; };
    const walk = (o) => {
      if (Array.isArray(o)) { o.forEach((v) => v && put(v.tag || v.file || v.id, v)); return; }
      for (const k in o) {
        const v = o[k];
        if (typeof v === 'number' || (v && typeof v === 'object' && !Array.isArray(v) && ['n', 'count', 'total', 'items'].some((f) => f in v))) put(v && v.tag || k, v);
        else if (v && typeof v === 'object') walk(v);
      }
    };
    if (d && typeof d === 'object') walk(d);
    return out;
  }
  const loadIdx = () => A.getJSON(BASE + 'index.json').then((d) => { M.idx = normIndex(d); }).catch(() => { M.idx = {}; });
  const fileOf = (tag) => BASE + (isMath(tag) ? 'math/' : '408/') + tag + '.json';
  function loadTag(tag) {
    return M.files[tag] || (M.files[tag] = A.getJSON(fileOf(tag)).then((d) => {
      const items = (d && Array.isArray(d.items) ? d.items : []).filter((x) => x && typeof x.id === 'string' && x.q);
      return { title: (d && d.title) || '', items: items.map((x) => Object.assign({}, x, { q: BASE + x.q, sol: (Array.isArray(x.sol) ? x.sol : []).map((s) => BASE + s) })) };
    }).catch(() => { delete M.files[tag]; return { items: [] }; }));
  }
  /* 电脑上的汇总并进本机的：每道题取时间新的那份 */
  const loadSum = () => (S.quiet ? Promise.resolve() : A.getJSON('mock' + (DEMO ? '?demo=1' : '')).then((d) => {
    for (const id in d || {}) { const s = d[id], l = M.hist[id]; if (!s || typeof s !== 'object') continue; if (!l || String(s.t || '') >= String(l.t || '')) M.hist[id] = s; else l.n = Math.max(l.n || 0, s.n || 0); }
    store(LS, M.hist);
  }).catch(() => {}));
  let readyP = null;
  const ready = () => readyP || (readyP = Promise.all([loadIdx(), A.getJSON('kit/toc.json').then((t) => { M.toc = t; }).catch(() => {}), loadSum()]).then(paintAll));

  /* 一道真题落在哪个 tag：408 取 unit 的前两级（os-2.3.5-xxx → os-2.3）；数学按 topic 对到讲次（kit/toc.json 的 mathTag） */
  function tagOf(q) {
    if (!q) return null;
    if (q.type === 'math') return (M.toc.math && M.toc.math.mathTag || {})[String(q.topic || '').replace(/\s+/g, ' ').trim()] || null;
    const m = String(q.unit || '').match(/^(ds|co|os|cn)-(\d+)\.(\d+)/); return m ? m[1] + '-' + m[2] + '.' + m[3] : null;
  }
  const sub3 = (q) => { const m = q && String(q.unit || '').match(/^[a-z]+-(\d+\.\d+\.\d+)/); return m ? m[1] : null; };
  const has = (tag) => !!tag && !!M.idx[tag];
  const can = (q) => has(tagOf(q));
  /* 这一节：题数、做过几道、最近一次做对的几道 */
  function stat(tag) {
    let done = 0, ok = 0;
    for (const id in M.hist) { const h = M.hist[id]; if (h && h.tag === tag) { done++; ok += h.ok === true; } }
    return { n: (M.idx[tag] || {}).n || 0, done, ok };
  }
  const secName = (tag) => {
    if (isMath(tag)) return (M.toc.math.names || {})[tag] || (M.idx[tag] || {}).title || tag;
    const [s, num] = tag.split('-'); return ((M.toc['408'][s] || {}).sec || {})[num] || (M.idx[tag] || {}).title || '';
  };

  /* ---------- 入口一：讲完一道做错 / 不会的真题 ---------- */
  function paintEnd() {
    const r = S.id && A.rec(S.id);
    const on = !S.quiet && !S.redo && !S.gate && !S.mock && S.end && !!r && (r.skip || r.correct === false) && can(S.q);
    $('#mkIn').classList.toggle('on', on);
  }
  $('#mkIn').addEventListener('click', () => { if (S.q) start(tagOf(S.q), { sub: sub3(S.q) }); });

  /* ---------- 入口二：薄弱点页每行最右一格 ---------- */
  function weakCell(row) {
    const tag = row.math ? (M.toc.math.mathTag || {})[String(row.key || '').replace(/\s+/g, ' ').trim()] : (String(row.key || '').match(/^(ds|co|os|cn)-\d+\.\d+/) || [])[0];
    if (!has(tag)) return '';
    const st = stat(tag);
    return `<button class="wmk" data-tag="${esc(tag)}" aria-label="${esc(U('ui.mock.stat'))}">${st.done ? `<b>${st.ok}</b><small>/${st.done}</small>` : DB}</button>`;
  }

  /* ---------- 入口三：抽屉里逐级下钻 ---------- */
  const tagsOf = (mod) => Object.keys(M.idx).filter((t) => (mod === 'math') === isMath(t)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  function paintBtn() { $('#btnMock').classList.toggle('on', tagsOf(S.mod).length > 0); }
  const sumStat = (tags) => tags.map(stat).reduce((a, s) => ({ n: a.n + s.n, done: a.done + s.done, ok: a.ok + s.ok }), { n: 0, done: 0, ok: 0 });
  /* 题数、做过、做对：一根细条（浅的是做过，绿的是做对）+ 数字（做对的绿，做过 / 题数） */
  const meter = (s) => `<i class="pb mkpb"><i class="d" style="--f:${(s.n ? Math.min(1, s.done / s.n) : 0).toFixed(3)}"></i><i style="--f:${(s.n ? Math.min(1, s.ok / s.n) : 0).toFixed(3)}"></i></i><small>${s.ok ? `<em>${s.ok}</em>` : ''}<b>${s.done}</b>/${s.n}</small>`;
  const row = (attr, name, s) => `<button class="ty mkty" ${attr}><b>${name}</b>${meter(s)}</button>`;
  function navHTML() {
    const N = M.nav, all = tagsOf(S.mod);
    if (S.mod === 'math') return `<div class="tys">${all.map((t) => row(`data-tag="${t}"`, esc(secName(t)), stat(t))).join('')}</div>`;
    if (N.lv === 1) return `<div class="tys">${SUBJ.map((s) => { const ts = all.filter((t) => t.startsWith(s + '-')); return ts.length ? row(`data-s="${s}"`, esc((M.toc['408'][s] || {}).name || s), sumStat(ts)) : ''; }).join('')}</div>`;
    const inS = all.filter((t) => t.startsWith(N.s + '-')), chOf = (t) => t.split('-')[1].split('.')[0];
    if (N.lv === 2) {
      const chs = [...new Set(inS.map(chOf))].sort((a, b) => a - b), C = (M.toc['408'][N.s] || {}).ch || {};
      return `<div class="tys">${chs.map((c) => row(`data-c="${c}"`, esc(C[c] || c), sumStat(inS.filter((t) => chOf(t) === c)))).join('')}</div>`;
    }
    return `<div class="tys">${inS.filter((t) => chOf(t) === N.c).map((t) => row(`data-tag="${t}"`, `<span class="mono">${esc(t.split('-')[1])}</span>${esc(secName(t))}`, stat(t))).join('')}</div>`;
  }
  function navHead() {
    const N = M.nav, C = (M.toc['408'][N.s] || {});
    $('#nvh').dataset.lv = 'm' + N.lv;
    $('#nvTitle').innerHTML = N.lv === 1 ? esc(U('ui.mock.title')) : N.lv === 2 ? esc(C.name || N.s) : esc((C.ch || {})[N.c] || N.c);
  }
  function navShow(lv, dir) { M.nav.lv = lv; navHead(); A.swapPane(navHTML(), dir); }
  function navOpen() {
    M.nav = { lv: 1, s: null, c: null, back: A.NV.lv };
    A.NV.alt = {
      back() { if (M.nav.lv > 1) navShow(M.nav.lv - 1, -1); else { A.NV.alt = null; A.nvShow(M.nav.back || 1, -1); } },
      click(e) {
        const b = e.target.closest('.mkty'); if (!b) return;
        if (b.dataset.tag) { A.closeAll(); start(b.dataset.tag); return; }
        if (b.dataset.s) { M.nav.s = b.dataset.s; navShow(2, 1); return; }
        if (b.dataset.c) { M.nav.c = b.dataset.c; navShow(3, 1); }
      },
    };
    navShow(1, 1);
  }
  $('#btnMock').addEventListener('click', () => { loadSum().then(() => navOpen()); });
  $('#tag').addEventListener('click', () => { paintBtn(); loadIdx().then(paintBtn); });   // 抽屉打开时重读一次题库目录（题库还在建）

  /* ---------- 抽题：没做过的优先，其次做错过的，最后做对过的；同一档里三级小节和那道真题相同的排前面；
     “再来一组”时刚做完的那组放到最后（题不够才再出）；同一组不重复 ---------- */
  function pick(items, sub, prev) {
    const rank = (it) => { const h = M.hist[it.id]; return !h ? 0 : h.ok ? 2 : 1; };
    const key = (it) => rank(it) * 2 + (sub && it.sub === sub ? 0 : 1) + (prev.includes(it.id) ? 6 : 0);
    return items.map((it) => ({ it, k: key(it), r: Math.random() })).sort((a, b) => a.k - b.k || a.r - b.r).slice(0, GROUP).map((x) => x.it);
  }

  /* ---------- 练习界面 ---------- */
  async function start(tag, o) {
    o = o || {}; if (!has(tag) || M.busy) return;
    M.busy = true;
    try {
      const f = await loadTag(tag); if (!f.items.length) return;
      const prev = M.cur && M.cur.tag === tag ? M.cur.list.map((x) => x.id) : [];
      M.cur = { tag, sub: o.sub || (M.cur && M.cur.tag === tag ? M.cur.sub : null), list: pick(f.items, o.sub, prev), i: 0, res: [] };
      if (!S.mock) { S.mock = true; const app = $('#app'); app.classList.add('mock'); app.classList.remove('mk-in'); void app.offsetWidth; app.classList.add('mk-in'); paintEnd(); }
      show(0);
    } finally { M.busy = false; }
  }
  function leave() {
    if (!S.mock) return;
    S.mock = false; M.cur = null; $('#app').classList.remove('mock', 'mk-in'); $('#mkPages').innerHTML = ''; paintEnd();
    if (S.def) { A.paintTag(); A.fitRail(); }   // 补练时左栏藏着，题号那一行量不出宽度：回来重量一次
    if (S.pendPush) { const id = S.pendPush; S.pendPush = null; A.open(id, { fresh: true }).catch(() => {}); }
  }
  $('#mkX').addEventListener('click', leave);

  const it = () => M.cur.list[M.cur.i];
  const auto = (x) => x.type === 'choice' && x.auto === true && /^[A-D]$/.test(String(x.ans || ''));
  function show(i) {
    const C = M.cur; C.i = i; C.st = 'ask'; C.me = null;
    const x = it(), num = isMath(C.tag) ? String(secName(C.tag)).split(/\s/)[0] : C.tag.split('-')[1];
    const sl = 'mock.src.' + x.src, srcName = /^‹/.test(U(sl)) ? x.src : U(sl);   // 来源要是缩写，ui.json 里有 mock.src.<缩写> 就换成那个名字，没有就照题库原样
    $('#mkSrc').innerHTML = `<b>${esc(x.sub || num)}</b><small>${esc([srcName, x.no].filter((v) => v != null && v !== '').join(' '))}</small>`;
    $('#mkOpts').innerHTML = auto(x) ? ['A', 'B', 'C', 'D'].map((k) => `<button class="mopt" data-k="${k}">${k}</button>`).join('') : '';
    pages([x.q], true); paint();
  }
  /* 左栏：一组几道的小圆点（绿 对 / 红 错 / 圈 当前）、选项的对错、底下的按钮 */
  function paint() {
    const C = M.cur, x = it(), last = C.i >= C.list.length - 1;
    $('#mkDots').innerHTML = C.list.map((y, k) => `<i data-s="${C.res[k] == null ? '' : C.res[k] ? 'ok' : 'no'}"${k === C.i ? ' class="cur"' : ''}></i>`).join('');
    document.querySelectorAll('.mopt').forEach((b) => {
      const k = b.dataset.k, done = C.st === 'done';
      b.dataset.v = done && k === x.ans ? 'ok' : done && k === C.me ? 'no' : '';
      b.classList.toggle('me', done && k === C.me); b.disabled = done;
    });
    const btn = (a, k, c) => `<button class="gbtn${c ? ' ' + c : ''}" data-a="${a}">${esc(U(k))}</button>`;
    $('#mkBtns').innerHTML = C.st === 'ask' ? (auto(x) ? btn('skip', 'ui.gate.skip') : btn('sol', 'ui.mock.sol', 'go'))
      : C.st === 'self' ? btn('right', 'ui.gate.right', 'ok') + btn('wrong', 'ui.gate.wrong', 'no')
      : last ? btn('again', 'ui.mock.again', 'go') : btn('next', 'ui.mock.next', 'go');
  }
  function judge(ok, o) {
    const C = M.cur, x = it(); C.res[C.i] = ok; C.st = 'done';
    const h = M.hist[x.id] || { n: 0, nOk: 0 }, t = new Date().toISOString();
    M.hist[x.id] = { tag: C.tag, n: (h.n || 0) + 1, nOk: (h.nOk || 0) + (ok ? 1 : 0), ok, t }; store(LS, M.hist);
    if (!S.quiet) A.post('/mock', Object.assign({ id: x.id, tag: C.tag, ok, self: !!o.self, skip: !!o.skip, t, date: A.today() }, DEMO ? { demo: true } : {}));
    if (!o.self) Kit.audio.play(ok ? 'right' : 'wrong');
    if (C.i >= C.list.length - 1) setTimeout(() => Kit.audio.play('done'), o.self ? 0 : 500);   // 这一组做完了
    paint();
  }
  $('#mkOpts').addEventListener('click', (e) => {
    const b = e.target.closest('.mopt'); if (!b || !M.cur || M.cur.st !== 'ask') return;
    M.cur.me = b.dataset.k; judge(b.dataset.k === it().ans, {}); solSoon();
  });
  $('#mkBtns').addEventListener('click', (e) => {
    const b = e.target.closest('.gbtn'); if (!b || !M.cur) return;
    const a = b.dataset.a, C = M.cur;
    if (a === 'skip' && C.st === 'ask') { judge(false, { skip: true }); solSoon(); }
    else if (a === 'sol' && C.st === 'ask') { C.st = 'self'; paint(); sol(); }
    else if ((a === 'right' || a === 'wrong') && C.st === 'self') judge(a === 'right', { self: true });
    else if (a === 'next') show(C.i + 1);
    else if (a === 'again') start(C.tag, { sub: C.sub });
  });
  /* 判完稍停一下（先看清左边的对错），再把解析翻出来 */
  function solSoon() { const x = it(); setTimeout(() => { if (M.cur && it() === x) sol(); }, document.documentElement.classList.contains('still') ? 0 : 650); }
  function sol() { const x = it(); if (!x.sol.length) return; pages([x.q].concat(x.sol), false); goPage(1); }

  /* ---------- 右边大画面：一张图一页，左右翻（解析多张），页里上下滑；点一下放大 / 还原，双指捏着缩放 ---------- */
  const view = $('#mkPages'), pd = $('#mkPd');
  function pages(srcs, fresh) {
    const have = [...view.querySelectorAll('.mpg img')].map((im) => im.getAttribute('src'));
    if (!fresh && srcs.slice(0, have.length).every((s, k) => s === have[k])) {   // 加解析：已有的题图那一页不重建，接在后面
      srcs.slice(have.length).forEach((s) => view.appendChild(pg(s)));
    } else {
      view.innerHTML = ''; srcs.forEach((s) => view.appendChild(pg(s))); view.scrollLeft = 0;
      view.classList.remove('swap'); void view.offsetWidth; view.classList.add('swap');
    }
    unzoom();
    pd.innerHTML = srcs.length > 1 ? srcs.map((s, k) => `<button data-p="${k}"><i></i></button>`).join('') : '';
    curPage();
  }
  /* --nw：图原宽，窄图最多放大到 1.5 倍（不然几百像素宽的小图被拉成整页宽，发糊） */
  function pg(src) {
    const d = document.createElement('div'); d.className = 'mpg';
    const im = new Image(); im.alt = ''; im.draggable = false; im.onload = () => { im.style.setProperty('--nw', im.naturalWidth + 'px'); lightCheck(im); }; im.src = src; d.appendChild(im); return d;
  }
  /* 浅底的扫描图（原书解析）在暗色界面上刺眼：量一下平均亮度，偏亮就反色压暗（同原卷图 q.png 的压暗办法） */
  function lightCheck(im) {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 24; const g = c.getContext('2d'); g.drawImage(im, 0, 0, 24, 24);
      const d = g.getImageData(0, 0, 24, 24).data; let s = 0; for (let k = 0; k < d.length; k += 4) s += d[k] * 0.3 + d[k + 1] * 0.59 + d[k + 2] * 0.11;
      im.classList.toggle('inv', s / (d.length / 4) > 150);
    } catch (e) {}
  }
  const pageW = () => view.clientWidth || 1;
  const pageI = () => Math.round(view.scrollLeft / pageW());
  function curPage() { const i = pageI(); pd.querySelectorAll('button').forEach((b, k) => b.classList.toggle('on', k === i)); }
  function goPage(i) { unzoom(); view.scrollTo({ left: i * pageW(), behavior: document.documentElement.classList.contains('still') ? 'auto' : 'smooth' }); }
  view.addEventListener('scroll', curPage, { passive: true });
  pd.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) goPage(+b.dataset.p); });

  /* 缩放：图宽 = 页宽 × z。缩放时手指（或点的那一点）下面的那块图不动 */
  let Z = 1;
  const curPg = () => view.children[pageI()];
  function zoomTo(z, x, y) {
    const p = curPg(); if (!p) return; const im = p.querySelector('img'); if (!im) return;
    z = Math.max(1, Math.min(4, z));
    const r = p.getBoundingClientRect(), ox = x - r.left, oy = y - r.top;
    const fx = (p.scrollLeft + ox - im.offsetLeft) / (im.offsetWidth || 1), fy = (p.scrollTop + oy - im.offsetTop) / (im.offsetHeight || 1);
    Z = z; p.style.setProperty('--z', z); view.classList.toggle('zoomed', z > 1.01);
    p.scrollLeft = im.offsetLeft + fx * im.offsetWidth - ox; p.scrollTop = im.offsetTop + fy * im.offsetHeight - oy;
  }
  function unzoom() { Z = 1; view.classList.remove('zoomed'); view.querySelectorAll('.mpg').forEach((p) => p.style.removeProperty('--z')); }
  let tp = null;   // 点一下：按下到抬起不到 300 毫秒、没怎么动、只有一根手指
  view.addEventListener('pointerdown', (e) => { tp = tp ? Object.assign(tp, { multi: true }) : { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId }; });
  view.addEventListener('pointerup', (e) => {
    const T = tp; tp = null; if (!T || T.multi || T.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - T.x, e.clientY - T.y) > 10 || performance.now() - T.t > 300) return;
    zoomTo(Z > 1.01 ? 1 : 2.2, e.clientX, e.clientY);
  });
  view.addEventListener('pointercancel', () => { tp = null; });
  let pin = null;   // 双指：两指距离之比 × 开始时的 z
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = (t) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
  view.addEventListener('touchstart', (e) => { if (e.touches.length === 2) { pin = { d: dist(e.touches), z: Z }; tp = null; } }, { passive: true });
  view.addEventListener('touchmove', (e) => {
    if (!pin || e.touches.length !== 2) return; e.preventDefault();
    const [x, y] = mid(e.touches); zoomTo(pin.z * dist(e.touches) / (pin.d || 1), x, y);
  }, { passive: false });
  view.addEventListener('touchend', (e) => { if (e.touches.length < 2) { pin = null; if (Z < 1.05) unzoom(); } });

  function paintAll() { paintEnd(); paintBtn(); }
  Kit.mock = { ready, can, paintEnd, weakCell, start, leave, tagOf, M };
  ready();
  if (!S.quiet) setInterval(() => loadIdx().then(paintAll), 60000);
})();
