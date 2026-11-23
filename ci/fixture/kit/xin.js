/* kit/xin.js：新讲法（design/新讲法.md）。一道题是一条线：读题句 → 就地讲透的知识段 → 回到题句 → 解题步（标“由哪句引出”）→ 结尾知识点清单。
   题目 q.json 写 "xin": true，题目文件夹里两个文件（格式见 design/任务书_做页.md“新讲法”一节）：
     lesson.json       {steps: [...], terms: [...]}：每一步画面用什么、属于哪个知识 unit、由哪句题引出、要讲什么（say，给 Gemini 的提纲，不上画面）
     lesson.text.json  {steps: {<id>: {h, p}}, sec, units, terms, sum}：讲稿的字（Gemini 写）
   画面：每一步三选一
     read: "rdN"   原卷图 + 框 + 推近（kit/read.js 的读题画面，步骤在 read.json 里；同一句可以回头再演一次，框闪一下）
     use: "<id>"   别处做好的一步：综合题是知识块 unit.js 的步骤（k_…）和题目 big.js 的步骤（a_…、answer），数学题是 Kit.math.lesson 的步骤，
                   选择题是 Kit.sections.lesson 的步骤。用了谁，这一步的 id 就是谁（能点的地方靠 id 认步骤）；同一组里的步骤要按原来的先后用
     都不写        只有字，画面停在上一步
   文字区（Kit.xin.doc）：一篇往下长的讲稿，当前段最亮，讲过的变淡留着；点某段画面跳回那一步；术语第一次出现就地解释，之后点了再看；
     同一个 unit 在别的题讲过，默认折叠成一行，点开重看；结尾清单点条目跳回那一段。 */
(function () {
  'use strict';
  const E = Kit.E, fx = Kit.fx;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sup = (s) => esc(s).replace(/(\d)\^(\d+)/g, '$1<sup>$2</sup>');
  const BKN = { ds: '王道数据结构', co: '王道计组', cn: '王道计网', os: '王道操作系统', 'zy-gs': '张宇基础30讲高数', 'zy-xd': '张宇基础30讲线代', 'zy-gl': '张宇基础30讲概率', 'zy-jc': '张宇零基础通关讲义', 'zy-gssc': '张宇数学公式手册' };   // 书页出处按钮上的书名（同 kit/shell.js 的 bookSheet）
  const warn = (...a) => { X.warnings.push(a.join(' ')); console.warn('[xin]', ...a); };

  /* ================= 拼时间线 =================
     o：{q, unit（知识块，综合题和选择题有）, man（lesson.json）, rd（Kit.read.load 的结果，带 q；没有读题步就是 null）} */
  function build(K, o) {
    const q = o.q, man = o.man || {}, steps = man.steps || [];
    const rs = o.rd ? Kit.read.stage(K, o.rd) : null;
    if (rs) gsap.set(rs.root, { autoAlpha: 0 });
    /* 先把别处的步骤收起来（不上时间线），再按 lesson.json 的顺序一步一步放 */
    const got = {}, step0 = K.step;
    K.step = (id, meta, fn) => { got[id] = { meta: meta || {}, fn }; };
    let main = null, L = null;
    if (q.type === 'big') Kit.big.collect(K, q, o.unit);
    else {
      const before = new Set(K.svg.children);
      if (q.type === 'math') Kit.math.lesson(K, q); else L = Kit.sections.lesson(K, q, o.unit) || null;
      main = E('g', null, K.svg);
      [...K.svg.children].filter((c) => !before.has(c) && c !== main).forEach((c) => main.appendChild(c));
      gsap.set(main, { autoAlpha: 0 });
    }
    K.step = step0;
    /* 切画面：画面上只露一层（读题图 / 知识块 / 题目解答 / 整页），换层时旧的淡出、新的淡入 */
    let cur = null;
    const view = (t, el, pos) => { pos = pos || 0; if (!el || el === cur) return pos; if (cur) fx.hide(t, cur, pos, 0.25); fx.show(t, el, pos + 0.2, 0.3); cur = el; return pos + 0.5; };
    /* 选择题：sections 的几组画面（教材位置、知识块、年份表、逐项判断）都在 main 里面。知识块的步骤调 K.view 切到其中一组时，
       先把 main 这一层露出来，再在 main 里面切组（用 sections 自己的切法）；不然 main 被藏掉，整屏空白。
       inner 记着 main 里现在露的是哪一组（时间线是按步骤先后拼的，拼到哪一步就是那一刻的状态） */
    const secView = L && L.view;
    let inner = null;
    const inMain = (g) => !!(main && g && g !== main && main.contains(g));
    const innerView = (t, g, pos) => { if (g === inner) return pos; secView(t, g, pos); inner = g; return pos + 0.5; };
    K.view = (t, g, pos) => {
      if (secView && inMain(g)) { const p = view(t, main, pos); innerView(t, g, pos || 0); return p; }
      view(t, g, pos);
    };
    /* use 的那一步原来属于哪一组：跳着用（前面那步没 use、或者中间插了读题画面）时，先切到那一组，画面才接得上 */
    const homeOf = (m) => !L ? null : m.sec === 'where' ? L.scr[0] : m.sec === 'exams' ? L.scr[2] : (m.sec === 'check' || m.sec === 'answer') ? L.chk : L.scr[1];
    const seen = new Set();
    steps.forEach((s) => {
      const g = s.use ? got[s.use] : null;
      if (s.use && !g) warn('use 找不到：', s.use);
      if (s.read && !(rs && rs.has(s.read))) warn('read 找不到：', s.read);
      const id = s.use || s.id;
      if (seen.has(id)) warn('步骤 id 重复：', id); seen.add(id);
      K.step(id, Object.assign({}, g ? g.meta : {}, { sec: (g && g.meta.sec) || s.sec, xsec: s.sec || 'x', x: s }), (t) => {
        let p = 0;
        if (s.read && rs && rs.has(s.read)) { p = view(t, rs.root, 0); p = rs.play(t, s.read, p); }
        else if (g) {
          p = view(t, g.meta.scr || main, 0);
          const h = !g.meta.scr && secView ? homeOf(g.meta) : null;
          if (h) p = Math.max(p, innerView(t, h, 0));
          const sub = gsap.timeline(); g.fn(sub); t.add(sub, p); p += sub.duration(); }
        t.to({}, { duration: 0.3 }, p);
      });
    });
    const left = Object.keys(got).filter((id) => !seen.has(id));
    if (left.length) warn('没用上的步骤（画面可能接不上）：', left.join(' '));
  }

  /* ================= 文字夹公式 =================
     rich(s, math)：math 为真时 $…$ 用 KaTeX 排、外面的字照常（数字^数字排上标）；为假时只排上标。公式后紧跟的标点包进 .xpunct，再由 glue 粘到公式末尾。
     讲稿（doc）和问答面板（kit/ask.js）共用。 */
  const kx = (s) => { try { return katex.renderToString(s, { throwOnError: false, output: 'html' }); } catch (e) { return esc(s); } };
  function richX(s, math) {
    if (!math) return sup(s);
    const ps = String(s == null ? '' : s).split('$');
    return ps.map((p, k) => {
      if (!(k % 2)) return sup(p);
      const m = /^[，。、；：,.;:）)]+/.exec(ps[k + 1] || ''); if (m) ps[k + 1] = ps[k + 1].slice(m[0].length);
      return kx(p) + (m ? `<span class="xpunct">${esc(m[0])}</span>` : '');
    }).join('');
  }
  /* 公式后面紧跟的标点和公式的最后一块包成不折行的一段（同 kit/math.js 的 rail），标点不单独落到行首 */
  const glue = (root) => root.querySelectorAll('.xpunct').forEach((p) => {
    const k = p.previousElementSibling, h = k && k.classList.contains('katex') && k.querySelector('.katex-html'), last = h && h.lastElementChild;
    if (!last) return;
    const w = document.createElement('span'); w.className = 'mxglue'; last.before(w); w.append(last, p);
  });

  /* ================= 文字区 =================
     root：放讲稿的元素；ps：播放器的步骤（每步的 x 是 lesson.json 里那一步）；T：查字；o.known(unit) 这个 unit 在别的题讲过没有。
     返回 {paint(i), folded(k), open(unit)}；点击由外壳接（data-i 段落、.xw 术语、.xfold 折叠行、.xsi 清单条目）。 */
  function doc(root, ps, T, o) {
    const xs = ps.map((s) => s.x || {}), byId = {};
    xs.forEach((x, i) => { if (x.id) byId[x.id] = i; if (x.use) byId[x.use] = i; });
    const terms = ((o.man && o.man.terms) || []).map((t) => ({ k: t.k, ws: [].concat(t.w || []), at: t.at })).filter((t) => t.ws.length);
    const say = (i) => String(T('steps.' + ps[i].id + '.p'));
    /* 数学题（o.math）：讲稿、题句、术语卡、清单里的 $…$ 用 KaTeX 排，外面的字照常；术语只在 $ 外面认（rich、glue 提到外面了，问答面板也用） */
    const rich = (s) => richX(s, o.math);
    const inTex = (s) => { const r = []; if (!o.math) return r; let a = -1; for (let k = 0; k < s.length; k++) if (s[k] === '$') { if (a < 0) a = k; else { r.push([a, k]); a = -1; } } return r; };
    /* 每个术语在哪一段就地解释：写了 at 就是那一段，不然是第一段提到它的 */
    const home = {};
    terms.forEach((t) => { let i = t.at != null ? byId[t.at] : -1; if (i == null || i < 0) i = ps.findIndex((s, k) => t.ws.some((w) => say(k).includes(w))); home[t.k] = i; });
    /* 一段字里标出术语：每个术语只标这段里的第一处，长的先认 */
    function mark(s, i) {
      const hits = [], tx = inTex(s), free = (a, e) => !tx.some(([x, y]) => a <= y && e > x);
      terms.forEach((t) => t.ws.forEach((w) => { let a = s.indexOf(w); while (a >= 0 && !free(a, a + w.length)) a = s.indexOf(w, a + 1); if (a >= 0) hits.push({ a, e: a + w.length, t }); }));
      hits.sort((x, y) => x.a - y.a || (y.e - y.a) - (x.e - x.a));
      const use = [], done = new Set(); let end = -1;
      hits.forEach((h) => { if (h.a >= end && !done.has(h.t.k)) { use.push(h); done.add(h.t.k); end = h.e; } });
      let out = '', at = 0;
      use.forEach((h) => {
        out += rich(s.slice(at, h.a));
        const first = home[h.t.k] === i;
        out += `<span class="xw${first ? ' first' : ''}" data-k="${esc(h.t.k)}">${esc(s.slice(h.a, h.e))}</span>`;
        at = h.e;
      });
      return { html: out + rich(s.slice(at)), firsts: use.filter((h) => home[h.t.k] === i).map((h) => h.t.k) };
    }
    const quote = (x) => (x && x.stem ? (o.math ? rich(x.stem) : sup(x.stem)) : '');
    const qcls = (x) => (x && x.stem && /\n/.test(x.stem) ? ' xcode' : '');   // 题句含换行（代码）：等宽、保留缩进，过宽横向滑
    /* 清单条目的式子：不是 KaTeX 出错。行内排版里分式的分子分母缩成 70% 小字，里面的 \text{中文} 又没有字距，看着像报错；整条加 \displaystyle 按正常字号排（中文的字体和字距在 shell.css 的 .cjk_fallback） */
    const tex = (s) => { try { return katex.renderToString('\\displaystyle ' + s, { throwOnError: false, output: 'html' }); } catch (e) { return esc(s); } };
    /* 计组课入口（lesson.json 顶层 course: ["0401", ...]）：图标按钮，点开列课名，点一节在新标签打开计组站那一课（server.py 的 /jizu/）。课名从 /jizu-lessons 取，取不到（服务没重启）就不出 */
    const course = [].concat(o.man && o.man.course || []);
    const cbox = [];
    const cbtn = () => {
      const d = document.createElement('div'); d.className = 'xcourse'; d.hidden = true;
      d.innerHTML = `<button class="xcb" type="button"><svg viewBox="0 0 24 24"><path d="M12 6.5C10.3 5.3 8 5 4 5v13c4 0 6.3.3 8 1.5 1.7-1.2 4-1.5 8-1.5V5c-4 0-6.3.3-8 1.5zM12 6.5V19.5"/></svg><b>${course.length}</b></button><div class="xcl" hidden></div>`;
      cbox.push(d); return d;
    };
    if (course.length) fetch('jizu-lessons').then((r) => r.json()).then((L) => {
      const hit = course.filter((c) => L[c]); if (!hit.length) return;
      cbox.forEach((d) => {
        d.querySelector('b').textContent = hit.length;
        d.querySelector('.xcl').innerHTML = hit.map((c) => `<a href="jizu/lessons/${encodeURIComponent(L[c].file)}" target="_blank" rel="noopener"><i>${esc(c)}</i><span>${esc(L[c].title)}</span></a>`).join('');
        d.hidden = false;
      });
    }).catch(() => {});
    root.innerHTML = '';
    const els = [], folds = {};
    const unitOf = (k) => xs[k].unit || null;
    ps.forEach((s, i) => {
      const x = xs[i], u = unitOf(i);
      if (u && (i === 0 || unitOf(i - 1) !== u)) {   // 一个 unit 的第一段前面放折叠行（讲过的才露出来）
        const f = document.createElement('button'); f.className = 'xfold'; f.dataset.u = u; f.dataset.i = i; f.hidden = true;
        f.innerHTML = `<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg><b>${esc(T('units.' + u))}</b><span>${esc(T('ui.xin.again'))}</span>`;
        root.appendChild(f); folds[i] = f;
      }
      const el = document.createElement('div'); el.className = 'xp' + (s.x && s.x.from ? ' from' : '') + (u ? ' unit' : '') + (x.sum ? ' xend' : ''); el.dataset.i = i; el.hidden = true;
      let h = '';
      if (x.stem) h += `<blockquote class="xq${qcls(x)}">${quote(x)}</blockquote>`;
      if (x.from) { const j = byId[x.from]; h += `<blockquote class="xq xfrom${qcls(j != null ? xs[j] : null)}">${quote(j != null ? xs[j] : null) || esc(x.from)}</blockquote>`; }
      const m = mark(say(i), i);
      h += `<p class="xtx">${m.html}</p>`;
      if (x.sum) h += `<div class="xsum">${x.sum.map((it) => `<button class="xsi" data-go="${esc(it.go || '')}"><span>${o.math ? rich(T('sum.' + it.k)) : esc(T('sum.' + it.k))}</span>${it.tex ? `<span class="xf">${tex(it.tex)}</span>` : ''}</button>`).join('')}</div>`;
      h += `<div class="xdefs">${m.firsts.map((k) => `<p class="xd on" data-k="${esc(k)}">${o.math ? rich(T('terms.' + k)) : esc(T('terms.' + k))}</p>`).join('')}</div>`;
      el.innerHTML = h; if (o.math) glue(el);
      if (course.length && (i === 0 || x.sum)) el.querySelector(x.sum ? '.xsum' : '.xtx').after(cbtn());   // 入口放在题目开讲处（第一段）和结尾清单后面
      /* 书页出处（q.json 的 cites，at 里有这一步的）：段落下面一页一个小按钮，点了看那一页、框着原文（外壳 bookSheet 开） */
      const cs = (o.cites || []).map((c, k) => [c, k]).filter(([c]) => (c.at || []).includes(ps[i].id));
      if (cs.length) {
        const pg = []; cs.forEach(([c, k]) => { let g = pg.find((y) => y.b === c.b && y.p === c.p); if (!g) pg.push(g = { b: c.b, p: c.p, ks: [] }); g.ks.push(k); });
        const d = document.createElement('div'); d.className = 'xcites';
        d.innerHTML = pg.map((g) => `<button class="xcite" type="button" data-ci="${g.ks.join(',')}"><svg viewBox="0 0 24 24"><path d="M5 4h9a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4zM5 16a4 4 0 0 1 4-4h9"/></svg>${esc(BKN[g.b] || g.b)} 第 ${g.p} 页</button>`).join('');
        el.querySelector('.xtx').after(d);
      }
      root.appendChild(el); els.push(el);
    });
    const opened = new Set();
    let max = -1, curI = -1;
    /* 第 k 段属于的 unit 块：[起, 止] */
    const block = (k) => { const u = unitOf(k); if (!u) return null; let a = k, b = k; while (a > 0 && unitOf(a - 1) === u) a--; while (b < ps.length - 1 && unitOf(b + 1) === u) b++; return { u, a, b }; };
    const folded = (k) => { const B = block(k); return !!B && o.known(B.u) && !opened.has(B.u) && !(curI >= B.a && curI <= B.b); };
    function paint(i) {
      curI = i; if (i > max) max = i;
      els.forEach((el, k) => {
        const f = folded(k);
        el.hidden = k > max || f;
        el.classList.toggle('cur', k === i); el.classList.toggle('past', k < i); el.classList.toggle('ahead', k > i);
        if (k === i && el.classList.contains('from')) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }   // 解题步：引出它的那句题干亮一下
      });
      Object.keys(folds).forEach((a) => { a = +a; folds[a].hidden = !(a <= max && folded(a)); });
      seek(false);
      if (document.fonts && document.fonts.status !== 'loaded') document.fonts.ready.then(() => { if (curI === i) seek(true); });   // 字体后到会改换行、挪位置：到了再对一次
    }
    /* 数学题：一块断不开、比这一段还宽的公式缩小到放得下（KaTeX 只在 .base 之间折行，量最宽的那块）；段落宽度变了（转屏）再量一次 */
    function fitTex(el) {
      const W0 = el.clientWidth; if (!W0 || +el.dataset.fw === W0) return; el.dataset.fw = W0;
      el.querySelectorAll('.katex').forEach((k) => {
        k.style.fontSize = ''; k.classList.remove('xwide');
        const W = (k.closest('.xtx, .xq, .xd, .xsi > span') || el).clientWidth; if (!W) return;
        /* 手机竖屏（kit/phone.js）：最多缩到 8 成，再放不下就不缩了，这一块公式原地横着滑（.xwide，样式在 kit/phone.css） */
        const f0 = parseFloat(getComputedStyle(k).fontSize), lo = Kit.phone && Kit.phone.on() ? f0 * 0.8 : 0;
        for (let n = 0; n < 4; n++) {
          const wide = Math.max(0, ...[...k.querySelectorAll('.katex-html > .base, .katex-html > .mxglue')].map((b) => b.getBoundingClientRect().width));
          if (wide <= W - 2) break;
          const fs = parseFloat(getComputedStyle(k).fontSize) * (W - 2) / wide * 0.97;
          if (fs < lo) { k.style.fontSize = lo + 'px'; k.classList.add('xwide'); break; }
          k.style.fontSize = fs + 'px';
        }
      });
    }
    /* 当前段滚进视野：看不全就滚到它的上沿在讲稿高度 18% 处 */
    function seek(now) {
      if (o.math) els.forEach((el) => { if (!el.hidden) fitTex(el); });
      const c = els[curI]; if (!c || c.hidden) return;
      const top = c.offsetTop, want = Math.max(0, top - root.clientHeight * 0.18);
      if (top < root.scrollTop + 8 || top + c.offsetHeight > root.scrollTop + root.clientHeight - 8) root.scrollTo({ top: want, behavior: now || document.documentElement.classList.contains('still') || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
    return {
      paint, folded, block, seek,
      open(u) { opened.add(u); },
      /* 往下 / 往上走一步时跳过折叠着的段 */
      next(i) { let j = i + 1; while (j < ps.length && folded(j) && !(block(j).a <= i && i <= block(j).b)) j++; return j; },
      prev(i) { let j = i - 1; while (j >= 0 && folded(j) && !(block(j).a <= i && i <= block(j).b)) j--; return j; },
      byId,
    };
  }

  const X = { build, doc, rich: richX, glue, kx, warnings: [] };
  Kit.xin = X;
})();
