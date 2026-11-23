/* kit/big.js：综合题（408 第 41–47 题）的一页讲解。
   题目在 questions/<年>-<题号>/：q.json 写 type: "big"、unit（考的知识块）、parts（小问的编号）；
   big.js 写每一小问的解答画面，用 Kit.big.define('<题号>', { setup, parts: {'1': fn, …}, answer }) 登记。
   外壳读到 type: "big" 就调 Kit.big.lesson(K, q, unit) 拼页：
     where（书里哪一块）→ 知识块自己的步骤 → exams（真题怎么考，书上有考点追踪才有）→ 第 1）小问 → 第 2）小问 … → answer（整道题的结论汇总）
   进度条上每个小问一段，段名就是题目自己的编号（q.json 的 parts[].label，原卷照抄）。
   这里还放综合题常用的三样画法，以后的题直接拿来用：
     calc  算式行：KaTeX 排的式子一行一行出现，里面的数字从画面上它的来源处飞进来
     table 表格：按数据画，能框一行或一格、能改一格的值（旧值翻走、新值翻进来）
     code  代码块：等宽字，能逐行高亮、在行旁边标变量的当前值
   所有画面状态只由时间线决定；不带任何给人看的字（字从 K.T 取，或是题目自己的数据）。 */
(function () {
  'use strict';
  const E = Kit.E, C = Kit.C, fx = Kit.fx, D = Kit.draw, tx = D.text;
  const hide0 = (els) => gsap.set(els, { autoAlpha: 0 });
  const put = (t, el, v, pos) => t.to(el, Object.assign({ duration: 0.01 }, v), pos);   // 时间线上“瞬间改成”：不用 set，倒着拖也对
  const KX = { throwOnError: false, trust: true, strict: false, output: 'html' };
  const warn = (...a) => { (big.warnings = big.warnings || []).push(a.join(' ')); console.warn('[big]', ...a); };
  const div = (cls, parent) => { const d = document.createElement('div'); if (cls) d.className = cls; if (parent) parent.appendChild(d); return d; };
  const find = (s, sub, n) => { let i = -1; for (let k = 0; k < (n || 1); k++) { i = s.indexOf(sub, i + 1); if (i < 0) return -1; } return i; };

  /* 画面上某个 SVG 元素的中心，换成整张画布（1000 × 720）的坐标 */
  function svgPt(K, el) {
    if (!el.getBBox) return el;   // 本来就是 {x, y}
    const b = el.getBBox(), m = el.getCTM(), r = K.svg.getCTM(); if (!m || !r) return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const p = K.svg.createSVGPoint(); p.x = b.x + b.width / 2; p.y = b.y + b.height / 2;
    const q = p.matrixTransform(r.inverse().multiply(m)); return { x: q.x, y: q.y };
  }

  /* ================= 算式行 =================
     cfg：x, y, w, h 放式子的区域；fs 字号（默认 22）；gap 自动往下排时行距（默认 10）。
     c.line(tex, o) 先排好一行（藏着），返回 L：
       o.from [{tex, n, at}]：tex 里的这一段（第 n 个）从 at 飞进来；at 是画面上的元素或 {x, y}（画布坐标）。
         同一个子串出现好几次、不好数第几个时，直接给它在 tex 里的下标 i（tex 照旧写，用来知道有多长）
       o.mark ['子串' 或 {tex, n}]：能框起来的几段（L.mark(t, i, pos)）
       o.y 指定这一行的上沿（相对区域；不写就接着上一行往下排）；o.x 左边缩进；o.size 字号；o.color 颜色
     L.show(t, pos) 出现：别的字从左往右淡入，from 的几段从来源处飞进来，返回演完的时刻；
     L.mark(t, i, pos) / L.unmark(t, i, pos) 框 / 收框；L.dim(t, pos, v) 压暗；L.pt(i) 第 i 个 from 段在画布上的中心（给下一行当来源）。 */
  function calc(K, parent, cfg) {
    const fs = cfg.fs || 22, gap = cfg.gap == null ? 10 : cfg.gap;
    /* 盖满整张画布的 foreignObject（字从区域外飞进来时不能被裁掉），不接点击；式子排在里面 cfg 那一块 */
    const fo = E('foreignObject', { x: 0, y: 0, width: Kit.W, height: Kit.H, class: 'bkfo' }, parent);
    const root = div('bkcalc'); root.style.cssText = `width:${Kit.W}px;height:${Kit.H}px`; fo.appendChild(root);
    const area = div('bkarea', root); area.style.cssText = `left:${cfg.x}px;top:${cfg.y}px;width:${cfg.w}px;height:${cfg.h}px;font-size:${fs}px`;
    const kk = () => root.getBoundingClientRect().width / root.offsetWidth || 1;
    const rel = (el) => { const r = el.getBoundingClientRect(), c = root.getBoundingClientRect(), k = kk(); return { x: (r.left - c.left) / k, y: (r.top - c.top) / k, w: r.width / k, h: r.height / k }; };   // 画布坐标
    let nextY = 0;
    function line(s, o) {
      o = o || {};
      const ws = [], fromL = (o.from || []).map((f) => (typeof f === 'string' ? { tex: f } : f)), markL = (o.mark || []).map((m) => (typeof m === 'string' ? { tex: m } : m));
      fromL.forEach((f, i) => { const at = f.i != null ? f.i : find(s, f.tex, f.n); if (at < 0) warn('from 找不到：', f.tex, '在', s); else ws.push({ s: at, e: at + f.tex.length, c: 'bkfly bkf' + i }); });
      markL.forEach((m, i) => { const at = m.i != null ? m.i : find(s, m.tex, m.n); if (at < 0) warn('mark 找不到：', m.tex, '在', s); else ws.push({ s: at, e: at + m.tex.length, c: 'bkmk bkm' + i }); });
      const d = div('bkline', area), y = o.y != null ? o.y : nextY;
      d.style.top = y + 'px'; d.style.left = (o.x || 0) + 'px';
      if (o.size) d.style.fontSize = o.size + 'px';
      if (o.color) d.style.color = o.color;
      d.innerHTML = katex.renderToString(Kit.math.wrapTex(s, ws), KX);
      if (d.querySelector('.katex-error')) warn('公式渲染出错', s);
      nextY = y + d.offsetHeight + gap;
      const flies = fromL.map((f, i) => {
        const el = d.querySelector('.bkf' + i); if (!el) return null;
        const r = rel(el), c = { x: r.x + r.w / 2, y: r.y + r.h / 2 }, S = f.at ? svgPt(K, f.at) : c;
        gsap.set(el, { x: S.x - c.x, y: S.y - c.y, color: C.acc });
        return { el, c };
      });
      const flyEls = flies.filter(Boolean).map((f) => f.el);
      const leaves = [...d.querySelectorAll('.katex-html *')].filter((e) => {
        if (flyEls.some((f) => f.contains(e))) return false;
        if (e.closest('svg') && e.tagName.toLowerCase() !== 'svg') return false;
        if (e.tagName.toLowerCase() === 'svg' || e.matches('.frac-line,.overline-line,.underline-line,.hline,.rule')) return true;
        return !e.children.length && !!(e.textContent || '').trim();
      });
      const boxes = markL.map((m, i) => {
        const el = d.querySelector('.bkm' + i); if (!el) return null;
        const r = rel(el), b = div('bkbox', root);
        gsap.set(b, { autoAlpha: 0, left: r.x - 5, top: r.y - 3, width: r.w + 10, height: r.h + 6 });
        return { el, b, r };
      });
      gsap.set(d, { autoAlpha: 0 });
      const L = {
        el: d,
        show(t, pos) {
          put(t, d, { autoAlpha: 1 }, pos);
          const n = leaves.length, st = Math.min(0.035, 0.6 / Math.max(1, n));
          if (n) t.fromTo(leaves, { opacity: 0 }, { opacity: 1, duration: 0.25, stagger: st, ease: 'power1.out' }, pos);
          let end = pos + n * st + 0.25;
          flies.forEach((f, i) => {
            if (!f) return;
            const p = pos + 0.1 + i * 0.22;
            t.to(f.el, { x: 0, y: 0, duration: 0.7, ease: 'power3.inOut' }, p);
            t.to(f.el, { color: o.color || C.ink, duration: 0.4 }, p + 0.75);
            K.sfx(t, 'drop', p + 0.6);
            end = Math.max(end, p + 1.15);
          });
          return end;
        },
        mark(t, i, pos) {
          const m = boxes[i]; if (!m) return;
          const o2 = 10;
          t.fromTo(m.b, { autoAlpha: 0, left: m.r.x - 5 - o2, top: m.r.y - 3 - o2, width: m.r.w + 10 + 2 * o2, height: m.r.h + 6 + 2 * o2 },
            { autoAlpha: 1, left: m.r.x - 5, top: m.r.y - 3, width: m.r.w + 10, height: m.r.h + 6, duration: 0.4, ease: 'power3.out' }, pos);
          K.sfx(t, 'blip', pos);
        },
        unmark(t, i, pos) { const m = boxes[i]; if (m) fx.hide(t, m.b, pos); },
        dim(t, pos, v) { t.to(d, { opacity: v == null ? 0.45 : v, duration: 0.3 }, pos); },
        pt(i) { const f = flies[i]; return f ? f.c : null; },
        markPt(i) { const m = boxes[i]; return m ? { x: m.r.x + m.r.w / 2, y: m.r.y + m.r.h / 2 } : null; },
        bottom: () => cfg.y + y + d.offsetHeight,
        rect: () => rel(d),
      };
      return L;
    }
    return { fo, root, line, at: (y) => { nextY = y; } };
  }

  /* ================= 表格 =================
     cfg：x, y 左上角；cols [{w, head}]（head 是表头的字，由调用的人用 K.T 取好；不要表头就不写 head 并给 hh: 0）；
       rows [[格子的值…]]（题目自己的数据，'' 是空格子）；rh 行高（默认 34）；hh 表头高（默认 32）；fs 字号（默认 18）；hfs 表头字号（默认 14）。
     T.show(t, pos) 表头和各行依次出现；T.focus(t, r, c, pos) 框住第 r 行（c 为 null）或一格，再调就移过去；T.blur(t, pos) 收框；
     T.set(t, r, c, 值, pos, {color}) 改一格：旧值往上翻走，新值从下面翻进来；T.tint(t, r, c, 颜色, pos) 格子底色；
     T.pulse(t, r, c, pos)；T.dimRow(t, r, pos, v)；T.pt(r, c) 格子中心（画布坐标，给算式行当来源）；T.el(r, c) 这一格现在的字。 */
  function table(K, parent, cfg) {
    const rh = cfg.rh || 34, hh = cfg.hh == null ? 32 : cfg.hh, fs = cfg.fs || 18, hfs = cfg.hfs || 14;
    const g = E('g', null, parent), xs = [];
    let x = cfg.x; cfg.cols.forEach((c) => { xs.push(x); x += c.w; });
    const W = x - cfg.x, head = E('g', null, g);
    if (hh) cfg.cols.forEach((c, j) => {
      E('rect', { x: xs[j], y: cfg.y, width: c.w, height: hh, fill: C.surface2, stroke: C.line }, head);
      tx(head, xs[j] + c.w / 2, cfg.y + hh / 2 + hfs * 0.36, hfs, C.muted, c.head || '', { 'text-anchor': 'middle' });
    });
    const rowG = [], cells = [];
    const mk = (parent2, cx, cy, v, color) => tx(parent2, cx, cy + fs * 0.36, fs, color || C.ink, String(v), { 'text-anchor': 'middle', class: cfg.mono === false ? '' : 'mono', 'font-weight': 700 });
    cfg.rows.forEach((row, r) => {
      const rg = E('g', null, g), y = cfg.y + hh + r * rh;
      cells.push(row.map((v, j) => {
        const w = cfg.cols[j].w, bg = E('rect', { x: xs[j], y, width: w, height: rh, fill: C.surface, stroke: C.line }, rg);
        const el = mk(rg, xs[j] + w / 2, y + rh / 2, v);
        return { x: xs[j], y, w, h: rh, cx: xs[j] + w / 2, cy: y + rh / 2, bg, el, rg };
      }));
      rowG.push(rg);
    });
    const frame = E('rect', { x: cfg.x, y: cfg.y + hh, width: W, height: rh, rx: 4, fill: 'none', stroke: C.acc, 'stroke-width': 2.6, 'pointer-events': 'none' }, g);
    hide0([head, frame].concat(rowG));
    let frameOn = false;   // 建时间线时按步骤顺序记的：框现在是不是露着
    const box = (r, c) => (c == null ? { x: cfg.x, y: cells[r][0].y, w: W, h: rh } : { x: cells[r][c].x, y: cells[r][c].y, w: cells[r][c].w, h: rh });
    const T = {
      g, head, rows: rowG, cells, frame, w: W, bottom: cfg.y + hh + cfg.rows.length * rh,
      pt: (r, c) => ({ x: cells[r][c].cx, y: cells[r][c].cy }),
      el: (r, c) => cells[r][c].el,
      show(t, pos, st) { fx.show(t, head, pos); rowG.forEach((rg, i) => fx.show(t, rg, pos + 0.15 + i * (st == null ? 0.12 : st))); return pos + 0.4 + rowG.length * (st == null ? 0.12 : st); },
      focus(t, r, c, pos) {
        const b = box(r, c);
        if (!frameOn) { put(t, frame, { attr: { x: b.x, y: b.y, width: b.w, height: b.h } }, pos); fx.frameIn(t, frame, b, pos); t.to(frame, { autoAlpha: 1, duration: 0.2 }, pos); frameOn = true; }
        else fx.rect(t, frame, b, pos, 0.4);
        K.sfx(t, 'blip', pos);
      },
      blur(t, pos) { if (frameOn) { fx.hide(t, frame, pos); frameOn = false; } },
      set(t, r, c, v, pos, o) {
        o = o || {};
        const cl = cells[r][c], nw = mk(cl.rg, cl.cx, cl.cy, v, o.color || C.acc);
        gsap.set(nw, { autoAlpha: 0, y: 10 });
        fx.flip(t, cl.el, nw, pos); fx.pulse(t, cl.bg, pos + 0.2, 1.04);
        K.sfx(t, 'drop', pos + 0.2);
        cl.el = nw; return nw;
      },
      tint(t, r, c, fill, pos) { t.to(cells[r][c].bg, { fill, duration: 0.3 }, pos); },
      pulse(t, r, c, pos) { fx.pulse(t, cells[r][c].el, pos, 1.35); },
      dimRow(t, r, pos, v) { t.to(rowG[r], { opacity: v == null ? 0.4 : v, duration: 0.3 }, pos); },
    };
    cells.flat().forEach((cl) => gsap.set([cl.el, cl.bg], { transformOrigin: '50% 50%' }));
    return T;
  }

  /* ================= 代码块 =================
     cfg：x, y, w；lines 代码的每一行（照抄官方解析，前面的空格照留）；fs 字号（默认 15）；lh 行高（默认 24）；nums 要不要行号（默认要）。
     行里 // 后面的注释用暗一点的颜色。
     Cd.hl(t, i, pos) 高亮第 i 行（从 0 数；再调就移过去）；Cd.off(t, pos) 收掉高亮；
     Cd.vars(t, i, {变量: 值, …}, pos) 在第 i 行右边标变量的当前值（和上一次标的在同一行就原地翻牌，换了行就移过去）；Cd.y(i) 第 i 行的中线。 */
  function code(K, parent, cfg) {
    const fs = cfg.fs || 15, lh = cfg.lh || 24, nums = cfg.nums !== false, X = cfg.x, Y = cfg.y, W = cfg.w, PADY = 10;
    const g = E('g', null, parent), H = cfg.lines.length * lh + 2 * PADY, TX = X + (nums ? 40 : 14);
    E('rect', { x: X, y: Y, width: W, height: H, rx: 10, fill: '#181817', stroke: C.line }, g);
    const bar = E('g', null, g);
    E('rect', { x: X + 2, y: 0, width: W - 4, height: lh, rx: 4, fill: C.accSoft }, bar);
    E('rect', { x: X + 2, y: 0, width: 3, height: lh, fill: C.acc }, bar);
    gsap.set(bar, { autoAlpha: 0, y: Y + PADY });
    const ly = (i) => Y + PADY + i * lh, lines = cfg.lines.map((s, i) => {
      if (nums) tx(g, X + 28, ly(i) + lh / 2 + fs * 0.34, fs - 2, C.faint, String(i + 1), { 'text-anchor': 'end', class: 'mono' });
      const t = tx(g, TX, ly(i) + lh / 2 + fs * 0.34, fs, C.ink2, null, { class: 'mono', style: 'white-space:pre' });
      const k = s.indexOf('//');
      E('tspan', null, t, k < 0 ? s : s.slice(0, k));
      if (k >= 0) E('tspan', { fill: C.faint }, t, s.slice(k));
      return t;
    });
    hide0(g);
    let barOn = false, tag = null;
    const Cd = {
      g, h: H, y: (i) => ly(i) + lh / 2, lines,
      show(t, pos) { fx.show(t, g, pos, 0.4); return pos + 0.4; },
      hl(t, i, pos) {
        if (!barOn) { put(t, bar, { y: ly(i) }, pos); t.to(bar, { autoAlpha: 1, duration: 0.2 }, pos); barOn = true; }
        else t.to(bar, { y: ly(i), duration: 0.35, ease: 'power3.inOut' }, pos);
        t.to(lines[i], { fill: C.ink, duration: 0.2 }, pos + 0.1);
        K.sfx(t, 'blip', pos);
      },
      off(t, pos) { if (barOn) { fx.hide(t, bar, pos); barOn = false; } },
      vars(t, i, vals, pos) {
        const s = Object.keys(vals).map((k) => k + '=' + vals[k]).join('  ');
        const tg = E('g', null, g), te = tx(tg, 0, 0, fs - 1, C.acc, s, { class: 'mono', 'font-weight': 700, 'text-anchor': 'end' });
        const w = te.getComputedTextLength() + 18, rx = X + W - 10;
        tg.insertBefore(E('rect', { x: rx - w, y: ly(i) + 2, width: w, height: lh - 4, rx: (lh - 4) / 2, fill: C.bg, stroke: C.acc, 'stroke-width': 1.2 }), te);
        te.setAttribute('x', rx - 9); te.setAttribute('y', ly(i) + lh / 2 + fs * 0.32);
        gsap.set(tg, { autoAlpha: 0, y: 8 });
        if (tag && tag.i === i) fx.flip(t, tag.g, tg, pos);
        else { if (tag) fx.hide(t, tag.g, pos); t.to(tg, { autoAlpha: 1, y: 0, duration: 0.3, ease: 'back.out(2)' }, pos + 0.15); }
        tag = { g: tg, i };
        return tg;
      },
    };
    return Cd;
  }

  /* ================= 拼成一页 ================= */
  const defs = {};
  function define(id, def) { defs[id] = def; }

  /* P：交给题目的 big.js。g 是题目自己的一层；U 是知识块 build 交出来的东西（流程图之类）；stepFn(id, part, fn) 决定小问的一步怎么上时间线 */
  function parts(K, q, hooks, layer, stepFn) {
    const def = defs[q.id]; if (!def) throw new Error('综合题没登记：' + q.id);
    const P = {
      q, U: hooks, g: layer, T: K.T, K,
      calc: (parent, cfg) => calc(K, parent, cfg), table: (parent, cfg) => table(K, parent, cfg), code: (parent, cfg) => code(K, parent, cfg),
      pt: (el) => svgPt(K, el), put,
      /* 小问里的一步：step(id, (t, p0) => {...})，p0 是这一步可以开始动的时刻（第一步要先切画面，所以晚一点） */
      step(id, fn) { stepFn(id, P.part, fn); },
    };
    if (def.setup) Object.assign(P, def.setup(K, P) || {});
    (q.parts || []).forEach((pt) => {
      const f = def.parts && def.parts[pt.id];
      if (!f) { warn('小问没写解答：', pt.id); return; }
      P.part = pt.id; f(K, P);
    });
    K.step('answer', { sec: 'answer', answer: true }, (t) => { if (def.answer) def.answer(t, P); else t.to({}, { duration: 0.3 }, 0); });
    return P;
  }

  function lesson(K, q, unit) {
    if (!defs[q.id]) throw new Error('综合题没登记：' + q.id);
    const scr = [0, 1, 2].map(() => E('g', null, K.svg)); hide0(scr);
    K.view = (t, g, pos) => { scr.forEach((x) => { if (x !== g) fx.hide(t, x, pos || 0, 0.25); }); fx.show(t, g, (pos || 0) + 0.2, 0.3); };
    Kit.sections.where(K, Object.assign({ g: scr[0] }, unit.where));
    const hooks = unit.build(K, { g: scr[1] }) || {};
    if (unit.points && unit.points.length) Kit.sections.exams(K, { g: scr[2], points: unit.points, years: unit.years, row: (q.exams || {}).row || 0, year: q.year });
    const layer = E('g', null, scr[1]);
    let first = true;
    parts(K, q, hooks, layer, (id, part, fn) => {
      const isFirst = first; first = false;
      K.step(id, { sec: 'p' + part, part }, (t) => {
        let p0 = 0.1;
        if (isFirst) { if (hooks.leave) hooks.leave(t); K.view(t, scr[1]); p0 = 0.6; }
        fn(t, p0);
      });
    });
  }

  /* 新讲法（kit/xin.js）用：知识块的画面和题目的解答画面各占一层（kU、kB），各步照常交给 K.step（xin 那边临时把 K.step 换成“收起来”）。
     知识块的步骤 meta 带 scr: kU，小问的步骤带 scr: kB，切画面由 xin 管；不演“教材位置”“历年考点”两段。 */
  function collect(K, q, unit) {
    const kU = E('g', null, K.svg), kB = E('g', null, K.svg); hide0([kU, kB]);
    const step0 = K.step;
    K.step = (id, meta, fn) => step0(id, Object.assign({ scr: kU }, meta), fn);
    const hooks = (unit && unit.build ? unit.build(K, { g: kU }) : null) || {};
    K.step = (id, meta, fn) => step0(id, Object.assign({ scr: kB }, meta), fn);
    parts(K, q, hooks, kB, (id, part, fn) => K.step(id, { sec: 'p' + part, part }, (t) => fn(t, 0.1)));
    K.step = step0;
    return { kU, kB, hooks };
  }

  const big = { define, defs, lesson, collect, calc, table, code, svgPt, put, warnings: [] };
  Kit.big = big;
})();
