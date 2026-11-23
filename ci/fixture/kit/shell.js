/* kit/shell.js：外壳。把一页讲解装进界面，并接上所有操作：
   画面上  点空白 = 下一步；左右滑 = 下一步 / 上一步（按着慢慢拖，动画跟着手指走）；点“能点的地方” = 它演给你看
   进度条  能拖，拖到哪演到哪；点段名跳到那一段；两头是 ◀ ▶
   左栏    点选项 = 直接看这个选项怎么判；点题号 = 选题抽屉（年份 → 题型 → 题号格子）；旗子 = 这一步没懂，记下来；书 = 看书上原文
   触屏    抽屉往左滑走、薄弱点和书页往下滑走、反馈往上滑走，点空白处也关；按钮一碰就有反馈；长按不弹菜单。
   新讲解推过来时自动跳过去（地址里带 ?id= 时不跳）。
   两个模块：题号以 m 开头的是数学，其余是 408；左栏最上面的开关切换。题单、进度、“下一道”、讲过的题、小结都只算当前模块，
   每个模块记住上次停在哪道题哪一步（localStorage b2mod），也记上次用的是哪个模块。
   一天怎么用（data/today.json 有题单时）：
   开讲前先点答案（或“不会”）→ 讲；同一块知识第二次遇到，直接从逐项判断开始；讲到最后一步再往下走就进题单里的下一道。
   反馈：大画面右上角的小气泡，点开打字说哪里没懂（自动带上题号、第几步）。监听会话做好重讲后气泡上出小点，点开“重讲”播放（kit/redo.js）。
   薄弱点：抽屉右上角的小图，按王道小节统计错了几道、不会几道、没懂几步（数学按讲次），点一行展开，点题跳过去。
   补练（kit/mock.js）：做错 / 不会的题讲完后左栏底下的入口、薄弱点每行最右一格、抽屉右上角的哑铃，三处进同小节的模拟题。
   读题（kit/read.js）：开讲前，有 read.json 的题左栏多一个“读题”入口；题干一句一句亮、右边原卷图框出那一块，看完或点 × 回到开讲前，不记任何东西。
   新讲法（kit/xin.js，q.json 写 xin 的题）：开讲前问“我先做 / 直接讲”；左栏换成往下长的讲稿（#xdoc），没有底部那一行结论，也没有读题入口。 */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const getJSON = (u) => fetch(u + (u.includes('?') ? '&' : '?') + 't=' + Date.now()).then((r) => (r.ok ? r.json() : Promise.reject(new Error(u + ' ' + r.status))));
  const post = (u, body) => { try { fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {}); } catch (e) {} };
  const sup = (s) => esc(s).replace(/(\d)\^(\d+)/g, '$1<sup>$2</sup>');   // 原卷的上标（题库写成 2^8B）：数字^数字 的指数排成上标，别的字不动
  const look = Kit.look;   // o 可以是几层（题目的字 → 知识块的字 → 外壳的字），前面的先查
  const stored = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  /* today 今日题单；ans 他点过的答案 {题号: {choice, correct, skip, fin, date, t}}；known 看完过的知识块；
     gate 这一页还没点答案（'pick' 有选项 / 'open' 没选项）；quiet 自动截图时（地址带 at=）什么都不记 */
  const S = { ui: {}, entries: [], seen: new Set(), id: null, def: null, text: null, P: null, judged: {}, flags: {}, cells: [],
    today: null, mod: 'exam', mem: {}, ans: {}, known: {}, missing: new Set(), gate: null, me: null, q: null, secs: [], uLast: -1, prevI: -1, end: false, quiet: false,
    redo: null, fb: [], fbSeen: {}, read: false, canRead: false };   // read 正在读题（kit/read.js）；canRead 这道题有读题内容   // redo 正在放的重讲 {dir, at, file}；fb 各条反馈的状态（GET /feedback）；fbSeen 本机看过的重讲
  const U = (k) => look(S.ui, k);
  const T = (k) => look(S.text, k);
  S.mem = stored('b2mod', {}); S.flags = stored('b2flags', {}); S.ans = stored('b2answers', {}); S.known = stored('b2seen', {}); S.fbSeen = stored('b2redoSeen', {}); S.xinQ = stored('b2xinq', {});

  /* ---------- 今日题单和答题记录 ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const today = () => { if (S.today && S.today.date) return S.today.date; const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const allL = () => (S.today && Array.isArray(S.today.list) ? S.today.list : []);   // 两个模块合在一起的整张题单（data/today.json）
  const modOf = (id) => (String(id).charAt(0) === 'm' ? 'math' : 'exam');          // 题号以 m 开头是数学，其余是 408
  const L = () => allL().filter((id) => modOf(id) === S.mod);                       // 当前模块的题单，下面所有“第几道/下一道/小结”都用它
  const rec = (id) => { const r = S.ans[id]; return r && r.date === today() ? r : null; };   // 只认今天点的
  const done = (id) => { const r = rec(id); return !!r && !!r.fin; };                        // 点了答案、也讲到了最后
  const pend = () => { const r = rec(S.id); return !!r && r.choice == null && !r.skip && r.correct == null; };   // 没选项的题：讲完还没自己报对错
  function record(id, patch) {
    if (S.quiet || S.redo || S.read) return;
    const r = S.ans[id] = Object.assign({}, rec(id), patch, { date: today() });
    store('b2answers', S.ans); post('/answer', Object.assign({ id }, r));
  }
  function seenUnit() {
    const u = S.q && S.q.unit; if (!u || S.known[u] || S.quiet || S.redo || S.read) return;
    S.known[u] = Date.now(); store('b2seen', S.known); post('/seen', { unit: u });
  }
  /* 新讲法的知识 unit 讲过了：和知识块一样记进 seen（本机 b2seen、电脑 data/seen.json），另在本机记下是哪道题讲的（b2xinq），同一道题重开不折叠 */
  function seenX(u) {
    if (S.known[u] || S.quiet || S.redo || S.read) return;
    S.known[u] = Date.now(); S.xinQ[u] = S.id; store('b2seen', S.known); store('b2xinq', S.xinQ); post('/seen', { unit: u });
  }
  function miss(id) { if (S.missing.has(id) || !L().includes(id)) return; S.missing.add(id); if (!S.quiet) post('/missing', { id, date: today() }); }   // 只记题单里的
  /* 题单里还有没有下一道（已知做不出来的不算） */
  function hasNext() {
    const list = L(); if (!list.length) return false;
    const k = list.indexOf(S.id);
    return (k >= 0 ? list.slice(k + 1) : list.filter((id) => !done(id))).some((id) => id !== S.id && !S.missing.has(id));
  }

  function applyUI() {
    document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = U(el.dataset.t); });
    document.querySelectorAll('[data-aria]').forEach((el) => { el.setAttribute('aria-label', U(el.dataset.aria)); });
    document.querySelectorAll('[data-ph]').forEach((el) => { el.setAttribute('placeholder', U(el.dataset.ph)); });
  }

  /* 进度条长什么样（a 细线 / b 圆点 / c 刻度）记在电脑上的 data/prefs.json 里，在 bar.html 那一页点一下就换 */
  function applyPrefs(p) {
    /* 地址里带 bar=a|b|c 时固定用那一种（自动截图用，免得基准图跟着他在平板上的选择变） */
    const fixed = new URLSearchParams(location.search).get('bar');
    const k = /^[abc]$/.test(fixed || '') ? fixed : (p && /^[abc]$/.test(p.bar) ? p.bar : 'a'), bar = $('.bar');
    if (bar.dataset.k === k) return;
    bar.dataset.k = k; bar.className = 'bar bar-' + k;
    document.querySelectorAll('#barpick button').forEach((el) => el.classList.toggle('on', el.dataset.k === k));
    if (S.P) onTime(S.P.pos);
  }

  /* ---------- 装一页讲解 ----------
     一页 = 题目 questions/<id>/q.json + 它用的知识块 units/<unit>/（unit.js 和 text.json），用 kit/sections.js 拼起来。
     题目或知识块取不到就抛错，原来那一页不动。 */
  const loadScript = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error(src)); document.head.appendChild(s); });
  async function open(id, o) {
    o = o || {};
    const qb = 'questions/' + id + '/', q = await getJSON(qb + 'q.json');
    const math = q.type === 'math';   // 数学题：没有知识块，整页由 kit/math.js 的 Kit.math.lesson 拼；书的按钮打开详解截图
    const big = q.type === 'big';     // 综合题：知识块照旧，小问的解答在 questions/<id>/big.js，整页由 kit/big.js 的 Kit.big.lesson 拼
    const ub = math ? qb : 'units/' + q.unit + '/', utext = math ? {} : await getJSON(ub + 'text.json');
    if (math) await Kit.math.ready(); else if (!Kit.units[q.unit]) await loadScript(ub + 'unit.js?t=' + Date.now());
    if (big) { q.id = id; await Kit.math.ready(); if (!Kit.big.defs[id]) await loadScript(qb + 'big.js?t=' + Date.now()); }
    const unit = math ? { book: [q.sol || 'sol.png'], secs: [] } : Kit.units[q.unit]; if (!unit) throw new Error(q.unit);
    const rd = o.redo ? Object.assign(await Kit.redo.load(o.redo.dir), { q }) : null;   // 重讲：先读齐，读不出来原来那一页不动
    const rr = !rd && o.read ? Object.assign(await Kit.read.load(id), { q }) : null;    // 读题：同上
    /* 新讲法（kit/xin.js）：q.json 写了 xin 的题读 lesson.json、lesson.text.json；用到读题画面的再读 read.json。重讲、读题时不走它 */
    let xin = null;
    if (q.xin && !rd && !rr) {
      const man = await getJSON(qb + 'lesson.json'), xt = await getJSON(qb + 'lesson.text.json').catch(() => ({}));
      const xr = (man.steps || []).some((s) => s.read) ? Object.assign(await Kit.read.load(id, { pages: man.pages, steps: man.reads }), { q }) : null;   // lesson.json 的 pages / reads：另加的图（书页裁图）和画面，接在 read.json 后面
      xin = { man, text: xt, rd: xr };
    }
    if (S.P) { S.P.destroy(); S.P = null; }
    const opts = Array.isArray(q.opts) ? q.opts : [];
    const m = { year: q.year, no: q.no, subject: q.subject, answer: q.answer, opts, scan: qb + q.scan, book: unit.book.map((f) => ub + f), cites: (Array.isArray(q.cites) ? q.cites : []).map((c) => (c.img ? Object.assign({}, c, { img: qb + c.img }) : c)) };   // img：资料库没有页图的页（含近年真题的页）用知识块里现成的整页图，路径从题目文件夹算
    const build0 = xin ? (K) => Kit.xin.build(K, { q, unit, man: xin.man, rd: xin.rd })
      : math ? (K) => Kit.math.lesson(K, q) : big ? (K) => Kit.big.lesson(K, q, unit) : (K) => Kit.sections.lesson(K, q, unit);
    const def = { meta: m, build: rd ? (K) => Kit.redo.build(K, build0, rd) : rr ? (K) => Kit.read.build(K, rr) : build0 };
    /* 综合题：进度条上每个小问一段，段名是题目自己的编号（q.parts[].label，原卷照抄） */
    const partSec = big ? { sec: Object.fromEntries((q.parts || []).map((p) => ['p' + p.id, p.label])) } : {};
    const text = [rd ? rd.text : rr ? rr.text : xin ? xin.text : {}, q.text || {}, partSec, utext, S.ui];
    S.mod = modOf(id); paintMods();
    S.id = id; S.def = def; S.text = text; S.judged = {}; S.q = q; S.prevI = -1; S.end = false; S.redo = o.redo || null; S.read = !!rr; S.canRead = false; S.xin = xin; S.xdoc = null;
    $('#app').classList.remove('none');
    $('#app').classList.toggle('redo', !!S.redo);   // 放重讲时：旗子藏起来，右上角多一个 × 回到原讲解
    $('#app').classList.toggle('big', big);
    $('#app').classList.remove('stemopen'); $('#app').classList.toggle('xin', !!xin);   // 新讲法：左栏换成讲稿（#xdoc），底部那一行结论不要
    $('#app').classList.toggle('reading', S.read);   // 读题时：旗子藏起来，右上角 × 回到开讲前
    $('#btnRedoX').setAttribute('aria-label', U(S.read ? 'ui.read.back' : 'ui.fb.back'));
    /* 读题：题干里每步要亮的那几句先插上记号（Kit.read.mark），照常排好以后换成 span（Kit.read.spans） */
    const rStem = rr && !math && !big ? Kit.read.mark(look(text, 'q.stem'), rr.man.steps, false) : null;
    if (rr && big) Kit.read.ranges(String(look(text, 'q.stem') || ''), rr.man.steps);   // 综合题左栏是原卷图，只查 stem 找不找得到
    if (big) bigRail(q, qb);   // 综合题：左栏是原卷图（能上下滑、点了全屏看）和小问的入口
    else if (math) Kit.math.rail(rr ? Object.assign({}, q, { stemTex: Kit.read.mark(q.stemTex, rr.man.steps, true) }) : q, $('#stem'), $('#opts'));   // 数学题的题干、选项是题库里的 stemTex / optsTex，用 KaTeX 排
    else { const st0 = rStem != null ? rStem : look(text, 'q.stem'); $('#stem').innerHTML = Array.isArray(q.stemFig) && q.stemFig.length ? stemWithFigs(m.no, st0, q.stemFig, qb) : sup(m.no + '. ' + st0); }   // 题干和选项照原卷抄在 text.json 的 q 里；点题干看原卷截图；题干带表 / 图的题（q.stemFig）把裁好的小图排在题干里
    { const st = look(text, 'q.stem') || '', code = !math && !big && (st.match(/\n/g) || []).length >= 4 && /[{};]/.test(st); $('#stem').classList.toggle('code', code); $('#stem').scrollTop = 0; }   // 多行且含 { } ; 的算代码题干：字小一档、保留缩进
    $('#stem').classList.toggle('pre', !math && !big);   // 题干里的换行照原样分行（I、II、III 各占一行）
    if (rr) Kit.read.spans($('#stem'));
    if (!math && !big) $('#opts').innerHTML = opts.map((k) => `<button class="opt${String(look(text, 'q.opts.' + k) || '').trim() ? '' : ' noText'}" data-k="${k}"><b>${k}</b><span class="t">${sup(look(text, 'q.opts.' + k))}</span><span class="mk"></span></button>`).join('');
    /* 题目挑“不成立的那一项”（check.pick = "false"，组合型不算）：左栏记号表示说法成不成立，见 paintOpts */
    $('#opts').classList.toggle('imgs', !math && !big && opts.length > 0 && opts.every((k) => !String(look(text, 'q.opts.' + k) || '').trim()));   // 选项是图（字是空的）：按钮只留字母，排两列
    $('#opts').classList.toggle('pickf', !math && !big && !!q.check && q.check.pick === 'false' && !q.check.items);
    const P = S.P = Kit.createPlayer($('#stage'), def, text);
    if (o.atKey != null) { const k = P.steps.findIndex((s) => s.id === o.atKey); o.at = k >= 0 ? k : 0; }   // 报修换新版 / 退回后重载：按步骤键名回到原来那一步，找不到就回开头
    if (/[?&]grid=1/.test(location.search)) grid($('#stage svg'));
    /* 进度条的段：按各步的 sec 出现的顺序排，某一页没有的段就不占格子 */
    S.secs = m.secs = []; P.steps.forEach((s) => { if (!S.secs.includes(secOf(s))) S.secs.push(secOf(s)); });
    S.uLast = -1; if (!S.redo && !S.read && !xin) P.steps.forEach((s, i) => { if ((unit.secs || []).includes(s.sec)) S.uLast = i; });   // 知识块自己的最后一步
    if (xin) S.xdoc = Kit.xin.doc($('#xdoc'), P.steps, T, { man: xin.man, math, cites: m.cites, known: (u) => !!S.known[u] && S.xinQ[u] !== id });
    $('#segs').innerHTML = S.secs.map((sid) => {
      const ids = P.steps.map((s, i) => (secOf(s) === sid ? i : -1)).filter((i) => i >= 0);
      return `<div class="seg" data-sec="${sid}" data-first="${ids[0]}" style="--n:${ids.length}"><button class="nm">${esc(T('sec.' + sid))}</button><div class="cs">${ids.map(() => '<i></i>').join('')}</div></div>`;
    }).join('');
    S.cells = [...document.querySelectorAll('#segs .cs i')]; S.curCell = -1;
    const r = rec(id);
    S.me = r ? r.choice : null;
    S.gate = o.at == null && !r && !S.redo && !S.read ? (opts.length ? 'pick' : xin ? 'xin' : 'open') : null;   // 新讲法的题先问“我先做 / 直接讲”
    if (S.gate && !S.quiet && !xin) Kit.read.can(id).then((ok) => { if (S.id === id && S.def === def && S.gate) { S.canRead = ok; paintRead(); } });   // 有读题内容才出入口
    gatePic(qb, q, big && !xin);
    paintTag();
    P.on('step', onStep); P.on('done', onDone); P.on('time', onTime);
    if (Kit.phone) Kit.phone.attach(P, $('#stage'));   // 手机竖屏：每一步镜头推近到正在讲的地方（kit/phone.js；平板上什么都不做）
    onStep(-1, null); onTime(0);
    if (S.redo) P.go(0); else if (o.at != null) P.go(o.at, { instant: true }); else if (S.read) P.go(0); else if (!S.gate) start();
    if (o.fresh) toast(U('ui.fresh'));
    if (Kit.ask) Kit.ask.onOpen(id);   // 问答：取这道题的历史对话、讲稿上问过的那几段加小标记
  }
  /* 地址带 grid=1：画布上画 100 像素一格的网格和坐标（编排重讲时量 mark / zoom 的坐标用，见 design/反馈流程.md） */
  function grid(svg) {
    const g = Kit.E('g', { 'pointer-events': 'none' }, svg);
    for (let x = 0; x <= 1000; x += 50) Kit.E('line', { x1: x, y1: 0, x2: x, y2: 720, stroke: x % 100 ? 'rgba(127,178,229,.25)' : 'rgba(127,178,229,.6)', 'stroke-width': 1 }, g);
    for (let y = 0; y <= 720; y += 50) Kit.E('line', { x1: 0, y1: y, x2: 1000, y2: y, stroke: y % 100 ? 'rgba(127,178,229,.25)' : 'rgba(127,178,229,.6)', 'stroke-width': 1 }, g);
    for (let x = 0; x < 1000; x += 100) for (let y = 0; y < 720; y += 100) Kit.E('text', { x: x + 3, y: y + 13, 'font-size': 11, fill: '#7fb2e5', class: 'mono' }, g, x + ',' + y);
  }
  /* 题干带表 / 图：q.stemFig = [{src, lines:[从, 到]}]，src 是题目文件夹里 tools/qcrop.py 裁出的深色小图。
     lines 是题干文字里（按换行数，从 0 数，含两头）被这张图顶替的几行（抄成文字的表格行）；不写 lines 就顶替 “[图：…]”“[表：…]” 占位行，没有占位行就排在文字下面。
     其余的占位行一律不显示。图宽贴合左栏，点图 = 用书页那个全屏面板放大看这一张。 */
  function stemWithFigs(no, st, figs, qb) {
    const lines = String(st || '').split('\n'), ph = (t) => /^\s*\[(图|表)[：:]/.test(Kit.read.strip(t)), at = {}, skip = new Set();
    figs.forEach((f, i) => {
      let a = -1, b = -1;
      if (Array.isArray(f.lines)) { a = f.lines[0]; b = f.lines[1] == null ? a : f.lines[1]; }
      else { a = lines.findIndex((t, k) => ph(t) && !skip.has(k)); b = a; }
      if (a < 0) a = b = lines.length; else for (let k = a; k <= b; k++) skip.add(k);
      (at[a] = at[a] || []).push(i);
    });
    const img = (i) => `<img class="sfig" src="${esc(qb + figs[i].src)}" data-f="${esc(qb + figs[i].src)}" alt="" draggable="false">`;
    let html = '', run = [];
    const flush = () => { if (run.length) html += sup(run.join('\n')); run = []; };
    lines.forEach((t, k) => {
      if (at[k]) { flush(); html += at[k].map(img).join(''); }
      if (!skip.has(k) && !ph(t)) run.push((k === 0 ? no + '. ' : '') + t);
    });
    if (at[lines.length]) { flush(); html += at[lines.length].map(img).join(''); }
    flush(); return html;
  }
  /* 综合题的左栏：题面太长，放 tools/bigscan.py 改排过的深色原卷图（q.json 的 scanRail；没有就用原图压暗）；下面是小问的编号，点了跳到那一小问 */
  function bigRail(q, qb) {
    let bs = $('#bigscan');
    if (!bs) {
      bs = document.createElement('div'); bs.id = 'bigscan'; bs.className = 'bigscan'; bs.setAttribute('role', 'button'); $('#stem').after(bs);
      bs.addEventListener('click', () => { if (S.def) sheet([S.def.meta.scan]); });
    }
    bs.setAttribute('aria-label', U('ui.scan')); bs.classList.toggle('raw', !q.scanRail);
    bs.innerHTML = `<img src="${esc(qb + (q.scanRail || q.scan))}" alt="">`; bs.scrollTop = 0;
    $('#opts').innerHTML = (q.parts || []).map((p) => `<button class="part" data-part="${esc(p.id)}">${esc(p.label)}</button>`).join('');
  }
  /* 开讲前（有选项的题）右边大画面放这道题的原卷：questions/<id>/q_dark.png（tools/qdark.py 做的深色版），没有就用 q.png 压暗，再没有就只显示提示。点图 = 全屏看原卷 */
  function gatePic(qb, q, skip) {
    let el = $('#gatepic');
    if (!el) {
      el = document.createElement('div'); el.id = 'gatepic'; el.className = 'gatepic'; el.setAttribute('role', 'button');
      el.innerHTML = '<p class="gp-msg"></p><img alt="">'; $('.stagewrap').appendChild(el);
      el.addEventListener('click', () => { if (S.def && S.gate) sheet([S.def.meta.scan]); });
    }
    const img = el.querySelector('img'), tok = S.gpTok = (S.gpTok || 0) + 1;
    el.classList.remove('has', 'dim'); img.onload = img.onerror = null; img.removeAttribute('src');
    $('#app').classList.remove('pic');
    if (skip || (S.gate !== 'pick' && !(S.gate === 'open' && q.type === 'math') && !(S.gate && q.xin))) return;   // 数学题没有选项（填空、解答）时也放原卷；新讲法的题开讲前也放
    const ok = () => { if (tok === S.gpTok) { el.classList.add('has'); $('#app').classList.toggle('pic', !!S.gate); } };
    const raw = () => { if (tok !== S.gpTok) return; el.classList.add('dim'); img.onload = ok; img.onerror = () => {}; img.src = qb + q.scan; };
    img.onload = ok; img.onerror = raw; img.src = qb + 'q_dark.png';
  }
  async function tryOpen(id, o) { try { await open(id, o); return true; } catch (e) { miss(id); return false; } }

  /* 点完答案以后从哪开讲：这块知识看完过，就从第一个“逐项判断”开始（前面的格子算走过，随时能拖回去） */
  function start() {
    const P = S.P; let i = 0;
    if (S.xdoc) { i = Math.min(P.N - 1, S.xdoc.next(-1)); if (i > 0) P.go(i, { replay: true }); else P.go(0); return; }   // 新讲法：从头讲，开头是别的题讲过的 unit 就跳过
    if (S.known[S.q.unit]) { i = P.steps.findIndex((s) => s.sec === 'solve' || s.sec === 'check' || s.part != null); /* 知识块看过了：从“本题演算”开始，没有就从“逐项判断”开始 */ if (i < 0) i = S.uLast + 1 < P.N ? S.uLast + 1 : 0; }
    if (i > 0) P.go(i, { replay: true }); else P.go(0);
  }
  /* 开讲前点答案：k 是 A–D；null 是“不会”；'done' 是没有选项的题点了“做完了，开始讲” */
  function pick(k) {
    if (!S.gate) return;
    if (k === 'first') { S.gate = 'open'; paintGate(); return; }   // 新讲法“我先做”：回到原来的作答流程（纸上写完点“写完了”，讲完自己报对错）
    const patch = k === 'direct' ? { choice: null, correct: false, skip: true, unlearned: true }   // 新讲法“直接讲”：记成没学过（统计上和“没做出来”一样算不会）
      : k === null ? { choice: null, correct: false, skip: true }
      : k === 'done' ? { choice: null, correct: null } : { choice: k, correct: k === S.def.meta.answer };
    record(S.id, Object.assign(patch, { t: new Date().toISOString() }));
    S.gate = null; S.me = patch.choice;
    paintGate(); start();
  }
  /* 没有选项的题，讲完自己报对错，报完进下一道 */
  function report(ok) {
    record(S.id, { correct: ok, fin: true }); paintGate(); paintTag();
    if (!ok && Kit.mock && Kit.mock.can(S.q)) return;   // 报了做错、这一节有补练题：先停在这里，让结尾的补练入口露出来；▶ / 往左滑照旧进下一道
    nextQ();
  }

  /* 进题单里的下一道；当前这道不在题单里，就回到题单里第一道没做完的。做不出来的题跳过，记到 data/missing.json */
  let going = false;
  async function nextQ() {
    if (going) return;
    if (S.read) { leaveRead(); return; }   // 读题看完再往下走：回到开讲前
    if (S.redo) { leaveRedo(); return; }   // 重讲放完再往下走：回到原讲解那一步
    if (pend()) { const b = $('#gbtns'); b.classList.remove('nudge'); void b.offsetWidth; b.classList.add('nudge'); return; }
    const list = L(); if (!list.length) return;
    const k = list.indexOf(S.id), cand = k >= 0 ? list.slice(k + 1) : list.filter((id) => !done(id));
    going = true;
    try { for (const id of cand) { if (id === S.id || S.missing.has(id)) continue; if (await tryOpen(id)) return; } }
    finally { going = false; }
    $('#btnNext').disabled = !hasNext();   // 后面的都做不出来：▶ 变灰
  }
  /* 往下走一步；已经在最后一步、画面也停了，就进下一道 */
  function advance() {
    const P = S.P; if (!P || S.gate) return;
    if (S.xdoc && P.index >= 0) { const j = S.xdoc.next(P.index); if (j > P.index + 1) { if (j < P.N) P.go(j, { replay: true }); else if (!P.busy) nextQ(); else P.next(); return; } }   // 新讲法：跳过折叠着的 unit
    if (P.index >= P.N - 1 && !P.busy) nextQ(); else P.next();
  }
  function back() {
    const P = S.P; if (!P || S.gate) return;
    if (S.xdoc) { const j = S.xdoc.prev(P.index); if (j >= 0 && j < P.index - 1) { P.go(j, { instant: true }); return; } }
    P.prev();
  }
  const secOf = (s) => s.xsec || s.sec;   // 进度条按哪个分段：新讲法的步骤用 lesson.json 里的 sec（xsec），别的照旧

  function onStep(i, s) {
    const P = S.P;
    const cap = $('#cap'); cap.textContent = s && !S.xin ? String(T('steps.' + s.id + '.cap')).replace(/。$/, '') : '';
    cap.classList.remove('swap'); void cap.offsetWidth; cap.classList.add('swap');
    const cur = s ? S.secs.indexOf(secOf(s)) : -1;
    if (S.xdoc && i >= 0) S.xdoc.paint(i);   // 新讲法：讲稿长到这一段
    document.querySelectorAll('.seg').forEach((el, k) => { el.classList.toggle('on', k === cur); el.classList.toggle('past', k < cur); });
    if (S.uLast >= 0 && S.prevI === S.uLast && i === S.uLast + 1) seenUnit();   // 从知识块的最后一步接着往下走了，也算看完
    S.prevI = i; S.end = false;
    $('#btnPrev').disabled = !!S.gate || i <= 0; $('#btnNext').disabled = !!S.gate || (i >= P.N - 1 && !P.busy && !hasNext() && !S.redo && !S.read);
    if (S.read) Kit.read.paint($('#stem'), $('#opts'), s);   // 读题：左栏这一步的那几句亮起来
    $('#tip').textContent = s ? T('steps.' + s.id + '.h') : '';
    paintOpts(); paintFlags(); paintGate(); remember(i); fitRail();
    if (!S.quiet && !S.read) post('/state', Object.assign({ lesson: S.id, step: i, stepId: s ? s.id : null, n: P.N, gate: S.gate }, S.redo ? { redo: S.redo.dir } : {}));
  }
  function onDone(i, s) {
    if (s && s.opt) S.judged[s.opt] = s.verdict;
    if (s && s.answer) S.def.meta.opts.forEach((k) => { S.judged[k] = k === S.def.meta.answer ? 'ok' : 'no'; });
    if (i === S.uLast) seenUnit();
    if (S.xdoc && s && s.x && s.x.unit) { const B = S.xdoc.block(i); if (B && i === B.b) seenX(B.u); }   // 新讲法：一个 unit 的最后一段演完，记成讲过
    S.end = i >= S.P.N - 1;
    if (S.end) { const r = rec(S.id); if (r && !r.fin && !pend()) { record(S.id, { fin: true }); } }
    $('#btnNext').disabled = S.end && !hasNext() && !S.redo && !S.read;
    paintOpts(); paintGate(); fitRail();
  }
  function paintOpts() {
    const s = S.P.steps[S.P.index], pf = $('#opts').classList.contains('pickf');   // pf：要选的那项（ok）说法不成立，记 ✗；其余说法成立，记 ✓
    document.querySelectorAll('.opt').forEach((el) => {
      const v = S.judged[el.dataset.k] || ''; el.dataset.v = v; el.querySelector('.mk').textContent = v === 'ok' ? (pf ? '✗' : '✓') : v === 'no' ? (pf ? '✓' : '✗') : '';
      el.classList.toggle('cur', !!s && s.opt === el.dataset.k);
      el.classList.toggle('me', !S.gate && S.me === el.dataset.k);   // 他开讲前选的那项：左边一条细竖线；判错了变红
    });
    document.querySelectorAll('#opts .part').forEach((el) => el.classList.toggle('cur', !!s && s.part === el.dataset.part));   // 综合题：正在讲的那一小问
  }
  /* 开讲前的那一屏，和讲完自己报对错的两个按钮 */
  function paintGate() {
    const app = $('#app'), msg = $('#gateMsg'), gb = $('#gbtns');
    if (Kit.mock) Kit.mock.paintEnd();   // 讲完一道做错 / 不会的题：左栏底下的补练入口（kit/mock.js）
    paintRead();
    app.classList.toggle('gating', !!S.gate);
    msg.textContent = S.gate === 'pick' ? U('ui.gate.ask') : S.gate === 'open' ? U('ui.gate.askOpen') : S.gate === 'xin' ? U('ui.xin.ask') : '';
    $('#gatepic .gp-msg').textContent = S.gate === 'pick' ? U('ui.gate.ask') : S.gate === 'xin' ? U('ui.xin.ask') : S.gate === 'open' && S.xin ? U('ui.gate.askOpen') : '';
    if (!S.gate) $('#app').classList.remove('pic');
    const btn = (a, k, c) => `<button class="gbtn${c ? ' ' + c : ''}" data-a="${a}">${esc(U(k))}</button>`;
    const want = S.gate === 'pick' ? 'p' : S.gate === 'open' ? 'o' : S.gate === 'xin' ? 'x' : S.end && pend() ? 'r' : '';
    if (gb.dataset.k === want) return;
    gb.dataset.k = want;
    gb.innerHTML = want === 'x' ? btn('first', 'ui.xin.first') + btn('direct', 'ui.xin.direct', 'go')   // 新讲法：我先做 / 直接讲
      : want === 'p' ? btn('skip', 'ui.gate.skip')
      : want === 'o' ? btn('done', 'ui.gate.done', 'go') + btn('skip', 'ui.gate.skip')
      : want === 'r' ? btn('right', 'ui.gate.right', 'ok') + btn('wrong', 'ui.gate.wrong', 'no') : '';
  }
  /* 读题入口：开讲前、这道题有 read.json 才露出来 */
  function paintRead() { $('#rdIn').classList.toggle('on', !!S.gate && S.canRead && !S.quiet); }
  async function enterRead() {
    if (!S.gate || !S.canRead || going) return;
    try { await open(S.id, { read: true }); } catch (e) { toast(U('ui.fb.fail')); }
  }
  function leaveRead() { if (S.read) tryOpen(S.id); }   // 回到开讲前：没点过答案，重新打开就是开讲前那一屏
  $('#rdIn').onclick = enterRead;

  /* ---------- 408 / 数学 模块 ---------- */
  function paintMods() {
    $('#app').classList.toggle('nomods', !allL().length);   // 没有今日题单：开关藏起来，和以前一样
    document.querySelectorAll('#mods button').forEach((b) => { const on = b.dataset.m === S.mod; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  }
  /* 题干框限高、框内上下滑（flex 自己缩），底下还有内容就加 .more 出渐隐；缩到最小选项还排不下，才让整条左栏滑（.scrolls）。装得下就什么都不加，样子不变 */
  /* 新讲法：题干超出最大高度时露出小箭头（点开 / 收起），并给底部淡出 */
  function stemTog() { const e = $('#stem'), a = $('#app'), t = $('#stemTog'), more = e.scrollHeight > e.clientHeight + 8; t.classList.toggle('on', more || a.classList.contains('stemopen')); stemMore(); }
  $('#stemTog').onclick = () => { $('#app').classList.toggle('stemopen'); $('#stem').scrollTop = 0; stemTog(); };
  function stemMore() { const e = $('#stem'); e.classList.toggle('more', e.scrollHeight - e.scrollTop - e.clientHeight > 8); }   // 行内分式/下标会比行盒多出几像素（实测 3px），不算“还有内容”，否则误出箭头和渐隐
  function fitRail() { const r = $('#rail'); r.classList.remove('scrolls'); if (S.xin) { stemTog(); if (S.xdoc && !S.P.busy) S.xdoc.seek(true); return; } if (r.scrollHeight > r.clientHeight + 1) r.classList.add('scrolls'); stemMore(); }
  $('#stem').addEventListener('scroll', stemMore, { passive: true });
  $('#stem').addEventListener('load', fitRail, true);   // 题干里的小图（q.stemFig）加载完，高度变了：重算限高和底部淡出
  addEventListener('resize', fitRail);
  /* 记下这个模块停在哪道题哪一步（开讲前记 -1），以及上次用的是哪个模块；自动截图时不记 */
  function remember(i) {
    if (S.quiet || !S.id || S.redo || S.read) return;
    S.mem.last = S.mod; S.mem[S.mod] = { id: S.id, at: S.gate ? -1 : i, date: today() };
    store('b2mod', S.mem);
  }
  /* 这个模块今天没有题（或一道都打不开）：沿用外壳的“没有题”空状态，开关留着 */
  function showEmpty(m) {
    S.mod = m; if (S.P) { S.P.destroy(); S.P = null; }
    S.id = null; S.def = null; S.q = null; S.gate = null; S.redo = null; S.read = false; S.canRead = false; S.gpTok = (S.gpTok || 0) + 1;
    const app = $('#app'); app.classList.add('none'); app.classList.remove('gating', 'pic', 'big', 'redo', 'reading', 'xin', 'stemopen'); S.xin = null; S.xdoc = null; paintRead();
    if (!S.quiet) { S.mem.last = m; store('b2mod', S.mem); }
    paintMods();
  }
  /* 进一个模块：回到上次停的那道题那一步；没有记录（或不是今天的）就从这个模块第一道没做完的题开始。返回 true = 进去了或显示了空状态 */
  async function enterMod(m) {
    if (going) return false;
    S.mod = m; paintMods();
    const list = L(), mem = S.mem[m];
    const back = mem && mem.date === today() && list.includes(mem.id) && !S.missing.has(mem.id) ? mem : null;
    going = true;
    try {
      if (back) { const r = rec(back.id); if (await tryOpen(back.id, r && back.at >= 0 ? { at: back.at } : {})) return true; }
      for (const id of list.filter((x) => !done(x)).concat(list.filter(done).reverse())) { if (back && id === back.id) continue; if (await tryOpen(id)) return true; }
    } finally { going = false; }
    showEmpty(m); return true;
  }
  $('#mods').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b || b.dataset.m === S.mod) return; closeAll(); enterMod(b.dataset.m); });

  /* 左上角：题号，有题单时旁边小字“第几道/共几道” */
  function paintTag() {
    const m = S.def.meta, list = L(), k = list.indexOf(S.id);
    $('#tag').innerHTML = esc(m.year + ' · ' + m.no) + (k >= 0 ? `<small class="pos">${k + 1}/${list.length}</small>` : '') + '<svg class="tgo" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';   // 小 ›：看得出点了能选题
    const t = $('#tag'); t.classList.remove('tight'); if (t.scrollWidth > t.clientWidth + 1) t.classList.add('tight');   // 题号加进度放不下（数学的“1988 · 三(3)”）：缩小一档，免得把右边的“看书”图标挤出左栏
  }
  function onTime(p) {
    const N = S.cells.length, tr = $('#track');
    for (let k = 0; k < N; k++) S.cells[k].style.setProperty('--p', Math.max(0, Math.min(1, p - k)));
    const i = Math.min(N - 1, Math.floor(p)), c = S.cells[i]; if (!c) return;
    const x = c.offsetLeft + c.offsetWidth * Math.min(1, p - i);
    if (i !== S.curCell) { if (S.cells[S.curCell]) S.cells[S.curCell].classList.remove('cur'); c.classList.add('cur'); S.curCell = i; }
    /* 每帧都在动：用 translate 挪（不改 left / top，不触发重排）；.thumb 自己的 translate -50% 居中并进来 */
    $('#thumb').style.translate = `calc(${x}px - 50%) calc(${c.offsetTop + c.offsetHeight / 2}px - 50%)`;
    $('#tip').style.translate = Math.max(70, Math.min(tr.clientWidth - 70, x)) + 'px 0';
  }

  /* ---------- 画面上的手势 ---------- */
  const stage = $('#stage'); let g = null;
  /* 浮层开着（问答 / 报修面板、“问这里”、出处书页、原卷 / 书页、选题抽屉、薄弱点）：点画面、横滑、点讲稿、键盘都不翻步，面板也不关；
     ◀ ▶、进度条、左栏选项这些明确的按钮照常。“问这里”一按就收（kit/ask.js 在捕获阶段收），所以按下那一刻先记一下 */
  const OVL = ['#fbp', '#akPg', '#akHere', '#sheet', '#drawer', '#weak'];
  const overlay = () => OVL.some((k) => { const el = $(k); return !!el && el.classList.contains('on'); });
  let ovlDown = false;
  document.addEventListener('pointerdown', () => { ovlDown = overlay(); }, true);
  const frac = (e) => -(e.clientX - g.x) / (stage.clientWidth * 0.4);
  /* 能点的东西（.hot.can）：手指落在它上面，或者落在它旁边、把它补足 44×44 以后的范围里，都算按在它上面。
     盖住大半个画面的（比如推近书页后“点哪都退回去”的那层）不算，免得整个画面都滑不动 */
  function hotNear(x, y, tgt) {
    const big = (el) => { const r = el.getBoundingClientRect(), s = stage.getBoundingClientRect(); return r.width * r.height > s.width * s.height * 0.4; };
    const h = tgt && tgt.closest && tgt.closest('.hot.can'); if (h) return big(h) ? null : h;
    let best = null, bd = 1e9;
    stage.querySelectorAll('.hot.can').forEach((el) => {
      const r = el.getBoundingClientRect(), dx = Math.abs(x - r.left - r.width / 2), dy = Math.abs(y - r.top - r.height / 2);
      if (dx <= Math.max(22, r.width / 2) && dy <= Math.max(22, r.height / 2) && !big(el)) { const d = Math.hypot(dx, dy); if (d < bd) { bd = d; best = el; } }
    });
    return best;
  }
  /* own：按在自己管拖动的东西上（数学题的 3D 图，.own-drag），或按在能点的东西上，拖动不当成翻步，只认“点一下”；
     先竖着动了（dead），这一下就不翻步 */
  stage.addEventListener('pointerdown', (e) => {
    if (Kit.phone && Kit.phone.down(e)) { if (g) { clearTimeout(g.lp); if (g.drag) S.P.scrubEnd(0, 0); g = null; } return; }   // 手机：第二根手指落下 = 捏合放大（kit/phone.js），第一根手指的手势作废
    if (e.button || !S.P || S.gate) return;
    const hot = hotNear(e.clientX, e.clientY, e.target);
    g = { own: !!e.target.closest('.own-drag') || !!hot, hot, lock: ovlDown, x: e.clientX, y: e.clientY, x0: e.clientX, drag: false, dead: false, lx: e.clientX, lt: performance.now(), v: 0, target: e.target, id: e.pointerId, end: S.P.index >= S.P.N - 1 && !S.P.busy };
    /* 长按画面上的高亮框（约 450ms 不动）：冒出“问这里”（kit/ask.js）；这一下松手就不当成点一下往下走 */
    const G0 = g; if (Kit.ask && !e.target.closest('.own-drag')) G0.lp = setTimeout(() => { if (g === G0 && !G0.drag && !G0.dead && Kit.ask.pressStage(G0.x0, G0.y)) G0.long = true; }, 450);
  });
  stage.addEventListener('pointermove', (e) => {
    if (Kit.phone && Kit.phone.move(e)) return;   // 手机：正在捏合
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y;
    if (g.lp && Math.hypot(dx, dy) > 10) { clearTimeout(g.lp); g.lp = 0; }   // 手指动了超过 10 像素：不算长按
    if (!g.own && !g.long && !g.drag && Kit.phone && Kit.phone.pan(e, g)) return;   // 手机：放大着，单指是平移
    if (g.own || g.dead || g.long || g.lock) return;   // 浮层开着：横滑不拖着走
    if (!g.drag) {
      if (Math.abs(dy) >= 12 && Math.abs(dy) > Math.abs(dx)) { g.dead = true; return; }
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      g.drag = true; g.x = e.clientX; stage.setPointerCapture(e.pointerId); S.P.scrubStart();
    }
    const now = performance.now(); if (now > g.lt) { g.v = (e.clientX - g.lx) / (now - g.lt); g.lx = e.clientX; g.lt = now; }
    S.P.scrubMove(frac(e));
  });
  function ripple(x, y) { const r = document.createElement('div'); r.className = 'ripple'; r.style.left = x + 'px'; r.style.top = y + 'px'; document.body.appendChild(r); setTimeout(() => r.remove(), 520); }
  function endGesture(e, cancel) {
    if (Kit.phone) Kit.phone.up(e);
    if (!g || e.pointerId !== g.id) return;
    const G = g; clearTimeout(G.lp);
    if (G.long) { g = null; return; }
    if (G.drag) {
      const f = cancel ? 0 : frac(e), flick = cancel || Math.abs(G.v) < 0.4 ? 0 : (G.v < 0 ? 1 : -1); g = null;
      S.P.scrubEnd(f, flick);
      if (G.end && (f > 0.3 || (flick > 0 && f > 0.03))) nextQ();   // 最后一步再往左滑：下一道
      return;
    }
    g = null;
    if (cancel || Math.hypot(e.clientX - G.x0, e.clientY - G.y) > 12) return;
    if (S.P.tap(G.target)) return;
    if (G.hot && S.P.tap(G.hot)) return;   // 手指落在能点的东西旁边一点（补足 44 像素的范围里）也算点到它
    if (G.lock) return;   // 浮层开着：点空白不往下走
    const x = e.clientX, y = e.clientY;
    if (Kit.phone && Kit.phone.tap(e, () => { ripple(x, y); advance(); })) return;   // 手机：等一下看是不是双击（双击切“自动推近 / 整图”）
    ripple(x, y); advance();
  }
  stage.addEventListener('pointerup', (e) => endGesture(e, false));
  stage.addEventListener('pointercancel', (e) => endGesture(e, true));

  /* ---------- 进度条 ---------- */
  const track = $('#track'); let td = null;
  const posAt = (x) => { const px = x - track.getBoundingClientRect().left; for (let k = 0; k < S.cells.length; k++) { const c = S.cells[k], a = c.offsetLeft, b = a + c.offsetWidth; if (px < a) return k; if (px <= b) return k + (px - a) / (b - a); } return S.cells.length; };
  track.addEventListener('pointerdown', (e) => {
    if (!S.P || S.gate) return;
    const nm = e.target.closest('.nm');
    td = { x: e.clientX, nm: nm ? nm.parentElement : null, on: false };
    track.setPointerCapture(e.pointerId);
    if (!nm) { td.on = true; track.classList.add('drag'); S.P.seekStart(); S.P.seekMove(posAt(e.clientX)); }
  });
  track.addEventListener('pointermove', (e) => {
    if (!td) return;
    if (!td.on && Math.abs(e.clientX - td.x) > 10) { td.on = true; track.classList.add('drag'); S.P.seekStart(); }
    if (td.on) S.P.seekMove(posAt(e.clientX));
  });
  const tend = () => {
    if (!td) return; const d = td; td = null; track.classList.remove('drag');
    if (d.on) S.P.seekEnd(); else if (d.nm) S.P.go(+d.nm.dataset.first, { replay: true });
  };
  track.addEventListener('pointerup', tend); track.addEventListener('pointercancel', tend);

  $('#btnNext').onclick = advance;
  $('#btnPrev').onclick = back;
  document.addEventListener('keydown', (e) => {
    if (!S.P || S.gate || S.mock || overlay() || (e.target.closest && e.target.closest('textarea, input'))) return;   // 在反馈框里打字时、在补练里时、浮层开着时不翻步
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); advance(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') back();
    else if (e.key === 'r') S.P.replay();
  });

  /* ---------- 左栏 ---------- */
  $('#opts').addEventListener('click', (e) => {
    const pb = e.target.closest('.part');   // 综合题的小问入口：跳到那一小问的第一步（开讲前不理）
    if (pb) { if (!S.P || S.gate) return; const i = S.P.steps.findIndex((s) => s.part === pb.dataset.part); if (i >= 0) S.P.go(i, { replay: true }); return; }
    const b = e.target.closest('.opt'); if (!b || !S.P) return;
    if (S.gate === 'pick') { pick(b.dataset.k); return; }   // 开讲前：选项就是“我选这个”
    const i = S.P.steps.findIndex((s) => s.opt === b.dataset.k); if (i >= 0) S.P.go(i, { replay: true });
  });
  $('#gbtns').addEventListener('click', (e) => {
    const b = e.target.closest('.gbtn'); if (!b || !S.P) return;
    const a = b.dataset.a;
    if (a === 'skip') pick(null); else if (a === 'done') pick('done'); else if (a === 'first' || a === 'direct') pick(a); else if (a === 'right' || a === 'wrong') report(a === 'right');
  });

  /* 新讲法的讲稿（#xdoc）：点术语看解释（再点收起）；点折叠行展开重看那个 unit；点清单条目、点某一段，画面跳回那一步 */
  $('#xdoc').addEventListener('click', (e) => {
    const P = S.P; if (!P || !S.xdoc || S.gate) return;
    if (e.target.closest('.xcl a')) return;   // 计组课链接：新标签打开，不跳段
    const xc = e.target.closest('.xcite'); if (xc) { const cs = S.def.meta.cites; bookSheet(String(xc.dataset.ci).split(',').map((k) => cs[+k]).filter(Boolean)); return; }   // 这一段的书页出处：只开这几页
    const cb = e.target.closest('.xcb'); if (cb) { const l = cb.parentNode.querySelector('.xcl'); l.hidden = !l.hidden; cb.classList.toggle('on', !l.hidden); return; }   // 计组课入口：展开 / 收起课名
    const w = e.target.closest('.xw');
    if (w && !w.classList.contains('first')) {
      const box = w.closest('.xp').querySelector('.xdefs'), k = w.dataset.k;
      let d = box.querySelector(`.xd[data-k="${CSS.escape(k)}"]`);
      if (!d) { d = document.createElement('p'); d.className = 'xd'; d.dataset.k = k; d.textContent = T('terms.' + k); box.appendChild(d); }
      d.classList.toggle('on'); w.classList.toggle('on', d.classList.contains('on'));
      return;
    }
    if (ovlDown) return;   // 浮层开着：点讲稿不跳步（术语、计组课照常能点）
    const f = e.target.closest('.xfold'); if (f) { S.xdoc.open(f.dataset.u); P.go(+f.dataset.i, { replay: true }); return; }
    const it = e.target.closest('.xsi'); if (it) { const i = P.steps.findIndex((s) => s.id === it.dataset.go || (s.x && s.x.id === it.dataset.go)); if (i >= 0) P.go(i, { replay: true }); return; }
    const p = e.target.closest('.xp'); if (p && +p.dataset.i !== P.index) P.go(+p.dataset.i, { replay: true });
  });

  /* “没懂”标记：记在这一步上。本机存一份，电脑上也存一份（data/flags.json），讲解那边能看到。 */
  function paintFlags() {
    if (!S.P) return;
    const list = S.flags[S.id] || [], s = S.P.steps[S.P.index];
    $('#btnFlag').classList.toggle('on', !!s && list.includes(s.id));
    S.cells.forEach((c, k) => c.classList.toggle('flagged', list.includes(S.P.steps[k].id)));
  }
  $('#btnFlag').onclick = () => {
    const s = S.P && S.P.steps[S.P.index]; if (!s) return;
    const list = S.flags[S.id] = S.flags[S.id] || [], k = list.indexOf(s.id);
    if (k >= 0) list.splice(k, 1); else list.push(s.id);
    store('b2flags', S.flags);
    post('/flag', { lesson: S.id, stepId: s.id, on: k < 0 });
    paintFlags();
  };

  /* ---------- 讲过的题、书页、原卷放大 ---------- */
  const scrim = $('#scrim');
  const closeAll = () => { ['#drawer', '#sheet', '#fbp', '#weak'].forEach((k) => $(k).classList.remove('on')); scrim.classList.remove('on'); $('#fbText').blur(); };
  /* 点暗幕、点 ×、滑走：只关盖着的那一层（抽屉、原卷 / 书页、薄弱点），旁边开着的问答面板不跟着关；换题时才用 closeAll 全关 */
  const closeTop = () => { ['#drawer', '#sheet', '#weak'].forEach((k) => $(k).classList.remove('on')); scrim.classList.remove('on'); };
  scrim.onclick = closeTop; $('#sheetClose').onclick = closeTop;
  const flagN = (id) => (S.flags[id] || []).length;
  /* 顶上一行当天的三个数（有今日题单时）：做了几道 / 对了几道 / 标了几步没懂，只算今天 */
  function paintSum() {
    const list = L(); $('#sum').classList.toggle('on', !!list.length); if (!list.length) return;
    const nDone = list.filter((id) => rec(id)).length, nOk = list.filter((id) => (rec(id) || {}).correct === true).length;
    const nFlag = list.reduce((a, id) => a + flagN(id), 0);
    $('#sumDone').innerHTML = nDone + `<small>/${list.length}</small>`; $('#sumOk').textContent = nOk; $('#sumFlag').textContent = nFlag;
  }

  /* ---------- 选题：年份 → 题型 → 题号格子 ----------
     题从哪来：今日题单（data/today.json）加讲过的题（data/index.json），只算当前模块。
     对错看每道题最近一次的记录（GET /records 的所有日期 + 本机的），“没懂”是 data/flags.json 加本机的标记。
     题型：408 第 1–40 题是选择题，41–47 是大题；数学按题库 bank/math/<年>/index.json 里这道小题的 type
     （choice 选择、fill 填空、solve / prove 解答），题库里没有这一题再看 q.json 的 kind，还没有就按有没有选项、详解几步猜。
     打开时停在当前这道题所在的年份和题型那一层；往里走新的一层从右边滑进来，返回从左边滑回来。 */
  /* 2026-11-22 加：sort 卷子那一层怎么排（type 先分题型再出题号格子 / no 整张卷子按题号排成一片，少一层），记在本机；
     mem 上次关抽屉时停在哪（哪道题时关的、第几层、年份、题型、滚到哪），同一道题再打开就回到那里，换了题就停在新题所在的那张卷子 */
  const NV = { lv: 1, year: null, type: null, recs: null, bank: {}, kinds: {}, sort: stored('b2navSort', 'type') === 'no' ? 'no' : 'type', mem: stored('b2navMem', null) };
  const TYPES = { exam: ['choice', 'big'], math: ['choice', 'fill', 'solve'] };
  const yearOf = (id) => String(id).replace(/^m/, '').split('-')[0];
  const bidOf = (id) => String(id).replace(/^m/, '').split('-').slice(1).join('-');   // 数学题在题库里的 id（m1988-3-3 → 3-3）
  const byNo = (a, b) => a.localeCompare(b, 'en', { numeric: true });
  /* 当前模块能选的题：题单 + 讲过的，去重，按题号排 */
  const pool = () => [...new Set(allL().concat(S.entries.map((en) => en.id)))].filter((id) => modOf(id) === S.mod).sort(byNo);
  /* 每道题最近一次的记录，和“没懂”标了几步（薄弱点页也用） */
  function mergeRecs(d) {
    const last = {}, flags = {};
    const take = (id, r, date) => { if (!r || typeof r !== 'object') return; const k = (r.date || date || '') + ' ' + (r.t || ''); if (!last[id] || k >= last[id].k) last[id] = { k, r }; };
    if (d && d.answers) for (const date in d.answers) for (const id in d.answers[date]) take(id, d.answers[date][id], date);
    for (const id in S.ans) take(id, S.ans[id], S.ans[id] && S.ans[id].date);
    [d && d.flags, S.flags].forEach((f) => { for (const id in f || {}) flags[id] = [...new Set((flags[id] || []).concat(f[id] || []))]; });
    return { last, flags };
  }
  /* 一道题的状态：'' 没做 / ok 做对 / no 做错 / skip 点了“不会” / wait 讲了还没报对错 */
  function stOf(id) {
    const R = NV.recs || mergeRecs(null), r = (R.last[id] || {}).r;
    return !r ? '' : r.skip ? 'skip' : r.correct === true ? 'ok' : r.correct === false ? 'no' : 'wait';
  }
  const flagsOf = (id) => ((NV.recs || mergeRecs(null)).flags[id] || []).length;
  /* 数学题的题型：先读这一年的题库（一年一次），没有再看 q.json */
  const mathKind = (t) => (t === 'choice' ? 'choice' : t === 'fill' ? 'fill' : t === 'solve' || t === 'prove' ? 'solve' : null);
  function bankYear(y) {
    return NV.bank[y] || (NV.bank[y] = getJSON('bank/math/' + y + '/index.json').then((a) => {
      const m = {}; (Array.isArray(a) ? a : []).forEach((x) => { if (x && x.id != null) m[String(x.id)] = mathKind(x.type); }); return m;
    }).catch(() => ({})));
  }
  async function kindsOf(y) {
    if (S.mod === 'exam') return;
    const ids = pool().filter((id) => yearOf(id) === y && !NV.kinds[id]); if (!ids.length) return;
    const b = await bankYear(y);
    await Promise.all(ids.map(async (id) => {
      let k = b[bidOf(id)];
      if (!k) {   // 题库里没有：q.json 的 kind / type，再没有就猜：有选项是选择题，详解超过两步是解答题，其余填空题
        const q = await qInfo(id) || {};
        k = mathKind(q.kind) || mathKind(q.type) || (Array.isArray(q.opts) && q.opts.length ? 'choice' : (q.steps || []).length > 2 ? 'solve' : 'fill');
      }
      NV.kinds[id] = k;
    }));
  }
  const typeOf = (id) => (S.mod === 'exam' ? ((+String(id).split('-')[1] || 0) <= 40 ? 'choice' : 'big') : NV.kinds[id] || null);
  const labelOf = (id) => { if (S.mod === 'exam') return String(+String(id).split('-')[1] || String(id).split('-')[1]); const en = S.entries.find((x) => x.id === id); return en && en.no != null ? String(en.no) : bidOf(id); };
  /* 做了几道 / 共几道：细进度条 + 数字 */
  const meter = (ids) => { const n = ids.filter((id) => stOf(id)).length, f = ids.length ? n / ids.length : 0; return `<i class="pb"><i style="--f:${f.toFixed(3)}"></i></i><small><b>${n}</b>/${ids.length}</small>`; };
  function paneHTML() {
    const all = pool();
    if (NV.lv === 1) {
      const ys = [...new Set(all.map(yearOf))].sort(byNo), cur = S.id && modOf(S.id) === S.mod ? yearOf(S.id) : null;
      return `<div class="yrs">${ys.map((y) => `<button class="yr${y === cur ? ' on' : ''}" data-y="${esc(y)}"><b>${esc(y)}</b>${meter(all.filter((id) => yearOf(id) === y))}</button>`).join('')}</div>`;
    }
    const inY = all.filter((id) => yearOf(id) === NV.year);
    /* 卷子这一层顶上：按题型 / 按题号 两档切换 */
    const sortBar = `<div class="nvsort">${['type', 'no'].map((k) => `<button data-sort="${k}" class="${NV.sort === k ? 'on' : ''}" aria-pressed="${NV.sort === k}">${esc(U(k === 'no' ? 'ui.nav.byNo' : 'ui.nav.byType'))}</button>`).join('')}</div>`;
    const cells = (ids) => `<div class="cells ${S.mod}">${ids.map((id, i) => { const st = stOf(id), nf = flagsOf(id); return `<button class="cell${id === S.id ? ' cur' : ''}${nf ? ' fl' : ''}${S.missing.has(id) ? ' miss' : ''}" data-id="${esc(id)}" data-s="${st}" style="--i:${i}">${esc(labelOf(id))}</button>`; }).join('')}</div>`;
    if (NV.lv === 2 && NV.sort === 'no') return sortBar + cells(inY);   // 整张卷子按题号（pool 已经按题号排好）
    if (NV.lv === 2) {
      const cur = S.id && yearOf(S.id) === NV.year ? typeOf(S.id) : null;
      return sortBar + `<div class="tys">${TYPES[S.mod].map((k) => { const ids = inY.filter((id) => typeOf(id) === k); return ids.length ? `<button class="ty${k === cur ? ' on' : ''}" data-k="${k}"><b>${esc(U('ui.nav.' + k))}</b>${meter(ids)}</button>` : ''; }).join('')}</div>`;
    }
    return sortBar + cells(inY.filter((id) => typeOf(id) === NV.type));
  }
  /* 顶上一行：‹（固定在左上角，第一层时占着位置但看不见）+ 面包屑（408 › 2010 › 选择题，点前面哪一段就跳回那一层）+ ×（关掉整个抽屉） */
  function nvHead() {
    $('#nvh').dataset.lv = NV.lv;
    const seg = [[1, esc(U('ui.mod.' + S.mod))]];
    if (NV.lv >= 2) seg.push([2, `<b>${esc(NV.year)}</b>`]);
    if (NV.lv >= 3) seg.push([3, esc(U('ui.nav.' + NV.type))]);
    $('#nvTitle').innerHTML = seg.map(([lv, t], k) => (k ? '<i>›</i>' : '') + (lv === NV.lv ? `<span class="bc now">${t}</span>` : `<button class="bc" data-lv="${lv}">${t}</button>`)).join('');
  }
  /* 换一层：dir 1 往里（新的从右边进），-1 返回（新的从左边进），0 原地重画（记录到了以后刷新数字） */
  async function nvShow(lv, dir) {
    const tok = NV.tok = (NV.tok || 0) + 1;
    if (lv === 3 && (NV.sort === 'no' || !NV.type)) lv = 2;   // 按题号排时没有题型那一层
    if (lv >= 2 && !NV.year) lv = 1;
    if (lv >= 2) await kindsOf(NV.year); if (tok !== NV.tok) return;
    NV.lv = lv; nvHead(); swapPane(paneHTML(), dir);
  }
  /* 抽屉里换一层的动画（选题和补练的逐级下钻共用）：dir 1 新的从右边进，-1 从左边进，0 原地换 */
  function swapPane(html, dir) {
    const box = $('#nv'), old = box.querySelector('.pane:not(.out)'), p = document.createElement('div');
    p.className = 'pane'; p.innerHTML = html;
    if (!dir || !old || document.documentElement.classList.contains('still')) { box.innerHTML = ''; box.appendChild(p); return; }
    p.classList.add(dir > 0 ? 'from-r' : 'from-l'); box.appendChild(p);
    old.classList.add('out', dir > 0 ? 'to-l' : 'to-r');
    void p.offsetWidth; p.classList.remove('from-r', 'from-l');
    setTimeout(() => old.remove(), 380);
  }
  /* 打开抽屉：还是上次关的时候那道题 → 回到上次那一层、那个滚动位置；换了题（或第一次开）→ 停在当前这道题所在那张卷子的题号格子；当前模块没有题就停在年份 */
  async function openNav() {
    paintSum(); NV.alt = null; NV.tok = (NV.tok || 0) + 1;
    const here = S.id && modOf(S.id) === S.mod && pool().includes(S.id), m = NV.mem, dw = $('#drawer');
    const back = !!(m && m.mod === S.mod && m.id === S.id && (!m.year || pool().some((id) => yearOf(id) === m.year)));
    let lv = 1;
    if (back) { NV.year = m.year; NV.type = m.type; lv = m.lv || 1; }
    else if (here) { NV.year = yearOf(S.id); await kindsOf(NV.year); NV.type = typeOf(S.id); lv = 3; }
    else NV.year = null;
    dw.classList.add('on'); scrim.classList.add('on');
    await nvShow(lv, 0);
    const c = $('#nv .pane:not(.out) .cell.cur');
    if (back) dw.scrollTop = m.scroll || 0;
    else if (c) { const r = c.getBoundingClientRect(); if (r.bottom > innerHeight - 20) dw.scrollTop += r.bottom - innerHeight * 0.6; else dw.scrollTop = 0; }
    else dw.scrollTop = 0;
    getJSON('records').then((d) => { NV.recs = mergeRecs(d); if (dw.classList.contains('on') && !NV.alt) { const cur = $('#nv .pane:not(.out)'); if (cur) cur.innerHTML = paneHTML(); } }).catch(() => {});
  }
  /* 抽屉关掉的那一刻（点暗幕、×、往左滑、点了一道题）记下停在哪；正在走补练的下钻时不记 */
  let navOn = false;
  new MutationObserver(() => {
    const dw = $('#drawer'), on = dw.classList.contains('on');
    if (navOn && !on && !NV.alt) { NV.mem = { mod: S.mod, id: S.id, lv: NV.lv, year: NV.year, type: NV.type, scroll: Math.round(dw.scrollTop) }; store('b2navMem', NV.mem); }
    navOn = on;
  }).observe($('#drawer'), { attributes: true, attributeFilter: ['class'] });
  /* NV.alt：抽屉里正在走补练的下钻（kit/mock.js 设），返回和点击交给它；它退回到选题时清掉 */
  function nvBack() { if (NV.alt) { NV.alt.back(); return; } if (NV.lv > 1) nvShow(NV.lv - 1, -1); }
  $('#tag').onclick = openNav;
  $('#nvBack').onclick = nvBack;
  $('#nvX').onclick = closeTop;
  $('#nvTitle').addEventListener('click', (e) => { const b = e.target.closest('.bc[data-lv]'); if (!b || NV.alt) return; nvShow(+b.dataset.lv, -1); });
  $('#nv').addEventListener('click', (e) => {
    if (NV.alt) { NV.alt.click(e); return; }
    const so = e.target.closest('.nvsort button'); if (so) { if (so.dataset.sort !== NV.sort) { NV.sort = so.dataset.sort; store('b2navSort', NV.sort); nvShow(NV.sort === 'no' ? 2 : NV.lv, 0); } return; }
    const y = e.target.closest('.yr'); if (y) { NV.year = y.dataset.y; nvShow(2, 1); return; }
    const t = e.target.closest('.ty'); if (t) { NV.type = t.dataset.k; nvShow(3, 1); return; }
    const c = e.target.closest('.cell'); if (!c) return;
    if (c.dataset.id !== S.id || S.redo) { closeAll(); tryOpen(c.dataset.id); } else closeTop();   // 点的就是当前这道：只收抽屉，问答面板开着就留着
  });
  $('#barpick').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; applyPrefs({ bar: b.dataset.k }); post('/pref', { bar: b.dataset.k }); });
  function sheet(imgs) { $('#pages').innerHTML = imgs.map((u) => `<img src="${esc(u)}" alt="">`).join(''); $('#sheet').scrollTop = 0; $('#sheet').classList.add('on'); }
  /* 书页出处（q.json 的 cites，2026-11-22 加）：[{k, b: 'co', p: 印刷页, box: [[x, y, w, h], ...], at: [步名...]}]，
     一个知识点一条；书页图是 qa_corpus 的原书扫描页（server.py 的 /corpus/），框是占整页宽高的比例。
     书的按钮：先出当前这一步讲到的那几页，再出别的出处页，最后是知识块原来那几页里还没出现过的；讲稿里某段的书页小按钮只开那一段的页。
     页上的小标题只由书名、页码拼出（“王道计组 第 111 页”），不另写字。 */
  /* b 写 ds / co / cn / os 是王道四本（资料库键 wd-<b>）；写带横杠的资料库键（zy-gs、zy-xd、zy-gl、zy-jc、zy-gssc）是张宇的书，书名照 qa_corpus/books.json。
     数学旧讲法题（没有 lesson.json）也用这个按钮：先出 cites 的书页，详解截图 sol.png 排在最后 */
  const BKN = { ds: '王道数据结构', co: '王道计组', cn: '王道计网', os: '王道操作系统', 'zy-gs': '张宇基础30讲高数', 'zy-xd': '张宇基础30讲线代', 'zy-gl': '张宇基础30讲概率', 'zy-jc': '张宇零基础通关讲义', 'zy-gssc': '张宇数学公式手册' };
  const corpusKey = (b) => (/-/.test(b) ? b : 'wd-' + b);
  function citePages(cs) {
    const pg = [];
    cs.forEach((c) => { let g = pg.find((x) => x.b === c.b && x.p === c.p); if (!g) pg.push(g = { b: c.b, p: c.p, img: c.img, box: [] }); g.box.push(...(c.box || [])); });
    return pg;
  }
  const citeHTML = (g) => `<figure class="cpage"><figcaption>${esc(BKN[g.b] || g.b)} 第 ${g.p} 页</figcaption><div class="cimg"><img src="${esc(g.img || `corpus/${corpusKey(g.b)}/p${String(g.p).padStart(4, '0')}.jpg`)}" alt="">`
    + `<svg viewBox="0 0 1000 1000" preserveAspectRatio="none">${g.box.map((b) => `<rect x="${b[0] * 1000}" y="${b[1] * 1000}" width="${b[2] * 1000}" height="${b[3] * 1000}"/>`).join('')}</svg></div></figure>`;
  function bookSheet(only) {
    const m = S.def.meta; if (!only && !m.cites.length) return sheet(m.book);
    let cs = only || m.cites;
    if (!only) { const s = S.P && S.P.steps[S.P.index], sid = s && s.id, here = (c) => (c.at || []).includes(sid); cs = cs.filter(here).concat(cs.filter((c) => !here(c))); }
    const pg = citePages(cs), have = new Set(pg.map((g) => g.b + g.p));
    const rest = only ? [] : m.book.filter((u) => { const k = /\/p(\d+)\.png$/.exec(u); return !(k && have.has(m.subject + +k[1])); });
    $('#pages').innerHTML = pg.map(citeHTML).join('') + rest.map((u) => `<img src="${esc(u)}" alt="">`).join('');
    $('#sheet').scrollTop = 0; $('#sheet').classList.add('on');
  }
  $('#btnBook').onclick = () => S.def && bookSheet();
  $('#stem').onclick = (e) => { if (!S.def) return; const f = e.target.closest && e.target.closest('.sfig'); sheet([f ? f.dataset.f : S.def.meta.scan]); };   // 点题干里的小图放大这一张，点字看整张原卷
  $('#sheet').addEventListener('click', (e) => { if (!e.target.closest('img, button')) closeTop(); });   // 书页 / 原卷：点图以外的地方关掉

  /* ---------- 触屏：面板跟着手指滑走 ----------
     抽屉往左滑走（往右滑 = 选题返回上一层）；薄弱点页、书页往下滑走（内容滚到顶以后才接）；反馈面板往上或往右滑走。
     手指移动超过面板的 1/4（或快速一甩）就关，不然弹回去。从输入框、3D 图上开始的不接；两根手指（放大书页）不接。 */
  function swipeAway(el, o) {
    let s = null;
    const end = () => {
      if (!s) return; const x = s; s = null; if (!x.on) return;
      el.classList.remove('swiping'); el.style.removeProperty('--sw'); el.style.removeProperty('--swo');
      const size = x.dir === 'l' || x.dir === 'r' ? el.offsetWidth : el.offsetHeight, fast = x.v > 0.5 && x.d > 30;
      if (x.d > size * 0.25 || fast) o.close();
    };
    el.addEventListener('touchstart', (e) => {
      s = null;
      if (e.touches.length !== 1 || !el.classList.contains('on') || e.target.closest('textarea, input, .own-drag')) return;
      if (window.visualViewport && visualViewport.scale > 1.01) return;   // 书页放大着：手指是在看图
      const t = e.touches[0]; s = { x: t.clientX, y: t.clientY, on: false, dead: false, d: 0, v: 0, lt: performance.now(), ld: 0 };
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (!s || s.dead) return;
      if (e.touches.length !== 1) { s.dead = true; return end(); }
      const t = e.touches[0], dx = t.clientX - s.x, dy = t.clientY - s.y;
      if (!s.on) {
        if (Math.hypot(dx, dy) < 10) return;
        const opts = [].concat(o.dir);   // 'l' 'r' 'u' 'd'：哪几个方向算“滑走”
        const dir = Math.abs(dx) > Math.abs(dy) * 1.2 ? (dx < 0 ? 'l' : 'r') : Math.abs(dy) > Math.abs(dx) * 1.2 ? (dy < 0 ? 'u' : 'd') : '';
        if (dir && o.alt && o.alt.dir === dir) { s.dead = true; s.alt = true; o.alt.run(); return; }
        const sc = o.scroller ? o.scroller(e.target) : null;
        if (!opts.includes(dir) || (dir === 'd' && sc && sc.scrollTop > 0)) { s.dead = true; return; }
        s.on = true; s.dir = dir; el.classList.add('swiping');
      }
      e.preventDefault();
      const d = Math.max(0, s.dir === 'l' ? -dx : s.dir === 'r' ? dx : s.dir === 'u' ? -dy : dy), now = performance.now();
      if (now > s.lt) { s.v = (d - s.ld) / (now - s.lt); s.ld = d; s.lt = now; }
      s.d = d;
      const off = s.dir === 'l' ? -d : s.dir === 'u' ? -d : d, ax = s.dir === 'l' || s.dir === 'r' ? 'X' : 'Y';
      el.style.setProperty('--sw', `translate${ax}(${off}px)`);
      el.style.setProperty('--swo', String(Math.max(0.35, 1 - d / ((ax === 'X' ? el.offsetWidth : el.offsetHeight) * 1.4))));
    }, { passive: false });
    el.addEventListener('touchend', end); el.addEventListener('touchcancel', () => { if (s) s.d = 0; end(); });
  }
  const selfScroll = (el) => () => el;
  swipeAway($('#drawer'), { dir: 'l', close: closeTop, alt: { dir: 'r', run: () => nvBack() } });
  swipeAway($('#weak'), { dir: 'd', close: closeTop, scroller: selfScroll($('#weak')) });
  swipeAway($('#sheet'), { dir: 'd', close: closeTop, scroller: selfScroll($('#sheet')) });
  /* 问答面板不用滑走关：它自己有把手（拖着调大小，拖到底收起）和收起按钮（kit/ask.js） */

  /* 按下就有反馈：手指一碰按钮就加 .press（不等 :active，也不靠鼠标悬停），抬起、滑走、被滚动打断都去掉 */
  const unpress = () => document.querySelectorAll('.press').forEach((el) => el.classList.remove('press'));
  document.addEventListener('pointerdown', (e) => { unpress(); const b = e.target.closest && e.target.closest('button:not(:disabled), .cell'); if (b) b.classList.add('press'); }, { passive: true });
  ['pointerup', 'pointercancel'].forEach((n) => document.addEventListener(n, unpress, { passive: true }));
  document.addEventListener('touchstart', () => {}, { passive: true });   // Safari 要有 touchstart 监听 :active 才会生效
  /* 长按不弹系统菜单、不选中字（反馈的输入框除外）；Safari 的两指缩放整页也拦掉（书页自己能放大） */
  document.addEventListener('contextmenu', (e) => { if (!(e.target.closest && e.target.closest('textarea, input'))) e.preventDefault(); });
  document.addEventListener('selectstart', (e) => { if (!(e.target.closest && e.target.closest('textarea, input'))) e.preventDefault(); });
  document.addEventListener('gesturestart', (e) => { if (!(e.target.closest && e.target.closest('.sheet'))) e.preventDefault(); });
  document.addEventListener('dragstart', (e) => { if (e.target.tagName === 'IMG') e.preventDefault(); });
  /* 软键盘弹出来时：面板的下沿抬到键盘上面（--kb = 键盘挡住的高度），竖屏时面板高度跟着收，输入框露在键盘上面 */
  function kbFit() {
    const vv = window.visualViewport, p = $('#fbp'); if (!vv) return;
    const a = document.activeElement, typing = p.classList.contains('on') && a && p.contains(a) && /^(TEXTAREA|INPUT)$/.test(a.tagName);
    const over = typing ? Math.max(0, Math.round(innerHeight - (vv.offsetTop + vv.height))) : 0;
    if (over) p.style.setProperty('--kb', over + 'px'); else p.style.removeProperty('--kb');
    p.classList.toggle('kbup', !!over);   // 键盘弹着：面板顶上的提示行、重讲列表先收起，给对话和输入框腾地方
    if (typing && over) setTimeout(() => { if (a.scrollIntoView) a.scrollIntoView({ block: 'nearest' }); }, 0);
  }
  if (window.visualViewport) { visualViewport.addEventListener('resize', kbFit); visualViewport.addEventListener('scroll', kbFit); }
  $('#fbp').addEventListener('focusin', () => setTimeout(kbFit, 350)); $('#fbp').addEventListener('focusout', () => setTimeout(kbFit, 60));


  /* ---------- 反馈 → 重讲 ----------
     大画面右上角的小气泡：点开打字，发到 POST /feedback（自动带题号、第几步、这一步的键名、时间）。
     每 25 秒查一次 GET /feedback：有标了 done、还没看过的，气泡上出小点；面板顶上列出“重讲”，点了放（kit/redo.js），看过小点就消失。
     放重讲时右上角多一个 ×，点它或者放完再往下走，回到原讲解他发反馈的那一步。 */
  const fbp = $('#fbp');
  const qTag = (id) => { const en = S.entries.find((x) => x.id === id); if (en) return en.year + ' · ' + en.no; const p = String(id).split('-'); return p[0] + ' · ' + p.slice(1).map((x) => +x || x).join('-'); };
  const fresh = (x) => !x.viewed && !S.fbSeen[x.file];
  function paintFb() {
    const rs = S.fb.filter((x) => x.status === 'done' && x.redo).reverse().slice(0, 6);
    $('#btnFb').classList.toggle('dot', rs.some(fresh) || !!(Kit.ask && Kit.ask.dot()));   // 小点：新做好的重讲，或问答 / 报修那边有没看的（kit/ask.js）
    $('#rds').innerHTML = rs.map((x) => `<button class="rd${fresh(x) ? ' new' : ''}" data-f="${esc(x.file)}"><svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg><b>${esc(U('ui.fb.redo'))}</b><span>${esc(qTag(x.id))}</span></button>`).join('');
  }
  async function loadFb() { if (S.quiet) return; const d = await getJSON('feedback').catch(() => null); if (Array.isArray(d)) { S.fb = d; paintFb(); } }
  $('#btnFb').onclick = () => { if (Kit.ask) Kit.ask.toggle(); };   // 面板的开关、分页、问答和报修都在 kit/ask.js；原来“发一句话 → 重讲”的入口并进了问答（“还是没懂，做成动画再讲”）
  $('#rds').addEventListener('click', (e) => { const b = e.target.closest('.rd'); if (!b) return; const x = S.fb.find((y) => y.file === b.dataset.f); if (x) { closeAll(); playRedo(x); } });
  async function playRedo(x) {
    const at = x.inRedo ? null : x.step;
    try { await open(x.id, { redo: { dir: x.redo, at, file: x.file } }); }
    catch (e) { toast(U('ui.fb.fail')); if (!S.P) tryOpen(x.id, at != null && at >= 0 ? { at } : {}); return; }
    S.fbSeen[x.file] = Date.now(); store('b2redoSeen', S.fbSeen); post('/feedback/viewed', { file: x.file }); x.viewed = x.viewed || 1; paintFb();
  }
  function leaveRedo() { const r = S.redo; if (!r) return; tryOpen(S.id, r.at != null && r.at >= 0 ? { at: r.at } : {}); }
  $('#btnRedoX').onclick = () => (S.read ? leaveRead() : leaveRedo());

  /* ---------- 薄弱点 ----------
     所有日期的答题记录（GET /records，取不到就只用本机的）加“没懂”标记，按王道小节（q.json 的 unit）一行；数学按讲次（q.json 的 topic），没有的归一组。
     每题只看最近一次：做错算“错”，点了“不会”算“不会”；“没懂”是标了几步。按 不会×3 + 错×2 + 没懂步数 排，一样按小节号。只算当前模块。
     点一行展开这一节的题，点题跳过去。每行最右一格是这一节的补练（kit/mock.js，题库 bank/mock/）：做对 / 做过几道，点了进补练；题库里没有这一节就空着。纯前端统计。 */
  const qCache = {}, uCache = {};
  const qInfo = (id) => qCache[id] || (qCache[id] = getJSON('questions/' + id + '/q.json').catch(() => null));
  /* 小节名：先用 index.json 里这一节某道题的 topic，没有再按 tools/publish.py 的 topic() 的办法从知识块 text.json 的目录里找 */
  const unitName = (u, ids) => {
    const en = S.entries.find((x) => ids.includes(x.id) && x.topic); if (en) return Promise.resolve(en.topic);
    return uCache[u] || (uCache[u] = getJSON('units/' + u + '/text.json').then((t) => {
      const num = u.split('-').slice(1).join('-'), b = t.book || {}, re = new RegExp('^\\*?\\s*' + num.replace(/\./g, '\\.') + '\\s+(.+)$');
      for (const x of [].concat(b.subs || [], b.secs || [])) { const m = String(typeof x === 'string' ? x : (x.t || x.title || x.name || '')).match(re); if (m) return m[1].trim(); }
      return '';
    }).catch(() => ''));
  };
  async function weakData() {
    const d = await getJSON('records').catch(() => null), { last, flags } = mergeRecs(d);
    const ids = [...new Set(Object.keys(last).concat(Object.keys(flags)))].filter((id) => modOf(id) === S.mod);
    const rows = {};
    await Promise.all(ids.map(async (id) => {
      const r = (last[id] || {}).r || {}, skip = !!r.skip, wrong = !skip && r.correct === false, nf = (flags[id] || []).length;
      if (!skip && !wrong && !nf) return;
      const q = await qInfo(id), math = modOf(id) === 'math', key = (q && (q.unit || (math ? q.topic : ''))) || '';
      const row = rows[key] = rows[key] || { key, math, qs: [], wrong: 0, skip: 0, flags: 0 };
      row.qs.push({ id, wrong, skip, nf }); row.wrong += wrong; row.skip += skip; row.flags += nf;
    }));
    const list = Object.values(rows);
    await Promise.all(list.map(async (row) => {
      row.label = !row.key ? U('ui.weak.none') : row.math ? row.key : (row.key.split('-').slice(1).join('-') + ' ' + await unitName(row.key, row.qs.map((x) => x.id))).trim();
      row.score = row.skip * 3 + row.wrong * 2 + row.flags;
      row.qs.sort((a, b) => (b.skip * 3 + b.wrong * 2 + b.nf) - (a.skip * 3 + a.wrong * 2 + a.nf) || a.id.localeCompare(b.id, 'zh', { numeric: true }));
    }));
    return list.sort((a, b) => b.score - a.score || (!a.key) - (!b.key) || a.label.localeCompare(b.label, 'zh', { numeric: true }));
  }
  const wq = (id, st, nf) => `<button class="item" data-id="${esc(id)}"><i class="dot" data-s="${st}"></i><b>${esc(qTag(id))}</b><span></span>${nf ? `<em>${nf}</em>` : ''}</button>`;
  async function openWeak() {
    closeTop(); $('#weak').classList.add('on'); scrim.classList.add('on');
    const tok = S.wkTok = (S.wkTok || 0) + 1, list = await weakData(); if (tok !== S.wkTok) return;
    S.weak = list;
    const n = (v, c) => `<b class="c ${c}">${v || ''}</b>`;
    /* 每行最右一格：这一节的补练（kit/mock.js 给：做对 / 做过几道，点了进补练）；题库里没有这一节就空着，整页都没有就不出这一列 */
    if (Kit.mock) await Kit.mock.ready(); if (tok !== S.wkTok) return;
    const mk = list.map((r) => (Kit.mock ? Kit.mock.weakCell(r) : ''));
    $('#weak').classList.toggle('hasmk', mk.some(Boolean));
    $('#wkList').innerHTML = list.length ? list.map((r, i) => `<div class="wrow" data-i="${i}"><div class="wline"><button class="wsum"><span class="wn">${esc(r.label)}</span>${n(r.wrong, 'no')}${n(r.skip, 'sk')}${n(r.flags, 'fl')}</button>${mk[i] || '<i class="wmk0"></i>'}</div>`
      + `<div class="wqs"><div>${r.qs.map((x) => wq(x.id, x.wrong ? 'no' : x.skip ? 'skip' : '', x.nf)).join('')}</div></div></div>`).join('')
      : `<p class="wempty">${esc(U('ui.weak.empty'))}</p>`;
  }
  $('#btnWeak').onclick = openWeak;
  $('#weakClose').onclick = closeTop;
  $('#wkList').addEventListener('click', (e) => {
    const it = e.target.closest('.item'); if (it) { if (it.dataset.id !== S.id || S.redo) { closeAll(); tryOpen(it.dataset.id); } else closeTop(); return; }
    const m = e.target.closest('.wmk'); if (m) { closeAll(); Kit.mock.start(m.dataset.tag); return; }
    const b = e.target.closest('.wsum'); if (!b) return;
    b.closest('.wrow').classList.toggle('open');
  });

  let toastT = 0;
  /* 转屏、改窗口大小：那一下所有过渡先停掉（html.noanim，shell.css），东西直接排到新位置，不从旧位置慢慢挪过去（以前面板开着转屏，画面要缩放滑 0.3 秒、草稿纸按钮再慢一拍）；停下来两帧以后恢复 */
  let naT = 0;
  function noAnim() { const h = document.documentElement; h.classList.add('noanim'); clearTimeout(naT); naT = setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => h.classList.remove('noanim'))), 120); }
  addEventListener('resize', noAnim);
  addEventListener('resize', () => { if (S.def) paintTag(); });   // 题号放不放得下（.tight）跟着宽度重算：以前要等 3 秒一次的轮询重画题号，转屏后左栏过一两秒又跳一下
  function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), 2200); }

  /* ---------- 今日题单：每次轮询都重读，没有文件或 list 为空就当没有 ---------- */
  async function loadToday() {
    const d = await getJSON('data/today.json').catch(() => null);
    S.today = d && Array.isArray(d.list) && d.list.length ? d : null;
    paintMods(); if (S.def) paintTag();
  }
  /* 开机时把电脑上存的记录并进来（换了设备、清了缓存也接得上） */
  async function loadRecords() {
    const [a, k, f] = await Promise.all(['data/answers/' + today() + '.json', 'data/seen.json', 'data/flags.json'].map((u) => getJSON(u).catch(() => null)));
    if (a) for (const id in a) if (a[id] && typeof a[id] === 'object') S.ans[id] = Object.assign({}, S.ans[id], a[id], { date: today() });
    if (k) for (const u in k) if (!S.known[u]) S.known[u] = k[u];
    if (f) for (const id in f) if (!S.flags[id]) S.flags[id] = f[id];
  }

  /* ---------- 新讲解推过来：自动跳过去（今日题单里的题不自动跳，按顺序走） ---------- */
  async function poll(first) {
    try {
      await loadToday();
      const data = await getJSON('data/index.json');
      const fresh = data.entries.filter((en) => !S.seen.has(en.id));
      data.entries.forEach((en) => S.seen.add(en.id));
      S.entries = data.entries;
      getJSON('data/prefs.json').then(applyPrefs).catch(() => {});
      if (first) {
        /* 地址里可以带 ?id=题号&at=第几步（从 0 数）直接停在那一步，不问答案、什么都不记；再带 still=1 关掉所有过渡，给自动截图用 */
        const q = new URLSearchParams(location.search), want = q.get('id'), at = q.get('at');
        if (q.get('still')) document.documentElement.classList.add('still');
        S.quiet = at != null;
        S.pinned = !!want;   // 地址里钉了题号：后面有新题推过来也不跳走（截图时不会拍到别的题）
        if (!S.quiet) await loadRecords();
        let ok = false;
        /* 报修换新版时重载不了脚本、整页刷新的：回到同一题同一步（kit/ask.js 存在 sessionStorage 的 b2reload） */
        let back = null; try { back = JSON.parse(sessionStorage.getItem('b2reload') || 'null'); sessionStorage.removeItem('b2reload'); } catch (e) {}
        if (back && back.id && !want) ok = await tryOpen(back.id, back.key != null ? { atKey: back.key } : {});
        if (want) ok = await tryOpen(want, Object.assign(at == null ? {} : { at: +at }, q.get('read') ? { read: true } : {})); /* 地址里点名的题号，题目文件在就打开，不要求已经排进题单；再带 read=1 直接进读题（截图用） */
        /* 有题单：停在第一道没做完的；都做完了就停在最后一道 */
        if (!ok && allL().length) ok = await enterMod(S.mem.last === 'math' ? 'math' : 'exam');   /* 有题单：进上次用的模块（第一次是 408） */
        if (!ok) { const en = data.entries[data.entries.length - 1]; if (en) ok = await tryOpen(en.id, at == null ? {} : { at: +at }); }
        if (ok) document.documentElement.dataset.ready = '1'; else $('#app').classList.add('none');
      } else {
        const push = fresh.filter((en) => !allL().includes(en.id));
        if (push.length && !S.pinned) { if (S.mock) S.pendPush = push[push.length - 1].id; else await open(push[push.length - 1].id, { fresh: true }); }   // 正在补练：先记下，退出补练时再跳过去
      }
    } catch (e) { if (first) $('#app').classList.add('none'); }
  }

  (async () => {
    try { S.ui = await getJSON('kit/ui.json'); } catch (e) {}
    applyUI(); applyPrefs(null);
    await poll(true);
    setInterval(() => poll(false), 3000);
    const slow = () => { loadFb(); if (Kit.ask) Kit.ask.poll(); };   // 25 秒一次：重讲（GET /feedback）、问答 / 报修 / 监听状态（kit/ask.js）
    if (S.quiet) $('#app').classList.add('quiet'); else { slow(); setInterval(slow, 25000); }
    post('/beacon', { page: 'board', w: innerWidth, h: innerHeight, dpr: devicePixelRatio, sw: screen.width, sh: screen.height });
  })();
  /* 给 kit/mock.js（补练）用的几样 */
  S.api = { open, tryOpen, closeAll, swipeAway, toast, getJSON, post, esc, U, T, rec, today, modOf, swapPane, nvShow, NV, scrim, paintGate, paintTag, fitRail,
    paintFb, loadFb, kbFit, qTag };   // 后面这几样给 kit/ask.js（问答、报修）
  window.Board2 = S;
})();
