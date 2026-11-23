/* kit/ask.js：大画面右上角气泡点开的面板。两个分页：
   问答（默认）：像聊天。这道题的对话记录按提问时所在的步分组（标签点了跳回那一步），下面常用问法、引用条、输入框。
     发出去 POST /ask → EventSource 连 /ask/stream 边到边显示（status 一行小状态，delta 往后接字，done 定稿带出处，error 显示失败和重试）。
     出处是小标签，点了全屏看书页图（双指或按钮放大，点图外关掉）；每条回答下面“还是没懂，做成动画再讲”（POST /ask/escalate，做好的重讲照旧出在面板最上面）；
     回答带更正（fix）的，在回答下面显示，气泡出小点直到看过。讲稿里长按一段、画面上长按高亮框，冒出“问这里”，点了带着那段原文来问。
     讲稿里问过问题的那一步旁边一个小标记，点了打开面板翻到那段对话。再进这道题 GET /ask/history 把对话填回来。
   课有问题：报修表单（类型 kind、范围 scope、说明）POST /report，自动带 env；下面这道题的报修列表（GET /reports），改好的“换成新版”（POST /report/apply 后重载这道题、回到原来那一步），
     换过的“退回上一版”（POST /report/rollback）。别的题改好了、有新回答，面板顶上一行提示，点了跳过去。
   监听状态 GET /status：watcher 不在线时气泡上一个淡淡的虚线圈、报修分页顶上一行提示；AI 也不在时问答输入框上方提示没人能答（照样能发，会排队）。
   面板：竖屏从下方升起（新讲法的题盖在讲稿上，别的题把画面往上挤），横屏靠右一栏（把画面往左挤，宽度 26%–40%）；把手拖着调高 / 宽，拖到头收起；收起后回答照样在后台收。
   界面上的字全部取 kit/ui.json 的 ui.ask.* / ui.report.*（Gemini 写）。 */
(function () {
  'use strict';
  const S = window.Board2, A = S.api, $ = (s) => document.querySelector(s);
  const { esc, U, toast, getJSON } = A;
  const stored = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const postJ = (u, body) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then((r) => (r.ok ? r.json().catch(() => ({})) : Promise.reject(new Error(u + ' ' + r.status))));
  const fbp = $('#fbp'), btn = $('#btnFb'), ta = $('#fbText');
  const KINDS = ['wrong', 'broken', 'unclear', 'slow', 'jumpy', 'other'];

  /* M[题号] = {threads}；Q 面板自己的状态。
     unseen 没看过的新回答 {thread#turn: 题号}；fixSeen 看过的更正；esc 已转重讲的对话；live 正在收的流 {key: {es, turn}} */
  const M = {};
  const Q = { tab: 'ask', cur: null, quote: null, qat: null, status: null, reports: [], rk: null, rs: 'step',
    unseen: stored('b2askNew', {}), fixSeen: stored('b2askFix', {}), esc: stored('b2askEsc', {}), live: {}, tried: new Set() };
  let LID = 0;
  const key = (th, u) => (th.thread && u.n != null ? th.thread + '#' + u.n : 'L' + (u.lid || (u.lid = ++LID)));   // 还没拿到编号的（刚发、没发出去）用本地编号
  const seenNow = () => fbp.classList.contains('on') && Q.tab === 'ask';

  /* ---------- 公式：用 kit/xin.js 的 rich（$…$ 排 KaTeX）；流式中途 $ 没配对时，最后那段先原样放着，等配上或定稿再排 ---------- */
  function rich(s, final) {
    s = String(s == null ? '' : s);
    const n = (s.match(/\$/g) || []).length;
    if (final || !(n % 2)) return Kit.xin.rich(s, true);
    const k = s.lastIndexOf('$');
    return Kit.xin.rich(s.slice(0, k), true) + `<span class="akraw">${esc(s.slice(k))}</span>`;
  }
  const glue = (el) => { if (el) Kit.xin.glue(el); };

  /* ---------- 回答排版（2026-11-22 “回答不好读”）：空行分段；1. / 1、/ - 开头的行排成列表；$$…$$ 单独一块、能横滑；```…``` 代码块；
     `代码` 等宽；**强调**；〔书名 第N页〕缩成小字，对得上出处的点了看书页；旧回答里“代码：解释”这种行，把代码那截单独排成等宽一行 ---------- */
  const katexD = (x) => { try { return katex.renderToString(x, { throwOnError: false, displayMode: true, output: 'html' }); } catch (e) { return esc(x); } };
  const CODEY = /[(){};=\[\]<>+\-*/]/;
  function inl(s, final, cs) {
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return '\u0003' + (codes.length - 1) + '\u0004'; });
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '\u0001$1\u0002');
    s = s.replace(/\$([^$\n]+)\$/g, (m, x) => (/\\frac/.test(x) && !/\\displaystyle/.test(x) ? '$\\displaystyle ' + x + '$' : m));   // 行内分数太小：按独立公式的大小排
    let h = rich(s, final);
    h = h.replace(/\u0001/g, '<strong>').replace(/\u0002/g, '</strong>');
    h = h.replace(/〔([^〔〕]{1,60}?)〕/g, (m, t) => {
      const k = /(.+?)\s*第\s*(\d+)\s*页/.exec(t), c = k && (cs || []).find((x) => x.img && (x.name === k[1].trim() || x.book === k[1].trim()) && String(x.page) === k[2]);
      return c ? `<button class="akref" data-img="${esc(c.img)}">〔${t}〕</button>` : `<span class="akref">〔${t}〕</span>`;
    });
    return h.replace(/\u0003(\d+)\u0004/g, (m, i) => `<code>${esc(codes[+i])}</code>`);
  }
  function para(t, final, cs) {
    const lines = t.split('\n').filter((x) => x.trim()); let h = '', run = [];
    const flush = () => { if (run.length) { h += `<p>${run.map((x) => inl(x, final, cs)).join('<br>')}</p>`; run = []; } };
    lines.forEach((ln) => {
      const li = /^\s*(\d{1,2}(?:[.)）](?=\s)|、)|[-•·](?=\s))\s*(.*)$/.exec(ln);   // “1.5 倍”“-x”不算列表
      if (li) { flush(); h += `<div class="akli"><span class="akn">${esc(li[1].replace(/[-•·]/, '•'))}</span><div>${inl(li[2], final, cs)}</div></div>`; return; }
      const cl = /^\s*([\x20-\x7e]{3,}?)\s*[：:]\s*(.+)$/.exec(ln);   // “for(i=0; …)：这一段……” → 代码单独一行
      if (cl && CODEY.test(cl[1]) && !cl[1].includes('$')) { flush(); h += `<div class="akcl"><code>${esc(cl[1].trim())}</code></div>`; run.push(cl[2]); flush(); return; }
      if (!/[一-鿿$]/.test(ln) && /[;{}]/.test(ln) && CODEY.test(ln)) { flush(); h += `<div class="akcl"><code>${esc(ln.trim())}</code></div>`; return; }
      run.push(ln);
    });
    flush(); return h;
  }
  function textBlocks(s, final, cs) {
    /* 流式中途 $$ 没配对：最后那段先原样放着 */
    let tail = '';
    if (!final && ((s.match(/\$\$/g) || []).length % 2)) { const k = s.lastIndexOf('$$'); tail = s.slice(k); s = s.slice(0, k); }
    let h = '', at = 0; const re = /\$\$([\s\S]+?)\$\$/g; let m;
    while ((m = re.exec(s))) { h += s.slice(at, m.index).split(/\n\s*\n/).map((p) => para(p, final, cs)).join(''); h += `<div class="akmath">${katexD(m[1].trim())}</div>`; at = re.lastIndex; }
    h += s.slice(at).split(/\n\s*\n/).map((p) => para(p, final, cs)).join('');
    return h + (tail ? `<p class="akraw">${esc(tail)}</p>` : '');
  }
  function fmt(s, final, cs) {
    s = String(s == null ? '' : s).replace(/\r/g, '');
    let h = '', at = 0; const re = /```[^\n]*\n?([\s\S]*?)(?:```|$)/g; let m;
    while ((m = re.exec(s))) { if (m[0] === '') { re.lastIndex++; continue; } h += textBlocks(s.slice(at, m.index), final, cs); h += `<pre class="akcode"><code>${esc(m[1].replace(/\n$/, ''))}</code></pre>`; at = re.lastIndex; }
    return h + textBlocks(s.slice(at), final, cs);
  }

  /* ---------- 面板开关、分页、大小 ---------- */
  const portrait = () => matchMedia('(orientation: portrait)').matches;
  const phone = () => !!(Kit.phone && Kit.phone.on());   // iPhone 竖屏（kit/phone.js）
  let size = stored('b2fbSize', { h: 0.5, w: 0.34 });
  function applySize() {
    const r = document.documentElement.style;
    let h = size.h;
    /* 竖屏的新讲法题：面板盖在讲稿上，没拖过把手时高度刚好到进度条下沿，画面和进度条都露着 */
    /* 手机竖屏的新讲法题也一样：以前固定六成屏高，面板的 × 正好压在 ▶ 上，想点下一步却把面板关了 */
    if (portrait() && S.xin && !size.userH && !fbp.classList.contains('sizing')) { const b = document.querySelector('.bar'); if (b) h = Math.max(0.3, Math.min(0.6, (innerHeight - b.getBoundingClientRect().bottom - 2) / innerHeight)); }
    else if (phone() && !size.userH && !fbp.classList.contains('sizing')) h = 0.5;   // 手机竖屏（旧式题）：默认占五成屏高，画面往上挤（kit/phone.css），◀ ▶ 和进度条露在面板上面
    r.setProperty('--fbh', (h * 100).toFixed(1) + 'dvh'); r.setProperty('--fbw', (size.w * 100).toFixed(1) + 'vw');
  }
  applySize();
  const mBig = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--m-big')) || 0;   // 面板滑完的时长（shell.css 的 --m-big；减弱动态效果时是 0），滑完再量左栏
  function openPanel(tab) {
    setTab(tab || 'ask'); applySize();
    fbp.classList.add('on'); $('#app').classList.add('akopen'); btn.classList.add('open');
    A.paintFb(); loadStatus(); render(); paintNote();
    if (S.P) setTimeout(() => A.fitRail(), mBig());
  }
  function closePanel() {
    fbp.classList.remove('on'); $('#app').classList.remove('akopen'); btn.classList.remove('open');
    if (fbp.contains(document.activeElement)) document.activeElement.blur();
    if (S.P) setTimeout(() => A.fitRail(), mBig());
  }
  /* 别处（抽屉、选题）调 closeAll 时面板也关：跟着把挤画面的那层去掉 */
  new MutationObserver(() => { if (!fbp.classList.contains('on')) { $('#app').classList.remove('akopen'); btn.classList.remove('open'); } }).observe(fbp, { attributes: true, attributeFilter: ['class'] });
  function setTab(t) {
    Q.tab = t; fbp.dataset.tab = t; paintNote();
    fbp.querySelectorAll('.fbtabs button').forEach((b) => { const on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    if (t === 'rep') { paintForm(); loadReports(S.id); } else render();
  }
  fbp.querySelector('.fbtabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
  $('#fbMin').onclick = closePanel;
  /* 把手：竖屏上下拖调高度、横屏左右拖调宽度；拖到最小再往外就收起 */
  (function grab() {
    const h = $('#fbGrab'); let d = null;
    h.addEventListener('pointerdown', (e) => { d = { p: portrait(), out: false, s: Object.assign({}, size) }; h.setPointerCapture(e.pointerId); fbp.classList.add('sizing'); e.preventDefault(); });
    h.addEventListener('pointermove', (e) => {
      if (!d) return;
      if (d.p) { const f = (innerHeight - e.clientY) / innerHeight; d.out = f < 0.2; size.h = Math.max(0.28, Math.min(phone() ? 0.94 : 0.88, f)); }
      else { const f = (innerWidth - e.clientX) / innerWidth; d.out = f < 0.18; size.w = Math.max(0.26, Math.min(0.4, f)); }
      fbp.classList.toggle('closing', d.out); applySize();
    });
    const end = () => {
      if (!d) return; const x = d; d = null; fbp.classList.remove('sizing', 'closing');
      if (x.out) { size = x.s; applySize(); closePanel(); } else { if (x.p) size.userH = true; store('b2fbSize', size); }
      if (S.P) A.fitRail();
    };
    h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
  })();

  /* ---------- 小点、顶上一行提示 ---------- */
  const doneRep = () => Q.reports.filter((r) => r.status === 'done' && !r.applied);
  function fixUnseen(id) { return ((M[id] || {}).threads || []).some((th) => th.turns.some((u) => u.fix && !Q.fixSeen[key(th, u) + '@' + u.fix.ts])); }
  function dot() { return Object.keys(Q.unseen).length > 0 || (S.id && fixUnseen(S.id)) || doneRep().length > 0; }
  /* 2026-11-22 他说“提问上方一堆重讲的条挤占了看回答的空间”：问答分页顶上最多一行（只有一件事就是那件事本身，几件就合成“有 n 条新消息”，点了去“课有问题”分页）；
     各条提醒（别的题有新回答、改好了去换新版）和做好的重讲列表（#rds，shell.js 画）都放在“课有问题”分页顶上 */
  const freshRedo = () => (S.fb || []).filter((x) => x.status === 'done' && x.redo && !x.viewed && !(S.fbSeen || {})[x.file]);
  function noteRows(all) {
    const rows = [], ids = new Set();
    Object.values(Q.unseen).forEach((id) => { if (id !== S.id && !ids.has('a' + id)) { ids.add('a' + id); rows.push({ id, tab: 'ask', t: U('ui.ask.otherNew') }); } });
    doneRep().forEach((r) => { if (!ids.has('r' + r.id) && (all || r.id !== S.id)) { ids.add('r' + r.id); rows.push({ id: r.id, tab: 'rep', t: U('ui.report.otherDone') }); } });   // 报修分页里，这道题自己的在下面列表里，不用再提示
    return rows;
  }
  const noteBtn = (x) => `<button data-id="${esc(x.id)}" data-tab="${x.tab}">${esc(String(x.t).replace('{q}', A.qTag(x.id)))}</button>`;
  function paintNote() {
    const rows = noteRows(true), rd = freshRedo(), n = rows.length + rd.length;
    $('#fbNote').innerHTML = !n ? '' : n > 1 ? `<button data-go="rep">${esc(String(U('ui.ask.notes')).replace('{n}', n))}<i>›</i></button>`
      : rows.length ? noteBtn(rows[0]) : `<button data-redo="${esc(rd[0].file)}">▶ ${esc(U('ui.fb.redo'))} · ${esc(A.qTag(rd[0].id))}</button>`;
    $('#rpNote').innerHTML = noteRows(false).map(noteBtn).join('');
  }
  const onNote = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.go) { setTab(b.dataset.go); return; }
    if (b.dataset.redo) { const r = document.querySelector(`#rds .rd[data-f="${CSS.escape(b.dataset.redo)}"]`); if (r) r.click(); return; }   // 放重讲照旧交给 shell.js
    if (b.dataset.id !== S.id) { if (!(await A.tryOpen(b.dataset.id))) return; }
    openPanel(b.dataset.tab);
  };
  $('#fbNote').addEventListener('click', onNote); $('#rpNote').addEventListener('click', onNote);
  new MutationObserver(() => paintNote()).observe($('#rds'), { childList: true });   // 重讲列表（shell.js 的 paintFb）一变，顶上那一行跟着算

  /* 放大阅读：横屏面板加宽盖住画面（左栏露着），竖屏升高到接近满屏；再点缩回。记在本机 */
  let wide = !!stored('b2fbWide', false);
  function paintWide() {
    fbp.classList.toggle('wide', wide); const b = $('#fbWide'); if (!b) return;
    b.classList.toggle('on', wide); b.setAttribute('aria-label', U(wide ? 'ui.ask.narrow' : 'ui.ask.wide')); b.setAttribute('aria-pressed', wide);
  }
  $('#fbWide').onclick = () => { wide = !wide; store('b2fbWide', wide); paintWide(); };
  function arrived(id, k) {
    if (id === S.id && seenNow()) return;
    Q.unseen[k] = id; store('b2askNew', Q.unseen); A.paintFb(); paintNote();
  }
  /* 面板开着、在问答分页：这道题的新回答和更正都算看过 */
  function markSeen() {
    if (!seenNow() || !S.id) return;
    let ch = false;
    Object.keys(Q.unseen).forEach((k) => { if (Q.unseen[k] === S.id) { delete Q.unseen[k]; ch = true; } });
    ((M[S.id] || {}).threads || []).forEach((th) => th.turns.forEach((u) => { if (u.fix) { const k = key(th, u) + '@' + u.fix.ts; if (!Q.fixSeen[k]) { Q.fixSeen[k] = Date.now(); ch = true; } } }));
    if (ch) { store('b2askNew', Q.unseen); store('b2askFix', Q.fixSeen); A.paintFb(); paintNote(); }
  }

  /* ---------- 监听状态 ---------- */
  async function loadStatus() {
    const d = await getJSON('status').catch(() => null); Q.status = d;
    const off = !!(d && d.watcher && d.watcher.online === false);
    btn.classList.toggle('off', off);
    $('#rpOff').hidden = !off;
    $('#akWarn').hidden = !(off && d.cli && d.cli.ok === false);
  }

  /* ---------- 对话记录 ---------- */
  const cur = () => (M[S.id] || (M[S.id] = { threads: [] }));
  function stepIdx(th) { const P = S.P; if (!P) return -1; const k = th.stepKey != null ? P.steps.findIndex((s) => s.id === th.stepKey) : -1; return k >= 0 ? k : (th.step == null ? -1 : +th.step); }
  function stText(u) {
    const st = u.st || 'queued';
    return U(st === 'searching' ? 'ui.ask.st.searching' : st === 'answering' ? 'ui.ask.st.answering' : u.via === 'session' ? 'ui.ask.st.slow' : 'ui.ask.st.queued');
  }
  /* 出处：收成一行小标签。只有一条：点了直接看书页；几条：标签上是第一条和“+几”，点了展开全部（每条点了看那一页）。
     书名对不上资料库的（book、img 为 null）只显示书名页码 */
  const BOOK = '<svg viewBox="0 0 24 24"><path d="M5 4h9a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4zM5 16a4 4 0 0 1 4-4h9"/></svg>';
  function cites(cs) {
    if (!Array.isArray(cs) || !cs.length) return '';
    const t = (c) => `<b>${esc(c.name || c.book || '')}</b>${c.page != null ? `<small>${esc(String(U('ui.ask.page')).replace('{p}', c.page))}</small>` : ''}`;
    const one = (c) => (c.img ? `<button class="akcite" data-img="${esc(c.img)}">${t(c)}</button>` : `<span class="akcite off">${t(c)}</span>`);
    const c0 = cs[0], more = cs.length - 1;
    if (!more) return `<div class="akcites">${c0.img ? `<button class="akcite sm" data-img="${esc(c0.img)}">${BOOK}${t(c0)}</button>` : `<span class="akcite sm off">${BOOK}${t(c0)}</span>`}</div>`;
    return `<div class="akcites"><button class="akcite sm more">${BOOK}${t(c0)}<i>+${more}</i></button><div class="akcall">${cs.map(one).join('')}</div></div>`;
  }
  function bodyHTML(u) {
    let h = '';
    const final = u.state === 'done';
    if (u.a) h += `<div class="aka${final ? '' : ' live'}">${fmt(u.a, final, u.cites)}</div>`;
    if (u.state === 'sending' || (u.state === 'pending' && !u.queued)) h += `<p class="akst"><i></i>${esc(stText(u))}</p>`;
    else if (u.state === 'pending') h += `<p class="akst q">${esc(U('ui.ask.queued'))}</p>`;
    else if (u.state === 'error' || u.state === 'fail' || u.state === 'net') h += `<p class="akfail"><span>${esc(U('ui.ask.fail'))}</span><button class="akretry">${esc(U('ui.ask.retry'))}</button></p>`;
    if (final) h += cites(u.cites);
    if (u.fix && u.fix.text) h += `<div class="akfix"><b>${esc(U('ui.ask.fix'))}</b><div class="aka">${fmt(u.fix.text, true, u.fix.cites)}</div>${cites(u.fix.cites)}</div>`;
    return h;
  }
  function render() {
    const box = $('#akThreads'); if (!box) return;
    const ths = S.id ? cur().threads : [];
    const log = $('#akLog'), atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    let h = '', last = null;
    ths.forEach((th) => {
      const i = stepIdx(th), gk = th.stepKey != null ? th.stepKey : 'i' + i;
      if (gk !== last) {
        if (last !== null) h += '</div>';
        h += `<div class="akgrp" data-k="${esc(gk)}"><button class="akstep" data-i="${i}">${esc(i < 0 ? U('ui.ask.pre') : String(U('ui.ask.step')).replace('{n}', i + 1))}</button>`;
        last = gk;
      }
      const tu = th.turns, end = tu[tu.length - 1];
      h += `<div class="akth${th.thread && th.thread === Q.cur ? ' cur' : ''}" data-th="${esc(th.thread || '')}">`;
      if (th.quote) h += `<blockquote class="akqt">${rich(th.quote, true)}</blockquote>`;
      tu.forEach((u) => { h += `<div class="akturn" data-k="${esc(key(th, u))}"><p class="akq">${esc(u.q)}</p><div class="akbody">${bodyHTML(u)}</div></div>`; });
      if (th.thread && end && end.state === 'done') h += Q.esc[th.thread] || th.escalated ? `<p class="akescd">${esc(U('ui.ask.escDone'))}</p>` : `<button class="akesc" data-th="${esc(th.thread)}">${esc(U('ui.ask.esc'))}</button>`;
      if (th.thread && th.thread === Q.cur) h += `<button class="aknew">${esc(U('ui.ask.newTopic'))}</button>`;
      h += '</div>';
    });
    if (last !== null) h += '</div>';
    box.innerHTML = h || `<p class="akempty">${esc(U('ui.ask.empty'))}</p>`;
    glue(box);
    if (atEnd || render.toEnd) log.scrollTop = log.scrollHeight;
    render.toEnd = false;
    markSeen();
  }
  /* 流式时只重画那一条，一帧最多一次 */
  const dirty = new Set(); let raf = 0;
  function paintTurn(k) {
    dirty.add(k); if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0; const log = $('#akLog'), atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
      dirty.forEach((k2) => {
        const L = Q.live[k2], el = document.querySelector(`.akturn[data-k="${CSS.escape(k2)}"] .akbody`);
        if (L && el) { el.innerHTML = bodyHTML(L.turn); glue(el); }
      });
      dirty.clear(); if (atEnd) log.scrollTop = log.scrollHeight;
    });
  }
  /* 讲稿里问过问题的那几步：段落右上角一个小标记 */
  function paintMarks() {
    const xd = $('#xdoc'); xd.querySelectorAll('.xask').forEach((b) => b.remove());
    if (!S.xdoc || !S.P || !S.id) return;
    const ks = new Set(cur().threads.map((th) => th.stepKey).filter((k) => k != null));
    xd.querySelectorAll('.xp').forEach((p) => {
      const s = S.P.steps[+p.dataset.i]; if (!s || !ks.has(s.id)) return;
      const b = document.createElement('button'); b.className = 'xask'; b.dataset.k = s.id; b.setAttribute('aria-label', U('ui.ask.mark'));
      b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 5.5h14v10H11l-4 3.5v-3.5H5z"/></svg>'; p.appendChild(b);
    });
  }
  function showGroup(k) {
    openPanel('ask');
    const g = [...document.querySelectorAll('.akgrp')].find((x) => x.dataset.k === k); if (!g) return;
    g.scrollIntoView({ block: 'start' }); g.classList.remove('flash'); void g.offsetWidth; g.classList.add('flash');
  }

  /* 历史：GET /ask/history?id=。正在收流的那几条用本地的；本地刚发、还没拿到编号的留着；pending 变 done 记成新回答 */
  async function loadHist(id) {
    const d = await getJSON('ask/history?id=' + encodeURIComponent(id)).catch(() => null);
    if (!d || !Array.isArray(d.threads)) return;
    const old = M[id] ? M[id].threads : [], oldT = {};
    old.forEach((th) => th.turns.forEach((u) => { if (th.thread && u.n != null) oldT[key(th, u)] = u; }));
    const ths = d.threads.map((t) => Object.assign({}, t, { turns: (t.turns || []).map((u, n) => {
      const k = t.thread + '#' + n, L = Q.live[k]; if (L) return L.turn;
      const o = oldT[k]; u = Object.assign({}, u, { n });
      if (o && o.state !== 'done' && u.state === 'done') arrived(id, k);
      return u;
    }) }));
    const t0 = (th) => (th.turns[0] && th.turns[0].ts) || '';   // 后端新的在前；对话记录按先后排（本地刚发的接在最后，不参加排序）
    ths.sort((a, b) => (t0(a) < t0(b) ? -1 : t0(a) > t0(b) ? 1 : 0));
    old.forEach((th) => {
      const nt = th.thread && ths.find((x) => x.thread === th.thread);
      if (!th.thread) ths.push(th);
      else if (nt) th.turns.forEach((u) => { if (u.n == null) nt.turns.push(u); });
      else if (th.turns.some((u) => u.n == null || Q.live[key(th, u)])) ths.push(th);
    });
    M[id] = { threads: ths };
    /* 别的标签页 / 刷新前还没收完的：再连一次流（只试一次；连不上就当排队，等轮询） */
    ths.forEach((th) => th.turns.forEach((u) => { const k = th.thread && u.n != null ? key(th, u) : null; if (k && u.state === 'pending' && !Q.live[k] && !Q.tried.has(k)) { Q.tried.add(k); listen(id, th, u, true); } }));
    if (id === S.id) { render(); paintMarks(); }
    A.paintFb();
  }

  /* ---------- 发问、收流 ---------- */
  function listen(id, th, u, soft) {
    const k = key(th, u);
    if (Q.live[k]) Q.live[k].es.close();
    u.state = 'pending'; u.queued = false; if (!u.a || !soft) u.a = '';
    const es = new EventSource('ask/stream?thread=' + encodeURIComponent(th.thread) + '&turn=' + u.n);
    const L = Q.live[k] = { es, turn: u, id };
    const end = () => { es.close(); if (Q.live[k] === L) delete Q.live[k]; };
    const J = (e) => { try { return JSON.parse(e.data); } catch (x) { return {}; } };
    /* 从“查资料”回到“在写”：前面推过来的开场白不要；转去慢通道排队（via session）：撤掉已显示的半截，改成排队提示 */
    es.addEventListener('status', (e) => { const d = J(e); if ((d.state === 'answering' && u.st === 'searching') || (d.state === 'queued' && d.via === 'session')) u.a = ''; u.st = d.state; if (d.via) u.via = d.via; paintTurn(k); });
    es.addEventListener('delta', (e) => { u.a += J(e).text || ''; u.st = 'answering'; paintTurn(k); });
    es.addEventListener('done', (e) => {
      const d = J(e); end();
      Object.assign(u, { a: d.text != null ? d.text : u.a, cites: d.cites || [], via: d.via || u.via, state: 'done' }, d.fix ? { fix: d.fix } : {});   // 定稿用 done.text 整段替换
      if (id === S.id) render(); arrived(id, k);
    });
    es.addEventListener('error', (e) => {
      if (u.state === 'done') return;
      end();
      if (e.data) { const d = J(e); if (d.retry === false) { u.state = 'pending'; u.queued = true; } else { u.state = 'error'; u.msg = d.msg; } }
      else if (soft) { u.state = 'pending'; u.queued = true; }   // 回看时补连没连上：当成排队，等轮询
      else u.state = 'net';                                         // 断网 / 流断了（重试 = 再连同一条流）
      if (id === S.id) render();
    });
  }
  async function send(text, o) {
    o = o || {};
    text = String(text || '').trim(); const id = S.id; if (!text || !id) return;
    const P = S.P, i = P ? P.index : -1, s = P && i >= 0 ? P.steps[i] : null;
    let step = i, stepKey = s ? s.id : null;
    const quote = o.quote !== undefined ? o.quote : Q.quote, qat = o.quote !== undefined ? o.qat : Q.qat;
    if (quote && qat) { step = qat.step; stepKey = qat.stepKey; }   // 引用了讲稿的一段：算那一步问的
    const list = cur().threads;
    let th = o.th || (Q.cur ? list.find((x) => x.thread === Q.cur) : null);
    if (!o.th && (quote || (th && !Q.pick && th.stepKey !== stepKey))) th = null;   // 带了引用、或者换了一步（又没点选某段对话）：另起一段对话
    const body = { id, step: th ? th.step : step, stepKey: th ? th.stepKey : stepKey, text };
    if (th) body.thread = th.thread;
    if (!th && quote) body.quote = quote;
    if (S.gate) body.pretest = true;   // 还没作答（开讲前，包括“我先做”以后还没点“写完了”）：回答别泄露解法
    if (S.redo) body.inRedo = S.redo.dir;
    if (!th) { th = { thread: null, step: body.step, stepKey: body.stepKey, quote: body.quote || null, turns: [] }; list.push(th); }
    const u = { q: text, a: '', cites: [], state: 'sending', ts: new Date().toISOString() };
    th.turns.push(u);
    if (!o.keep) { ta.value = ''; setQuote(null); }
    render.toEnd = true; render(); paintMarks();
    try {
      const r = await postJ('ask', body);
      th.thread = r.thread; u.n = r.turn; Q.cur = r.thread;
      listen(id, th, u);
    } catch (e) { u.state = 'fail'; u.body = body; }
    if (id === S.id) { render(); paintMarks(); }
  }
  function retry(k) {
    const list = cur().threads; let th = null, u = null;
    list.forEach((t) => t.turns.forEach((x) => { if (key(t, x) === k) { th = t; u = x; } }));
    if (!u) return;
    if (th.thread && u.n != null) { listen(S.id, th, u); render(); return; }   // 断流、服务端报错（retry:true）：再连同一个 thread/turn 的流，后端接着答，不重发
    th.turns.splice(th.turns.indexOf(u), 1);                             // POST /ask 本身没发出去：同一句重发
    if (!th.thread) list.splice(list.indexOf(th), 1);
    send(u.q, { keep: true, th: th.thread ? th : null, quote: th.thread ? null : th.quote, qat: { step: th.step, stepKey: th.stepKey } });
  }
  $('#fbSend').onclick = () => send(ta.value);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(ta.value); } });
  /* 输入框上面原来那排常用问法（ui.ask.q1–q4）2026-11-22 他说没必要，去掉了，地方让给回答 */
  function setQuote(q, at) {
    Q.quote = q || null; Q.qat = q ? at || null : null;
    $('#akQbar').classList.toggle('on', !!Q.quote); $('#akQtext').textContent = Q.quote || '';
  }
  $('#akQx').onclick = () => setQuote(null);
  $('#akLog').addEventListener('click', (e) => {
    const st = e.target.closest('.akstep'); if (st) { const i = +st.dataset.i; if (S.P && !S.gate && i >= 0 && i < S.P.N) S.P.go(i, { replay: true }); return; }
    const c = e.target.closest('.akcite[data-img], .akref[data-img]'); if (c) { page(c.dataset.img); return; }
    const cm = e.target.closest('.akcite.more'); if (cm) { cm.parentNode.classList.toggle('open'); return; }
    const r = e.target.closest('.akretry'); if (r) { retry(r.closest('.akturn').dataset.k); return; }
    const x = e.target.closest('.akesc'); if (x) { escalate(x.dataset.th, x); return; }
    if (e.target.closest('.aknew')) { Q.cur = null; Q.pick = false; render(); ta.focus(); return; }
    const t = e.target.closest('.akth'); if (t && t.dataset.th && !e.target.closest('button')) { Q.cur = t.dataset.th; Q.pick = true; render(); }   // 点一段旧对话：接着它追问
  });
  async function escalate(tid, b) {
    b.disabled = true;
    try { await postJ('ask/escalate', { thread: tid }); Q.esc[tid] = Date.now(); store('b2askEsc', Q.esc); toast(U('ui.ask.escDone')); render(); setTimeout(A.loadFb, 1500); }
    catch (e) { b.disabled = false; toast(U('ui.fb.fail')); }
  }

  /* ---------- 出处的书页图：全屏看，按钮或双指放大，放大后单指拖着看，点图外关掉 ---------- */
  const pg = $('#akPg'), pin = $('#akPgIn'), pimg = $('#akPgImg'); let Z = { s: 1, x: 0, y: 0 };
  const zset = () => { pimg.style.transform = `translate(${Z.x}px, ${Z.y}px) scale(${Z.s})`; };
  function page(src) { Z = { s: 1, x: 0, y: 0 }; zset(); pimg.src = src; pg.classList.add('on'); }
  $('#akPgX').onclick = (e) => { e.stopPropagation(); pg.classList.remove('on'); };
  pg.querySelector('.akpgz').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; Z.s = Math.max(1, Math.min(5, Z.s * (b.dataset.z > 0 ? 1.5 : 1 / 1.5))); if (Z.s === 1) Z.x = Z.y = 0; zset(); });
  (function pinch() {
    const pts = new Map(); let st = null, moved = false;
    pin.addEventListener('pointerdown', (e) => { pts.set(e.pointerId, [e.clientX, e.clientY]); pin.setPointerCapture(e.pointerId); moved = false; st = snap(); });
    const snap = () => { const p = [...pts.values()]; return { p, s: Z.s, x: Z.x, y: Z.y, d: p.length > 1 ? Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) : 0 }; };
    pin.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId) || !st) return; pts.set(e.pointerId, [e.clientX, e.clientY]);
      const p = [...pts.values()];
      if (p.length > 1 && st.d) { Z.s = Math.max(1, Math.min(5, st.s * Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) / st.d)); moved = true; }
      else if (p.length === 1 && st.p.length === 1) { const dx = p[0][0] - st.p[0][0], dy = p[0][1] - st.p[0][1]; if (Math.hypot(dx, dy) > 6) moved = true; if (Z.s > 1) { Z.x = st.x + dx; Z.y = st.y + dy; } }
      zset();
    });
    const up = (e) => { pts.delete(e.pointerId); st = pts.size ? snap() : null; };
    pin.addEventListener('pointerup', up); pin.addEventListener('pointercancel', up);
    pg.addEventListener('click', (e) => { if (moved) { moved = false; return; } if (e.target === pimg || e.target.closest('.akpgz')) return; pg.classList.remove('on'); });
  })();

  /* ---------- 问这里：讲稿长按一段 / 画面上长按高亮框（约 450ms，动了 10 像素就不算），冒出一个小按钮 ---------- */
  const here = $('#akHere'); let hereQ = null, hereT = 0, ate = false;
  function showHere(x, y, q, at) {
    if (!q) return false;
    hereQ = { q, at }; here.classList.add('on');
    const w = here.offsetWidth || 100, h = here.offsetHeight || 44;
    here.style.left = Math.max(8, Math.min(innerWidth - w - 8, x - w / 2)) + 'px';
    here.style.top = Math.max(8, y - h - 18) + 'px';
    clearTimeout(hereT); hereT = setTimeout(hideHere, 4000);
    return true;
  }
  function hideHere() { here.classList.remove('on'); hereQ = null; }
  here.addEventListener('click', () => {
    const h = hereQ; hideHere(); if (!h) return;
    openPanel('ask'); setQuote(h.q, h.at); Q.cur = null; Q.pick = false; render(); setTimeout(() => ta.focus(), 60);
  });
  document.addEventListener('pointerdown', (e) => { ate = false; if (here.classList.contains('on') && !e.target.closest('#akHere')) hideHere(); }, true);
  /* 长按之后的那一下 click 不当成“点讲稿跳步”；讲稿上的小标记点了翻到那段对话 */
  document.addEventListener('click', (e) => {
    if (ate && e.target.closest && e.target.closest('#xdoc')) { ate = false; e.stopPropagation(); e.preventDefault(); return; }
    const m = e.target.closest && e.target.closest('.xask'); if (m) { e.stopPropagation(); showGroup(m.dataset.k); }
  }, true);
  const plain = (s) => (String(s).startsWith('‹') ? '' : String(s));
  function quoteOf(i) {
    const P = S.P, s = P && P.steps[i]; if (!s) return '';
    const x = s.x || {};
    if (x.stem) return x.stem;
    if (x.from) { const j = S.xdoc && S.xdoc.byId ? S.xdoc.byId[x.from] : -1, y = j != null && j >= 0 ? P.steps[j].x || {} : {}; if (y.stem) return y.stem; }
    return plain(A.T('steps.' + s.id + '.h')) || plain(A.T('steps.' + s.id + '.cap'));
  }
  (function xdocPress() {
    const xd = $('#xdoc'); let lp = null;
    const clear = () => { if (lp) clearTimeout(lp.t); lp = null; };
    xd.addEventListener('pointerdown', (e) => {
      clear(); if (e.button || !S.P || !S.xdoc || S.gate) return;
      const p = e.target.closest('.xp'); if (!p || e.target.closest('button, a')) return;
      const x0 = e.clientX, y0 = e.clientY, i = +p.dataset.i;
      lp = { x0, y0, t: setTimeout(() => {
        const s = S.P.steps[i], q = plain(A.T('steps.' + (s && s.id) + '.p')) || (p.querySelector('.xtx') || p).textContent.trim();
        if (showHere(x0, y0, q, { step: i, stepKey: s ? s.id : null })) ate = true; lp = null;
      }, 450) };
    });
    xd.addEventListener('pointermove', (e) => { if (lp && Math.hypot(e.clientX - lp.x0, e.clientY - lp.y0) > 10) clear(); });
    xd.addEventListener('pointerup', clear); xd.addEventListener('pointercancel', clear); xd.addEventListener('scroll', clear, { passive: true });
  })();
  /* 画面上长按：shell.js 的手势里调。手指下面有没有亮着的橙色框（读题框、书页框、圈出来的地方）；有就冒“问这里”，返回 true */
  const ACC = [224, 138, 105];
  const ACC2 = [184, 90, 51];   // 白天那一套的橙（kit/theme.js 把 Kit.C.acc 换成 #b85a33）
  const isAcc = (el) => { const c = String(el.getAttribute('stroke') || getComputedStyle(el).stroke || ''); if (/^#(e08a69|b85a33)$/i.test(c)) return true; const m = c.match(/\d+/g); return !!m && m.length >= 3 && [ACC, ACC2].some((A) => A.every((v, k) => Math.abs(+m[k] - v) < 4)); };
  const shown = (el, root) => { let o = 1; for (let e = el; e && e !== root; e = e.parentNode) { const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none') return 0; o *= +cs.opacity; } return o; };
  function pressStage(x, y) {
    const svg = $('#stage svg'); if (!svg || !S.P || S.P.index < 0) return false;
    const hit = [...svg.querySelectorAll('rect, path, ellipse, circle, polygon')].some((el) => {
      const f = (el.getAttribute('fill') || getComputedStyle(el).fill || '').trim();
      if (!(f === 'none' || f === 'transparent' || /rgba\(.*,\s*0\)/.test(f)) || !isAcc(el)) return false;
      const r = el.getBoundingClientRect(); if (r.width < 8 && r.height < 8) return false;
      return x >= r.left - 14 && x <= r.right + 14 && y >= r.top - 14 && y <= r.bottom + 14 && shown(el, svg) > 0.3;
    });
    if (!hit) return false;
    const i = S.P.index, s = S.P.steps[i];
    return showHere(x, y, quoteOf(i), { step: i, stepKey: s ? s.id : null });
  }

  /* ---------- 课有问题 ---------- */
  function paintForm() {
    $('#rpKind').innerHTML = KINDS.map((k) => `<button data-k="${k}" class="${Q.rk === k ? 'on' : ''}">${esc(U('ui.report.k.' + k))}</button>`).join('');
    $('#rpScope').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.s === Q.rs));
    $('#rpText').setAttribute('placeholder', U(Q.rk === 'other' ? 'ui.report.phOther' : 'ui.report.ph'));
    $('#rpSend').disabled = !Q.rk;
  }
  $('#rpKind').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { Q.rk = b.dataset.k; paintForm(); } });
  $('#rpScope').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { Q.rs = b.dataset.s; paintForm(); } });
  /* 现在各个 kit 文件的版本号（index.html 里 ?v=） */
  const kitVer = () => { const o = []; document.querySelectorAll('script[src*="kit/"], link[href*="kit/"]').forEach((el) => { const u = el.getAttribute('src') || el.getAttribute('href'), m = u.match(/kit\/([^?]+)(?:\?v=([^&]+))?/); if (m) o.push(m[1] + '=' + (m[2] || '')); }); return o.join(' '); };   // 后端只收字符串：shell.js=32 ask.js=1 …
  $('#rpSend').onclick = async () => {
    const text = $('#rpText').value.trim(); if (!Q.rk || !S.id) return;
    if (Q.rk === 'other' && !text) { toast(U('ui.report.need')); $('#rpText').focus(); return; }
    const P = S.P, i = P ? P.index : -1, s = P && i >= 0 ? P.steps[i] : null;
    const env = { w: innerWidth, h: innerHeight, orient: innerWidth >= innerHeight ? 'landscape' : 'portrait', dpr: devicePixelRatio, scrollTop: Math.round($('#xdoc').scrollTop || 0), ua: navigator.userAgent, ver: kitVer() };   // scrollTop 是讲稿栏滚到哪
    const body = { id: S.id, step: i, stepKey: s ? s.id : null, kind: Q.rk, scope: Q.rs, text, env };
    $('#rpSend').disabled = true;
    try { await postJ('report', body); $('#rpText').value = ''; Q.rk = null; toast(U('ui.report.sent')); loadReports(S.id); }
    catch (e) { toast(U('ui.fb.fail')); }
    paintForm();
  };
  async function loadReports(id) {
    const d = await getJSON('reports' + (id ? '?id=' + encodeURIComponent(id) : '')).catch(() => null);
    if (d && Array.isArray(d.reports)) {
      if (id) Q.reports = Q.reports.filter((r) => r.id !== id).concat(d.reports); else Q.reports = d.reports;
      paintReps(); A.paintFb(); paintNote();
    }
  }
  const hm = (ts) => { const m = String(ts || '').match(/(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/); return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : ''; };
  function paintReps() {
    const rs = Q.reports.filter((r) => r.id === S.id).slice().reverse();
    $('#rpList').innerHTML = rs.length ? rs.map((r) => {
      const st = r.rolledBack ? 'rolled' : r.applied ? 'applied' : r.status, i = r.stepKey != null && S.P ? S.P.steps.findIndex((s) => s.id === r.stepKey) : -1, n = i >= 0 ? i : r.step;
      const where = r.scope === 'whole' ? U('ui.report.scope.whole') : n != null && n >= 0 ? String(U('ui.ask.step')).replace('{n}', +n + 1) : U('ui.ask.pre');
      const act = r.status === 'done' && !r.applied ? `<button class="rpa go" data-a="apply">${esc(U('ui.report.apply'))}</button>` : r.applied && r.canRollback ? `<button class="rpa" data-a="rollback">${esc(U('ui.report.rollback'))}</button>` : '';
      return `<div class="rpr" data-f="${esc(r.file)}" data-st="${esc(st)}"><div class="rph"><b>${esc(U('ui.report.k.' + r.kind))}</b><span>${esc(where)}</span><time>${esc(hm(r.ts))}</time><i class="rpst">${esc(U('ui.report.st.' + st))}</i></div>`
        + (r.text ? `<p class="rpt">${esc(r.text)}</p>` : '') + (r.note ? `<p class="rpn">${esc(r.note)}</p>` : '') + (act ? `<div class="rpacts">${act}</div>` : '') + '</div>';
    }).join('') : `<p class="akempty">${esc(U('ui.report.none'))}</p>`;
  }
  /* 退回上一版：第一次点只变成“再点一次”的确认样子，4 秒不点或点了别处就复原；第二次点才真退回 */
  let sureT = 0;
  const unsure = () => { clearTimeout(sureT); fbp.querySelectorAll('.rpa.sure').forEach((x) => { x.classList.remove('sure'); x.textContent = U('ui.report.rollback'); }); };
  document.addEventListener('pointerdown', (e) => { if (!(e.target.closest && e.target.closest('.rpa.sure'))) unsure(); }, true);
  $('#rpList').addEventListener('click', async (e) => {
    const b = e.target.closest('.rpa'); if (!b) return; const f = b.closest('.rpr').dataset.f, a = b.dataset.a;
    if (a === 'rollback' && !b.classList.contains('sure')) { unsure(); b.classList.add('sure'); b.textContent = U('ui.report.rollbackSure'); sureT = setTimeout(unsure, 4000); return; }
    unsure(); b.disabled = true;
    try { await postJ('report/' + a, { file: f }); } catch (x) { b.disabled = false; toast(U('ui.fb.fail')); return; }
    const r = Q.reports.find((x) => x.file === f); if (r) { if (a === 'apply') r.applied = true; else { r.rolledBack = true; r.canRollback = false; } }
    await reload(a === 'apply' ? 'ui.report.applied' : 'ui.report.rolled');
    loadReports(S.id);
  });
  /* 换新版 / 退回以后重载这道题：题目、讲稿、知识块的 json 都带时间戳重取，unit.js、big.js 去掉登记再载一次；按步骤键名回到原来那一步。重载失败就整页刷新，靠 sessionStorage 回到同一题同一步 */
  async function reload(msg) {
    const id = S.id, P = S.P, at = P && !S.gate && P.index >= 0 ? P.steps[P.index].id : null, keepTab = fbp.classList.contains('on') ? Q.tab : null;
    if (S.q && S.q.unit && Kit.units) delete Kit.units[S.q.unit];
    if (Kit.big && Kit.big.defs) delete Kit.big.defs[id];
    try { await A.open(id, at != null ? { atKey: at } : {}); toast(U(msg)); if (keepTab) openPanel(keepTab); }
    catch (e) { try { sessionStorage.setItem('b2reload', JSON.stringify({ id, key: at })); } catch (x) {} location.reload(); }
  }

  /* ---------- 外壳调的几样 ---------- */
  function onOpen(id) {
    Q.cur = null; Q.pick = false; setQuote(null); hideHere(); applySize(); render(); paintMarks(); loadHist(id);
    if (fbp.classList.contains('on') && Q.tab === 'rep') { paintForm(); loadReports(id); } else paintReps();
  }
  function poll() {
    loadStatus(); loadReports(null);
    const pend = S.id && cur().threads.some((th) => th.turns.some((u) => u.state === 'pending' && !Q.live[key(th, u)]));
    if (pend) loadHist(S.id);
  }
  /* 有排着队的回答时，面板开着就 8 秒看一次 */
  setInterval(() => { if (!S.id || S.quiet) return; const pend = cur().threads.some((th) => th.turns.some((u) => u.state === 'pending' && u.queued && !Q.live[key(th, u)])); if (pend && fbp.classList.contains('on')) loadHist(S.id); }, 8000);
  addEventListener('resize', () => { applySize(); if (fbp.classList.contains('on') && S.P) A.fitRail(); });
  setTab('ask'); setQuote(null); $('#rpOff').hidden = true; $('#akWarn').hidden = true; paintWide();
  /* ui.json 是异步取的：取到以后（shell 的 applyUI 之后）把这里自己拼的字重画一遍 */
  const uiWait = setInterval(() => { if (S.ui && S.ui.ui) { clearInterval(uiWait); paintForm(); render(); paintReps(); paintNote(); paintWide(); } }, 200);

  Kit.ask = { onOpen, poll, dot, toggle() { if (fbp.classList.contains('on')) closePanel(); else openPanel(); }, open: openPanel, close: closePanel, pressStage, send, M, Q, reload, paintMarks };
})();
