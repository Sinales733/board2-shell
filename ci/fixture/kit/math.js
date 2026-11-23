/* kit/math.js：数学题的一页讲解。和 408 共用播放内核（kit/player.js）和外壳（kit/shell.js），不装知识块。
   题目在 questions/m<年份>-<题库 id>/q.json，type: "math"。外壳读到它就调 Kit.math.lesson(K, q) 拼页：
     topic   这题考的是哪一讲（题库的 topic 照抄）
     s1…sN   题库 steps 一步一行：式子像板书一样往下写，前面的不擦，写不下整体上移；
             这一步最关键的那一块（q.json 每步的 mark，tex 里的一个子串）按字形的实际位置框出来；
             keep：从前面某一行"搬下来"的部分（同样是 tex 子串），新行出现时它从原来的位置滑到新位置。
     answer  答案式子放大、变绿；选择题在字母后面接上那个选项的原文（左栏的对错由外壳在这一步标）。
             详解末步就是答案（末步以 answerTex 去掉 $ 后的内容结尾）时，末步自己当答案步，不单独再写一遍。
     useSteps：详解有两种解法时只用前几步（第一种），其余留在 q.json 里不上画面。
   两种插进推导里的卡片（都可以不写，旧题照常播）：
     idea    思路（q.idea）：topic 之后、第一行推导之前的一步。卡片上先框出题干里的特征（idea.from，题干 stemTex 的子串，照抄），
             再写"看到了什么"（text.idea.see）→"所以想到什么方法"（text.idea.so）。底部那行（steps.idea.cap）说整题的路线。
     c…      定理卡（q.cards[]：{id, before, ref, why}）：在 before 那一步（"s3"，或 "answer"；末步并进答案步时写它原来的 "sN" 也行）之前插一步。
             卡片上：定理名（steps.<id>.h，也是进度条上的小标签）、定理内容（text.card.<id>.law，文字夹 $…$；写了 tex 就用 tex）、
             适用条件（text.card.<id>.cond）、
             本题为什么满足（text.card.<id>.fit，最后出、带 ✓）。下一步卡片收起，推导行照常写出。底部那行（steps.<id>.cap）说怎么用到下一步。
             卡片上的角标和行名（mx.thm / mx.idea / mx.cond / mx.fit / mx.see / mx.so）在 kit/ui.json。
   needsFigure 为真且写了 figure 的题，画面左边是图，右边是推导：
     figure.kind = "space"  Canvas 画 3D（画法取自 Math!!!!!!!/assets/m18/engine.js），手指拖着转视角；
     figure.kind = "plane"  SVG 画平面区域。每步的 fig 写这一步哪些部分出现（on）、哪些亮（lit）、哪个参数扫一遍（sweep）。
   画面上的字全部照抄：式子是题库原文，曲面名、方程是数学符号。每步底部的结论在 q.json 的 text 里（Gemini 写）。
   所有画面状态只由时间线决定；只有 3D 图的视角由手指决定。 */
(function () {
  'use strict';
  const E = Kit.E, C = Kit.C, fx = Kit.fx;
  const KX = { throwOnError: false, trust: true, strict: false, output: 'html' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tex = (s, disp) => katex.renderToString((disp ? '\\displaystyle ' : '') + s, KX);
  /* 文字里夹着 $…$ 的（题干、选项、答案）：$ 里的用 KaTeX，外面的照原样 */
  const mixed = (s, disp) => String(s || '').split('$').map((p, i) => (i % 2 ? tex(p, disp) : esc(p))).join('');
  const div = (cls, parent) => { const d = document.createElement('div'); if (cls) d.className = cls; if (parent) parent.appendChild(d); return d; };
  const warn = (...a) => { (Kit.math.warnings = Kit.math.warnings || []).push(a.join(' ')); console.warn('[math]', ...a); };

  /* 量字形之前 KaTeX 的字体必须已经到位，不然框的位置是按替代字体量的 */
  let fontsP = null;
  function ready() {
    if (!fontsP) {
      /* 字体简写（样式 + 字号 + 名字）；粗斜体的 KaTeX_Math 是 \boldsymbol 用的 */
      const fs = ['20px KaTeX_Main', 'bold 20px KaTeX_Main', 'italic 20px KaTeX_Main', 'italic bold 20px KaTeX_Main', 'italic 20px KaTeX_Math', 'italic bold 20px KaTeX_Math',
        '20px KaTeX_AMS', '20px KaTeX_Size1', '20px KaTeX_Size2', '20px KaTeX_Size3', '20px KaTeX_Size4'];
      const all = Promise.all(fs.map((f) => document.fonts.load(f, 'x∫').catch(() => null)));
      fontsP = Promise.race([all, new Promise((r) => setTimeout(r, 4000))]);
    }
    return fontsP;
  }

  /* 左栏：题干（和选择题的四个选项）用 KaTeX 排；选项按显示大小排（1/a 这样的分式在平板上才看得清） */
  function rail(q, stemEl, optsEl) {
    stemEl.innerHTML = glued(q.stemTex);
    const o = Array.isArray(q.opts) ? q.opts : [];
    optsEl.innerHTML = o.map((k, i) => `<button class="opt" data-k="${k}"><b>${k}</b><span class="t">${glued((q.optsTex || [])[i])}</span><span class="mk"></span></button>`).join('');
    /* 标点挪进公式里，和公式的最后一块包成不折行的一段 */
    [stemEl, optsEl].forEach((box) => box.querySelectorAll('.mxpunct').forEach((p) => {
      const k = p.previousElementSibling, h = k && k.classList.contains('katex') && k.querySelector('.katex-html'), last = h && h.lastElementChild;
      if (!last) return;
      const w = document.createElement('span'); w.className = 'mxglue'; last.before(w); w.append(last, p);
    }));
    /* 一整块断不开、比左栏还宽的公式（比如带上下限的积分接着分式）：缩小这一块，不出界 */
    [stemEl, optsEl].forEach((box) => box.querySelectorAll('.katex').forEach((k) => {
      const W = (k.closest('.t') || box).clientWidth; if (!W) return;
      for (let n = 0; n < 4; n++) {
        const bs = [...k.querySelectorAll('.katex-html > .base, .katex-html > .mxglue')].map((b) => b.getBoundingClientRect().width);
        const wide = k.closest('.opt') ? bs.reduce((a, b) => a + b, 0) : Math.max(0, ...bs);   // 选项里的式子不折行，量整行的宽
        if (wide <= W) break;
        k.style.fontSize = (parseFloat(getComputedStyle(k).fontSize) * W / wide * 0.97) + 'px';
      }
    }));
  }
  /* 左栏用：公式后面紧跟的标点（，。；：、）和公式粘在一起，不让标点单独落到下一行行首 */
  function glued(s, disp) {
    const ps = String(s || '').split('$');
    let out = '';
    for (let i = 0; i < ps.length; i++) {
      if (i % 2) { const m = /^[，。、；：,.;:）)]+/.exec(ps[i + 1] || ''); out += tex(ps[i], disp) + (m ? `<span class="mxpunct">${esc(m[0])}</span>` : ''); if (m) ps[i + 1] = ps[i + 1].slice(m[0].length); }
      else out += esc(ps[i]);
    }
    return out;
  }

  /* ================= tex 里的子串 → 渲染结果里的一个 span =================
     在 tex 里找到子串，用 \htmlClass{类名}{…} 包起来，渲染后就能按类名找到它的字形。 */
  function find(tx, sub, n) { let i = -1; for (let k = 0; k < (n || 1); k++) { i = tx.indexOf(sub, i + 1); if (i < 0) return -1; } return i; }
  function findAll(tx, sub) { const out = []; let i = tx.indexOf(sub); while (i >= 0) { out.push(i); i = tx.indexOf(sub, i + sub.length); } return out; }
  /* ws：[{s, e, c}]。区间要么不相交、要么一个套一个；交叉的丢掉 */
  function wrapTex(tx, ws) {
    const ok = [];
    ws.map((w, i) => Object.assign({ i }, w)).forEach((w) => {
      if (ok.some((o) => (w.s < o.s && o.s < w.e && w.e < o.e) || (o.s < w.s && w.s < o.e && o.e < w.e))) warn('标记交叉，丢掉', tx.slice(w.s, w.e)); else ok.push(w);
    });
    const len = (w) => w.e - w.s;
    let out = '';
    for (let i = 0; i <= tx.length; i++) {
      ok.filter((w) => w.e === i).sort((a, b) => len(a) - len(b) || b.i - a.i).forEach(() => { out += '}'; });
      ok.filter((w) => w.s === i).sort((a, b) => len(b) - len(a) || a.i - b.i).forEach((w) => { out += '\\htmlClass{' + w.c + '}{'; });
      if (i < tx.length) out += tx[i];
    }
    return out;
  }
  const asList = (v) => (v == null ? [] : [].concat(v)).map((x) => (typeof x === 'string' ? { tex: x } : x));

  /* ================= 字形 ================= */
  const SKIP = /\b(strut|pstrut|vlist-s|vlist-r|vlist-t2?|vlist|base|katex-html|katex|mspace)\b/;
  const LINES = '.frac-line,.overline-line,.underline-line,.hline,.hdashline,.rule';
  /* 能看见的最小单位：有字的叶子、整块 svg（根号、大括号、长等号）、分数线之类 */
  function glyphs(root) {
    const inSvg = (e) => { const s = e.parentElement && e.parentElement.closest('svg'); return !!s && root.contains(s); };   // 整页本身在画面的 svg 里，只看 root 里面的
    return [...root.querySelectorAll('*')].filter((e) => {
      if (inSvg(e)) return false;
      if (e.tagName.toLowerCase() === 'svg') return true;
      if (e.matches(LINES)) return true;
      return !e.children.length && !SKIP.test(e.className) && !!(e.textContent || '').trim();
    });
  }

  /* 一行里有好几个式子（中间隔着 \quad 以上的大空格）时：每个式子包成一个不折行的块，只在式子之间换行；放不下的整行缩小（board 里）。
     只有一个式子的行不走这条，照下面的等号处折行。返回 true 表示已处理。 */
  function exprs(html) {
    const bases = [...html.children].filter((e) => e.classList.contains('base'));
    const wideSp = (k) => k.classList.contains('mspace') && parseFloat((/margin-right:\s*([\d.]+)em/.exec(k.getAttribute('style') || '') || [0, 0])[1]) >= 0.9;
    const items = []; let depth = 0;
    bases.forEach((b) => [...b.children].forEach((k) => {
      if (k.classList.contains('strut')) return;
      if (k.classList.contains('mopen')) depth++; else if (k.classList.contains('mclose')) depth = Math.max(0, depth - 1);
      items.push({ k, b, sep: depth === 0 && wideSp(k) });
    }));
    const groups = []; let cur = [];
    items.forEach((it) => { cur.push(it); if (it.sep) { groups.push(cur); cur = []; } });
    if (cur.length) groups.push(cur);
    if (groups.length < 2) return false;
    const strut = {}; bases.forEach((b) => { strut[bases.indexOf(b)] = b.querySelector('.strut'); });
    const made = groups.map((g) => {
      const nb = document.createElement('span'); nb.className = 'base mxexp';
      const st = strut[bases.indexOf(g[0].b)]; if (st) nb.appendChild(st.cloneNode(true));
      g.forEach((it) => nb.appendChild(it.k)); return nb;
    });
    bases.forEach((b) => b.remove());
    made.forEach((nb) => html.appendChild(nb));
    /* 有一个式子比整行宽出三成以上：缩小会太小，退回旧办法（在等号处折） */
    const line = html.closest('.mxline'), W = line ? line.clientWidth : 0, wide = Math.max(...made.map((m) => m.getBoundingClientRect().width));
    if (W && wide > W * 1.3) {
      made.forEach((m) => m.remove());
      items.forEach((it) => it.b.appendChild(it.k));
      bases.forEach((b) => html.appendChild(b));
      return false;
    }
    return true;
  }
  /* 一行太长要折行时，只在等号这类关系符后面、或括号外面的加减号后面断开（KaTeX 默认括号里的加减号后面也会断）。
     KaTeX 把能断的地方切成一个个 .base；把不该断开的相邻几个 .base 包进一个不折行的 span。 */
  function breaks(html) {
    if (exprs(html)) return;
    const bases = [...html.children].filter((e) => e.classList.contains('base'));
    let depth = 0, grp = [], first = true;
    const flush = () => { if (grp.length > 1) { const s = document.createElement('span'); s.className = 'mxnb'; grp[0].before(s); grp.forEach((b) => s.appendChild(b)); } grp = []; first = false; };
    /* 行首只有一个关系符（接着上一行写的 "=…"）：不在它后面断，不然 "=" 会单独占一截 */
    const relOnly = (b) => [...b.children].every((k) => /\b(mrel|mspace|strut)\b/.test(k.className));
    bases.forEach((b) => {
      const kids = [...b.children];
      kids.forEach((k) => { if (k.classList.contains('mopen')) depth++; else if (k.classList.contains('mclose')) depth = Math.max(0, depth - 1); });
      let last = kids.length - 1; while (last >= 0 && kids[last].classList.contains('mspace')) last--;
      const endRel = last >= 0 && kids[last].classList.contains('mrel'), endBin = last >= 0 && kids[last].classList.contains('mbin');
      grp.push(b);
      if (endRel && first && grp.every(relOnly)) return;
      if (endRel || (endBin && depth === 0)) flush();
    });
    flush();
  }

  /* ================= 板书 =================
     一个 foreignObject 里放一列式子。所有行一开始就排好（看不见），量好每行和每个框的位置，时间线只管显隐、上移、框。 */
  function board(parent, box, lines, fs) {
    const fo = E('foreignObject', { x: box.x, y: box.y, width: box.w, height: box.h }, parent);
    const root = div('mxb'); root.style.cssText = `width:${box.w}px;height:${box.h}px;font-size:${fs}px`; fo.appendChild(root);
    const col = div('mxcol', root);
    const els = lines.map((L) => {
      const d = div('mxline' + (L.ans ? ' ans' : ''), col);
      d.innerHTML = L.ans ? `<span class="mxans">${L.html}</span>` : tex(L.tex, true);
      if (d.querySelector('.katex-error')) warn('公式渲染出错', L.tex);
      d.querySelectorAll('.katex-html').forEach(breaks);
      return d;
    });
    /* 太宽的（一整块断不开的）缩小字号 */
    els.forEach((d) => { for (let k = 0; k < 4 && d.scrollWidth > d.clientWidth + 1; k++) d.style.fontSize = Math.max(12, parseFloat(getComputedStyle(d).fontSize) * d.clientWidth / d.scrollWidth * 0.98) + 'px'; });
    /* 答案行太高（长的文字答案折成好几行）：缩小到不超过板书高度的 55% */
    els.forEach((d, i) => { if (!lines[i].ans) return; for (let k = 0; k < 6 && d.offsetHeight > box.h * 0.55; k++) d.style.fontSize = Math.max(12, parseFloat(getComputedStyle(d).fontSize) * Math.sqrt(box.h * 0.55 / d.offsetHeight) * 0.97) + 'px'; });
    const cr = () => col.getBoundingClientRect();
    const kk = () => cr().width / col.offsetWidth || 1;
    const rel = (r) => { const c = cr(), k = kk(); return { x: (r.left - c.left) / k, y: (r.top - c.top) / k, w: r.width / k, h: r.height / k }; };
    const gRect = (el) => {
      let L = 1e9, T = 1e9, R = -1e9, B = -1e9;
      glyphs(el).forEach((g) => { const r = g.getBoundingClientRect(); if (r.width < 0.5 || r.height < 0.5) return; L = Math.min(L, r.left); T = Math.min(T, r.top); R = Math.max(R, r.right); B = Math.max(B, r.bottom); });
      return L < R ? rel({ left: L, top: T, width: R - L, height: B - T }) : null;
    };
    /* 一行折成几截时：每截单独成块，下一截的字形顶和上一截的字形底之间留够空
       （KaTeX 的行框按 strut 算，积分号的上下限、矩阵括号、根号会伸出去，和相邻那截压在一起） */
    els.forEach((d) => {
      const hs = d.querySelectorAll('.katex-html'); if (hs.length !== 1) return;   // 文字夹公式的答案行不动
      const items = [...hs[0].children], segs = []; let cur = [], prevR = -1e9;   // 新的一截：这一块的左沿回到了上一块右沿的左边
      items.forEach((el) => { const r = el.getBoundingClientRect(); if (cur.length && r.width > 0 && r.left < prevR - 2) { segs.push(cur); cur = []; } cur.push(el); if (r.width > 0) prevR = r.right; });
      segs.push(cur);
      if (segs.length < 2) return;
      const blocks = segs.map((sg) => { const s = document.createElement('span'); s.className = 'mxseg'; sg[0].before(s); sg.forEach((el) => s.appendChild(el)); return s; });
      const gap = parseFloat(getComputedStyle(d).fontSize) * 0.28;
      for (let k = 1; k < blocks.length; k++) {
        const a = gRect(blocks[k - 1]), b = gRect(blocks[k]); if (!a || !b) continue;
        const need = a.y + a.h + gap - b.y; if (need > 0) blocks[k].style.marginTop = need.toFixed(1) + 'px';
      }
    });
    return { fo, root, col, els, rel, gRect };
  }

  /* ================= 3D 图（Canvas） =================
     投影、按小块排深度的曲面画法照 engine.js；数学坐标原样用（题里的 x、y、z），相机绕 view.at 转。 */
  const COL = { blue: '#58C4DD', gold: '#F0AC5F', green: '#83C167', teal: '#5CD0B3', red: '#FC6255', yellow: '#FFE066', purple: '#9A72AC', white: '#f0efec' };
  const rgb = (h) => { const n = parseInt((COL[h] || h).slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  const fn3 = (expr) => new Function('u', 'v', 't', 'with (Math) { return ' + expr + '; }');   // q.json 里写的参数式，u、v ∈ [0,1]，t 是 sweep 扫的参数
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const nrm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const add3 = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

  function space(parent, box, spec) {
    const fo = E('foreignObject', { x: box.x, y: box.y, width: box.w, height: box.h }, parent);
    const wrap = div('mxfig own-drag'); wrap.style.cssText = `width:${box.w}px;height:${box.h}px`; fo.appendChild(wrap);
    const cv = document.createElement('canvas'); wrap.appendChild(cv);
    const ctx = cv.getContext('2d');
    const V = Object.assign({ az: -0.5, el: 0.35, at: [0, 0, 0], scale: 80, cx: 0.5, cy: 0.5 }, spec.view);
    const cam = { az: V.az, el: V.el };
    const F = {};   // 时间线只动这个对象：每个部分的 _v（出现）、_l（亮）、_t（sweep 参数）
    const parts = (spec.parts || []).map((p) => {
      F[p.id + '_v'] = 0; F[p.id + '_l'] = 0; F[p.id + '_t'] = p.t == null ? 1 : p.t;
      const o = Object.assign({ color: 'blue' }, p, { c: rgb(p.color || 'blue') });
      if (p.kind === 'surface') o.f = fn3(p.uv);
      const lab = p.kind === 'label' ? p : p.label;
      if (lab) { o.lab = div('mxlab', wrap); o.lab.innerHTML = tex(lab.tex); o.labAt = lab.at; }
      return o;
    });
    const axes = Object.keys(spec.axes || {}).map((k) => {
      const r = spec.axes[k], i = 'xyz'.indexOf(k), a = [0, 0, 0], b = [0, 0, 0]; a[i] = r[0]; b[i] = r[1];
      const lab = div('mxlab axis', wrap); lab.innerHTML = tex(k);
      return { a, b, lab, at: add3(b, [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0], 0.22) };
    });
    let B = null, scr = 1;
    const basis = () => { const az = cam.az, el = cam.el; return { R: [-Math.sin(az), Math.cos(az), 0], U: [-Math.sin(el) * Math.cos(az), -Math.sin(el) * Math.sin(az), Math.cos(el)], Vv: [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)] }; };
    const P = (p) => { const q = sub3(p, V.at), X = dot(q, B.R), Y = dot(q, B.U), Z = dot(q, B.Vv), k = 16 / (16 - Z), s = V.scale; return [box.w * V.cx + s * X * k, box.h * V.cy - s * Y * k, Z]; };

    function draw() {
      const r = wrap.getBoundingClientRect(), s = (r.width / box.w || 1) * Math.min(devicePixelRatio || 1, 2);
      if (Math.abs(s - scr) > 1e-3 || cv.width !== Math.round(box.w * s)) { scr = s; cv.width = Math.round(box.w * s); cv.height = Math.round(box.h * s); }
      ctx.setTransform(scr, 0, 0, scr, 0, 0); ctx.clearRect(0, 0, box.w, box.h);
      B = basis();
      const DL = [];
      axes.forEach((ax) => {
        const A = P(ax.a), Bp = P(ax.b);
        DL.push({ z: -99, f() { ctx.save(); ctx.strokeStyle = 'rgba(167,165,155,.55)'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(Bp[0], Bp[1]); ctx.stroke(); head(Bp, Math.atan2(Bp[1] - A[1], Bp[0] - A[0]), 'rgba(167,165,155,.75)', 11); ctx.restore(); } });
      });
      parts.forEach((p) => {
        const v = F[p.id + '_v'], l = F[p.id + '_l'], t = F[p.id + '_t'];
        if (v < 0.01) return;
        const base = p.c.map((x) => x * (0.55 + 0.45 * l));
        if (p.kind === 'surface') {
          const nu = (p.grid || [10, 36])[0], nv = (p.grid || [10, 36])[1], G = [];
          for (let i = 0; i <= nu; i++) { const row = []; for (let j = 0; j <= nv; j++) { const q = P(p.f(i / nu, j / nv, t)); row.push(q); } G.push(row); }
          const al = v * (0.22 + 0.5 * l);
          for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
            const a = G[i][j], b = G[i + 1][j], c = G[i + 1][j + 1], d = G[i][j + 1], sh = (i + j) % 2 ? 1 : 0.84, col = rgba(base.map((x) => x * sh), al);
            DL.push({ z: (a[2] + b[2] + c[2] + d[2]) / 4, f() { ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineWidth = 0.7; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]); ctx.closePath(); ctx.fill(); ctx.stroke(); } });
          }
          if (p.rim !== false) {   // 边沿（u = 1 那一圈）：亮的时候发光
            const Q = []; for (let j = 0; j <= nv; j++) Q.push(P(p.f(1, j / nv, t)));
            DL.push({ z: Q.reduce((s0, q) => s0 + q[2], 0) / Q.length + 0.5, f() { ctx.save(); ctx.strokeStyle = rgba(p.c, v * (0.5 + 0.5 * l)); ctx.lineWidth = 1.6 + 1.2 * l; ctx.shadowColor = rgba(p.c, 1); ctx.shadowBlur = 10 * l; ctx.beginPath(); Q.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.stroke(); ctx.restore(); } });
          }
        } else if (p.kind === 'arrow') {
          const d = nrm(p.dir), A = P(p.at), Bp = P(add3(p.at, d, p.len || 1));
          DL.push({ z: Math.max(A[2], Bp[2]) + 1, f() { ctx.save(); const cs = rgba(p.c.map((x) => Math.min(255, x * (0.75 + 0.35 * l))), v); ctx.strokeStyle = cs; ctx.lineWidth = 2.6; ctx.shadowColor = rgba(p.c, 1); ctx.shadowBlur = 8 * l; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(Bp[0], Bp[1]); ctx.stroke(); head(Bp, Math.atan2(Bp[1] - A[1], Bp[0] - A[0]), cs, 15); ctx.restore(); } });
        }
      });
      DL.sort((a, b) => a.z - b.z).forEach((d) => d.f());
      /* 标注：跟着点走，透明度跟着它那个部分 */
      parts.forEach((p) => {
        if (!p.lab) return;
        const v = F[p.id + '_v'], l = F[p.id + '_l'], q = P(p.labAt);
        p.lab.style.opacity = v.toFixed(3); p.lab.style.transform = `translate(${q[0].toFixed(1)}px,${q[1].toFixed(1)}px) translate(-50%,-50%)`;
        p.lab.style.color = rgba(p.c.map((x) => Math.min(255, x * (0.7 + 0.3 * l) + 40 * (1 - l))), 1);
      });
      axes.forEach((ax) => { const q = P(ax.at); ax.lab.style.transform = `translate(${q[0].toFixed(1)}px,${q[1].toFixed(1)}px) translate(-50%,-50%)`; });
    }
    function head(B0, ang, col, size) {
      ctx.fillStyle = col; ctx.beginPath();
      ctx.moveTo(B0[0] + Math.cos(ang) * size * 0.5, B0[1] + Math.sin(ang) * size * 0.5);
      ctx.lineTo(B0[0] + Math.cos(ang + 2.5) * size * 0.55, B0[1] + Math.sin(ang + 2.5) * size * 0.55);
      ctx.lineTo(B0[0] + Math.cos(ang - 2.5) * size * 0.55, B0[1] + Math.sin(ang - 2.5) * size * 0.55); ctx.closePath(); ctx.fill();
    }
    /* 每帧看一眼：时间线动了 F、手指转了视角、画面大小变了，才重画 */
    let key = '';
    const fkeys = Object.keys(F);
    const tick = () => {
      if (!wrap.isConnected) { gsap.ticker.remove(tick); return; }
      const r = wrap.getBoundingClientRect(), k = fkeys.map((x) => F[x].toFixed(4)).join(',') + cam.az + ',' + cam.el + ',' + r.width.toFixed(1);
      if (k !== key) { key = k; draw(); }
    };
    gsap.ticker.add(tick);
    /* 手指拖着转视角（外壳认 .own-drag，这里的横拖不当成翻步） */
    let dr = null;
    wrap.addEventListener('pointerdown', (e) => { if (e.button) return; dr = { x: e.clientX, y: e.clientY, id: e.pointerId }; try { wrap.setPointerCapture(e.pointerId); } catch (er) {} });
    wrap.addEventListener('pointermove', (e) => {
      if (!dr || e.pointerId !== dr.id) return;
      const k = wrap.getBoundingClientRect().width / box.w || 1, dx = (e.clientX - dr.x) / k, dy = (e.clientY - dr.y) / k; dr.x = e.clientX; dr.y = e.clientY;
      cam.az -= dx * 0.008; cam.el = Math.max(-0.3, Math.min(1.5, cam.el + dy * 0.008));
    });
    const up = (e) => { if (dr && e.pointerId === dr.id) dr = null; };
    wrap.addEventListener('pointerup', up); wrap.addEventListener('pointercancel', up);

    return { fo, F, cam, parts, draw, ids: parts.map((p) => p.id) };
  }

  /* ================= 平面图（SVG） =================
     spec.x、spec.y 坐标范围；parts：curve {y: "x 的式子", x: [a, b]}、region {top, bottom, x: [a, b]}、point {at}、label {tex, at}。 */
  const fn1 = (expr) => new Function('x', 'with (Math) { return ' + expr + '; }');
  function plane(parent, box, spec) {
    const fo = E('foreignObject', { x: box.x, y: box.y, width: box.w, height: box.h }, parent);
    const wrap = div('mxfig plane'); wrap.style.cssText = `width:${box.w}px;height:${box.h}px`; fo.appendChild(wrap);
    const NS = 'http://www.w3.org/2000/svg', sv = document.createElementNS(NS, 'svg');
    sv.setAttribute('width', box.w); sv.setAttribute('height', box.h); sv.setAttribute('viewBox', `0 0 ${box.w} ${box.h}`); wrap.appendChild(sv);
    const [x0, x1] = spec.x, [y0, y1] = spec.y, pad = 34;
    const s = Math.min((box.w - 2 * pad) / (x1 - x0), (box.h - 2 * pad) / (y1 - y0));
    const ox = (box.w - s * (x1 - x0)) / 2 - s * x0, oy = (box.h + s * (y1 - y0)) / 2 + s * y0;
    const X = (x) => ox + s * x, Y = (y) => oy - s * y;
    const lab = (t, at, cls) => { const d = div('mxlab' + (cls ? ' ' + cls : ''), wrap); d.innerHTML = tex(t); d.style.transform = `translate(${X(at[0]).toFixed(1)}px,${Y(at[1]).toFixed(1)}px) translate(-50%,-50%)`; return d; };
    const ax = E('g', { stroke: 'rgba(167,165,155,.6)', 'stroke-width': 1.4, fill: 'none' }, sv);
    E('path', { d: `M${X(x0)},${Y(0)}H${X(x1)}M${X(x1) - 9},${Y(0) - 5}L${X(x1)},${Y(0)}L${X(x1) - 9},${Y(0) + 5}M${X(0)},${Y(y0)}V${Y(y1)}M${X(0) - 5},${Y(y1) + 9}L${X(0)},${Y(y1)}L${X(0) + 5},${Y(y1) + 9}` }, ax);
    lab('x', [x1, 0], 'axis').style.marginTop = '14px'; lab('y', [0, y1], 'axis').style.marginLeft = '-14px'; lab('O', [0, 0], 'axis').style.margin = '12px 0 0 -12px';
    const samp = (f, a, b, n) => { const pts = []; for (let i = 0; i <= n; i++) { const x = a + (b - a) * i / n; pts.push([X(x), Y(f(x))]); } return pts; };
    const pathOf = (pts) => 'M' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L');
    const parts = (spec.parts || []).map((p) => {
      const g = E('g', null, sv), c = COL[p.color] || p.color || COL.blue, o = { id: p.id, g, els: [] };
      if (p.kind === 'curve') {
        const d = pathOf(samp(fn1(p.y), p.x[0], p.x[1], 160));
        o.base = E('path', { d, fill: 'none', stroke: c, 'stroke-width': 2.4, 'stroke-opacity': 0.6 }, g);
        o.hi = E('path', { d, fill: 'none', stroke: c, 'stroke-width': 3.6, class: 'mxglow' }, g);
      } else if (p.kind === 'region') {
        const top = samp(fn1(p.top), p.x[0], p.x[1], 160), bot = samp(fn1(p.bottom || '0'), p.x[0], p.x[1], 160).reverse();
        const d = pathOf(top.concat(bot)) + 'Z';
        o.base = E('path', { d, fill: c, 'fill-opacity': 0.14 }, g);
        o.hi = E('path', { d, fill: c, 'fill-opacity': 0.36 }, g);   // 透明度写成 fill-opacity：opacity 归时间线（autoAlpha）管
      } else if (p.kind === 'point') {
        o.base = E('circle', { cx: X(p.at[0]), cy: Y(p.at[1]), r: 4.5, fill: c, 'fill-opacity': 0.7 }, g);
        o.hi = E('circle', { cx: X(p.at[0]), cy: Y(p.at[1]), r: 6, fill: c, class: 'mxglow' }, g);
      } else if (p.kind === 'dir') {
        /* 方向箭头：曲线上 at 那一点画一个小三角，尖朝 dir（数学坐标里的方向）；of 写曲线的 id，就跟着那条曲线出现、变亮 */
        const a = Math.atan2(-p.dir[1], p.dir[0]), x0 = X(p.at[0]), y0 = Y(p.at[1]), z = p.size || 11;
        const d = 'M' + [[z, 0], [-z * 0.8, z * 0.72], [-z * 0.8, -z * 0.72]].map(([u, v]) => (x0 + u * Math.cos(a) - v * Math.sin(a)).toFixed(1) + ',' + (y0 + u * Math.sin(a) + v * Math.cos(a)).toFixed(1)).join('L') + 'Z';
        o.base = E('path', { d, fill: c, 'fill-opacity': 0.7 }, g);
        o.hi = E('path', { d, fill: c, class: 'mxglow' }, g);
        o.of = p.of;
      }
      if (p.kind === 'label' || p.label) { const L = p.kind === 'label' ? p : p.label; o.lab = lab(L.tex, L.at); }
      gsap.set([g].concat(o.lab ? [o.lab] : []), { autoAlpha: 0 }); if (o.hi) gsap.set(o.hi, { autoAlpha: 0 });
      return o;
    });
    return { fo, parts, ids: parts.map((p) => p.id) };
  }

  /* 一步里图的变化：on 出现（暗着）、lit 亮、没提到的收掉；sweep {部分: [起, 中间…, 止]} 这一步里把参数 t 扫一遍 */
  function figTo(t, fig, f, pos) {
    const on = new Set([].concat(f.on || [], f.lit || [])), lit = new Set(f.lit || []);
    if (fig.F) {
      const to = {};
      fig.ids.forEach((id) => { to[id + '_v'] = on.has(id) ? 1 : 0; to[id + '_l'] = lit.has(id) ? 1 : 0; });
      t.to(fig.F, Object.assign({ duration: 0.55, ease: 'power2.inOut' }, to), pos);
      Object.keys(f.sweep || {}).forEach((id) => {
        const ks = f.sweep[id]; t.set(fig.F, { [id + '_t']: ks[0] }, pos);
        ks.slice(1).forEach((v, i) => t.to(fig.F, { [id + '_t']: v, duration: i ? 0.7 : 1.6, ease: 'power1.inOut' }, pos + 0.3 + (i ? 1.6 + (i - 1) * 0.7 : 0)));
      });
      return pos + 0.3 + Object.keys(f.sweep || {}).reduce((m, id) => Math.max(m, f.sweep[id].length > 1 ? 1.6 + (f.sweep[id].length - 2) * 0.7 : 0), 0);
    }
    fig.parts.forEach((p) => {
      const id = p.of || p.id, v = on.has(id), l = lit.has(id);   // 方向箭头跟着它那条曲线
      t.to([p.g].concat(p.lab ? [p.lab] : []), { autoAlpha: v ? 1 : 0, duration: 0.45 }, pos);
      if (p.hi) t.to(p.hi, { autoAlpha: l ? 1 : 0, duration: 0.45 }, pos);
    });
    return pos + 0.45;
  }

  /* ================= 卡片：思路、定理卡 =================
     和推导行分开：推导行是黑底上发光的式子，卡片是一块有边框的面板，盖在板书区中间，板书整体压暗。
     所有卡片放在同一个 foreignObject 里，建的时候全藏好；时间线只管某张卡的出现、里面几行依次亮、收起。 */
  function cardLayer(parent, box, fs) {
    const fo = E('foreignObject', { x: box.x, y: box.y, width: box.w, height: box.h }, parent);
    const root = div('mxcards'); root.style.cssText = `width:${box.w}px;height:${box.h}px;font-size:${fs}px`; fo.appendChild(root);
    /* 放好以后量高度，竖着放在板书区偏上一点；太高就缩字号；式子太宽就缩式子 */
    const place = (c) => {
      c.querySelectorAll('.mxc-f').forEach((f) => { for (let k = 0; k < 4 && f.scrollWidth > f.clientWidth + 1; k++) f.style.fontSize = (parseFloat(getComputedStyle(f).fontSize) * f.clientWidth / f.scrollWidth * 0.97) + 'px'; });
      for (let k = 0; k < 5 && c.offsetHeight > box.h - 20; k++) c.style.fontSize = (parseFloat(getComputedStyle(c).fontSize) * (box.h - 20) / c.offsetHeight * 0.97) + 'px';
      c.style.top = Math.max(10, (box.h - c.offsetHeight) * 0.42).toFixed(1) + 'px';
      gsap.set(c, { autoAlpha: 0, y: 18 });
    };
    const head = (c, tag, title) => { const h = div('mxc-head', c); div('mxc-tag', h).textContent = tag; if (title != null) div('mxc-title', h).textContent = title; return h; };
    const row = (c, k, html, cls) => { const r = div('mxc-row' + (cls ? ' ' + cls : ''), c); div('mxc-k', r).textContent = k; const v = div('mxc-v', r); v.innerHTML = html; return r; };
    return {
      fo, root,
      /* 定理卡：定理名、式子、条件、本题为什么满足（带 ✓） */
      thm(K, c) {
        const el = div('mxcard thm', root);
        head(el, K.T('mx.thm'), K.T('steps.' + c.id + '.h'));
        /* 定理内容：q.json 里写了 tex 就用它；否则用 Gemini 写的 card.<id>.law（文字夹 $…$）。只有一个公式时不折行、太宽就缩小 */
        const law = c.tex ? '$' + c.tex + '$' : String(K.T('card.' + c.id + '.law')).trim(), pure = /^\$[^$]*\$$/.test(law);
        const f = div('mxc-f' + (pure ? '' : ' txt'), el); f.innerHTML = pure ? tex(law.slice(1, -1), true) : glued(law, true);
        if (f.querySelector('.katex-error')) warn(c.id, '定理卡的式子渲染出错', law);
        const cond = row(el, K.T('mx.cond'), mixed(K.T('card.' + c.id + '.cond')));
        const fit = row(el, K.T('mx.fit'), mixed(K.T('card.' + c.id + '.fit')) + '<span class="mxc-ok">✓</span>', 'fit');
        place(el);
        const fg = glyphs(f); gsap.set(fg, { opacity: 0 }); gsap.set([cond, fit], { autoAlpha: 0, y: 8 });
        const ok = fit.querySelector('.mxc-ok'); gsap.set(ok, { autoAlpha: 0, scale: 0.4 });
        return {
          el,
          open(t, p) {
            t.to(el, { autoAlpha: 1, y: 0, duration: 0.5, ease: 'power2.out' }, p); K.sfx(t, 'extend', p);
            const st = Math.min(0.03, 0.6 / Math.max(1, fg.length));
            if (fg.length) t.to(fg, { opacity: 1, duration: 0.3, stagger: st }, p + 0.3);
            const a = p + 0.45 + fg.length * st;
            t.to(cond, { autoAlpha: 1, y: 0, duration: 0.45, ease: 'power2.out' }, a);
            t.to(fit, { autoAlpha: 1, y: 0, duration: 0.45, ease: 'power2.out' }, a + 0.7);
            t.to(ok, { autoAlpha: 1, scale: 1, duration: 0.4, ease: 'back.out(2.4)' }, a + 1.1); K.sfx(t, 'blip', a + 1.1);
            return a + 1.5;
          },
        };
      },
      /* 思路卡：题干里的特征（照抄题干，框起来）、看到了什么 → 想到什么方法 */
      idea(K, q) {
        const el = div('mxcard idea', root);
        head(el, K.T('mx.idea'));
        const stem = String(q.stemTex || '');
        const fr = asList(q.idea.from).map((m) => m.tex);
        fr.forEach((s) => { if (stem.indexOf(s) < 0) warn('idea.from 在题干里找不到：', s); });
        const see = row(el, K.T('mx.see'), (fr.length ? '<div class="mxc-chips">' + fr.map((s) => `<span class="mxc-chip">${mixed(s)}</span>`).join('') + '</div>' : '') +
          `<div class="mxc-say">${mixed(K.T('idea.see'))}</div>`, 'see');
        const bar = div('mxc-bar', el);
        const so = row(el, K.T('mx.so'), mixed(K.T('idea.so')), 'so');
        place(el);
        const chips = [...see.querySelectorAll('.mxc-chip')], say = see.querySelector('.mxc-say'), k1 = see.querySelector('.mxc-k');
        gsap.set([k1, say], { autoAlpha: 0 }); gsap.set(chips, { autoAlpha: 0, scale: 0.85 }); gsap.set(bar, { scaleY: 0, transformOrigin: '50% 0%' }); gsap.set(so, { autoAlpha: 0, y: 8 });
        return {
          el,
          open(t, p) {
            t.to(el, { autoAlpha: 1, y: 0, duration: 0.5, ease: 'power2.out' }, p); K.sfx(t, 'extend', p);
            t.to(k1, { autoAlpha: 1, duration: 0.3 }, p + 0.3);
            chips.forEach((c, i) => { t.to(c, { autoAlpha: 1, scale: 1, duration: 0.4, ease: 'back.out(2)' }, p + 0.45 + i * 0.3); K.sfx(t, 'blip', p + 0.45 + i * 0.3); });
            const a = p + 0.55 + chips.length * 0.3;
            t.to(say, { autoAlpha: 1, duration: 0.45 }, a);
            t.to(bar, { scaleY: 1, duration: 0.45, ease: 'power2.inOut' }, a + 0.6);
            t.to(so, { autoAlpha: 1, y: 0, duration: 0.45, ease: 'power2.out' }, a + 0.95);
            return a + 1.4;
          },
        };
      },
    };
  }

  /* ================= 拼成一页 ================= */
  const LAY = {
    plain: { board: { x: 70, y: 70, w: 860, h: 630 }, fs: 34 },
    fig: { fig: { x: 10, y: 70, w: 440, h: 630 }, board: { x: 466, y: 70, w: 524, h: 630 }, fs: 24 },
  };
  const DIM = 0.5, TOP = 32;   // TOP：板书顶上留的渐隐带（和 math.css 里 .mxcol 的 padding-top 一致）

  function lesson(K, q) {
    const svg = K.svg, all = (q.steps || []).slice(0, q.useSteps || undefined);   // useSteps：详解有两种解法时只用前几步（第一种）
    /* 详解末步就是答案（末步以 answerTex 去掉 $ 后的内容结尾）：这一步自己当答案步，不再单独重复一遍 */
    const aTex = String(q.answerTex || '').replace(/\$/g, ''), last = all[all.length - 1];
    const merged = !!(last && aTex && last.tex.endsWith(aTex)) ? last : null;
    const steps = merged ? all.slice(0, -1) : all;
    const hasFig = !!(q.needsFigure && q.figure);
    if (q.needsFigure && !q.figure) warn(q.id || '', 'needsFigure 为真但没写 figure，按没有图排');
    const lay = hasFig ? LAY.fig : LAY.plain;
    const g = E('g', { class: 'mx' }, svg);

    /* ---- 哪一讲：先在正中，开始推导后缩到左上角 ---- */
    const tg = E('g', null, g), tt = E('text', { x: 0, y: 0, 'font-size': 36, fill: C.ink, class: 'serif', 'font-weight': 700 }, tg, q.topic || '');
    const tw = tt.getComputedTextLength() || 600, bigS = Math.min(1, 880 / tw), smallS = 0.5;
    const ul = E('line', { x1: 0, y1: 22, x2: tw, y2: 22, stroke: C.acc, 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-dasharray': tw + ' ' + tw, 'stroke-dashoffset': tw }, tg);
    gsap.set(tg, { svgOrigin: '0 0', x: 500 - tw * bigS / 2, y: 352, scale: bigS, autoAlpha: 0 });

    /* ---- 板书：每步一行 + 答案行 ---- */
    const specs = steps.map((s) => ({ tex: s.tex, ws: [], marks: [], keeps: [] }));
    /* 答案行：末步合并的用那一步的式子；选择题在字母后面接上那个选项的原文 */
    const oi = Array.isArray(q.opts) ? q.opts.indexOf(q.answer) : -1, oT = oi >= 0 && q.optsTex ? q.optsTex[oi] : '';
    const aHtml = merged ? tex(merged.tex, true) : mixed(q.answerTex, true) + (oT ? `<span class="mxopt">${mixed(oT, true)}</span>` : '');
    specs.push({ tex: merged ? merged.tex : q.answerTex || '', html: aHtml, ans: true, ws: [], marks: [], keeps: [] });
    steps.forEach((s, i) => {
      const L = specs[i];
      asList(s.mark).forEach((m, k) => {
        const at = find(L.tex, m.tex, m.n);
        if (at < 0) { warn(`s${i + 1} 的 mark 在 tex 里找不到：`, m.tex); return; }
        L.ws.push({ s: at, e: at + m.tex.length, c: 'mxmk mxmk' + k }); L.marks.push('.mxmk' + k);
      });
      asList(s.keep).forEach((m, k) => {
        let j = i - 1; while (j >= 0 && specs[j].tex.indexOf(m.tex) < 0) j--;
        if (j < 0) { warn(`s${i + 1} 的 keep 在前面几行里找不到：`, m.tex); return; }
        const src = specs[j].tex.indexOf(m.tex), mine = m.n ? [find(L.tex, m.tex, m.n)] : findAll(L.tex, m.tex);
        if (!mine.length || mine[0] < 0) { warn(`s${i + 1} 的 keep 在这一行里找不到：`, m.tex); return; }
        specs[j].ws.push({ s: src, e: src + m.tex.length, c: `mxks mxks${i}x${k}` });
        mine.forEach((at) => L.ws.push({ s: at, e: at + m.tex.length, c: 'mxkp mxkp' + k }));
        L.keeps.push({ k, src: j });
      });
    });
    specs.forEach((L) => { if (!L.ans) L.tex = wrapTex(L.tex, L.ws); });
    const bd = board(g, lay.board, specs, lay.fs);
    /* 没有图的题：整列居中（每行左对齐，像板书） */
    if (!hasFig) {
      const maxW = Math.max.apply(null, bd.els.map((d) => { const r = bd.gRect(d); return r ? r.x + r.w : 0; }));
      const padL = Math.max(0, (lay.board.w - maxW) / 2); bd.els.forEach((d) => { d.style.marginLeft = padL + 'px'; d.style.width = (lay.board.w - padL) + 'px'; });
    }
    /* 第一行有高出行框的字（分数、积分上限）时，整列再往下挪一点，框也不进顶上的渐隐带 */
    const g0 = bd.gRect(bd.els[0]); if (g0 && g0.y < TOP + 10) bd.col.style.paddingTop = (TOP + TOP + 10 - g0.y).toFixed(1) + 'px';
    const rows = bd.els.map((d, i) => {
      const r = bd.rel(d.getBoundingClientRect()), gr = bd.gRect(d) || r, top = Math.min(r.y, gr.y), bot = Math.max(r.y + r.h, gr.y + gr.h);
      const L = specs[i];
      const marks = L.marks.map((sel) => {
        const el = d.querySelector(sel), rr = el && bd.gRect(el); if (!rr) return null;
        /* 框比字形大一圈，但不压到旁边的字：四边各留出到最近的邻字一半的距离（最多 7） */
        const nb = glyphs(d).filter((g) => !el.contains(g)).map((g) => bd.rel(g.getBoundingClientRect())).filter((r) => r.w > 0.5 && r.h > 0.5);
        const vo = (r) => r.y < rr.y + rr.h && r.y + r.h > rr.y, ho = (r) => r.x < rr.x + rr.w && r.x + r.w > rr.x;
        const gap = (list) => Math.max(2.5, Math.min(7, (Math.min.apply(null, list.concat(99)) - 1) / 2));
        const pl = gap(nb.filter((r) => vo(r) && r.x + r.w <= rr.x + 1).map((r) => rr.x - (r.x + r.w)));
        const pr = gap(nb.filter((r) => vo(r) && r.x >= rr.x + rr.w - 1).map((r) => r.x - (rr.x + rr.w)));
        const pt = gap(nb.filter((r) => ho(r) && r.y + r.h <= rr.y + 1).map((r) => rr.y - (r.y + r.h)));
        const pb = gap(nb.filter((r) => ho(r) && r.y >= rr.y + rr.h - 1).map((r) => r.y - (rr.y + rr.h)));
        return { el, b: div('mxbox', bd.col), r: { x: rr.x - pl, y: rr.y - pt, w: rr.w + pl + pr, h: rr.h + pt + pb } };
      }).filter(Boolean);
      const keeps = L.keeps.map((kp) => [...d.querySelectorAll('.mxkp' + kp.k)].map((el) => {
        const sEl = bd.els[kp.src].querySelector(`.mxks${i}x${kp.k}`), a = sEl && bd.rel(sEl.getBoundingClientRect()), b = bd.rel(el.getBoundingClientRect());
        return a ? { el, dx: a.x - b.x, dy: a.y - b.y } : null;
      })).flat().filter(Boolean);
      const kpEls = keeps.map((x) => x.el), lv = glyphs(d).filter((e) => !kpEls.some((k) => k.contains(e)));
      return { d, top, bot, marks, keeps, lv };
    });
    /* 行首就是框（右边有图、板书不居中时）：框会伸出板书左沿被切掉，整列往右让一点（最多 10） */
    const minX = Math.min.apply(null, rows.map((r) => r.marks.map((m) => m.r.x)).flat().concat(2));
    if (minX < 1) { const dx = Math.min(10, 1 - minX); rows.forEach((r) => { gsap.set(r.d, { x: dx }); r.marks.forEach((m) => { m.r.x += dx; }); }); }
    rows.forEach((r) => { gsap.set(r.d, { autoAlpha: 0 }); r.marks.forEach((m) => gsap.set(m.b, { autoAlpha: 0, left: m.r.x, top: m.r.y, width: m.r.w, height: m.r.h })); });
    gsap.set(bd.col, { y: 0 });
    /* 写到第 i 行时整列上移多少：先算出让第 i 行露全的最小量；有行因此要收掉时，再多移一点，让留下的第一行顶到上沿（上面不空一大块） */
    const H = lay.board.h, lim = Math.min(TOP - 4, rows[0].top) - 2;
    const shiftAt = (i) => {
      let sh = Math.max(0, rows[i].bot + 14 - H);
      if (sh > 0) { const f = rows.findIndex((r, j) => j <= i && r.top - sh >= lim); if (f > 0) sh = Math.max(sh, rows[f].top - (lim + 2)); }
      return sh;
    };

    /* ---- 图 ---- */
    let fig = null;
    if (hasFig) {
      fig = q.figure.kind === 'space' ? space(g, lay.fig, q.figure) : plane(g, lay.fig, q.figure);
      gsap.set(fig.fo, { autoAlpha: 0 });
    }

    /* ---- 一步：上一行变暗、上移、写新的一行、框关键的那块 ---- */
    function enter(t, i, p) {
      const r = rows[i], sh = shiftAt(i);
      if (i > 0) {
        rows[i - 1].marks.forEach((m) => fx.hide(t, m.b, 0.05, 0.25));
        rows[i - 1].marks.forEach((m) => t.to(m.el, { color: C.ink, duration: 0.3 }, 0.05));
      }
      for (let j = 0; j < i; j++) {
        const gone = rows[j].top - sh < lim;   // 移进顶上那条渐隐带的行整行收掉，不留半截字
        if (gone) t.to(rows[j].d, { autoAlpha: 0, duration: 0.35 }, Math.max(0, p - 0.25));
        else if (j === i - 1 || r.ans) t.to(rows[j].d, { autoAlpha: r.ans ? 0.32 : DIM, duration: 0.4 }, 0.1);
      }
      t.to(bd.col, { y: -sh, duration: 0.6, ease: 'power3.inOut' }, Math.max(0, p - 0.25));
      t.set(r.d, { autoAlpha: 1 }, p);
      let w = p;
      if (r.ans) {
        const a = r.d.querySelector('.mxans');
        t.fromTo(a, { autoAlpha: 0, scale: 0.55, transformOrigin: '0% 50%' }, { autoAlpha: 1, scale: 1, duration: 0.6, ease: 'back.out(1.7)' }, p);
        t.fromTo(a, { textShadow: '0 0 0px rgba(116,196,145,0)' }, { textShadow: '0 0 22px rgba(116,196,145,.75)', duration: 0.35, yoyo: true, repeat: 1 }, p + 0.45);
        K.sfx(t, 'done', p + 0.1);
        return p + 1.2;
      }
      t.fromTo(r.d, { y: 12 }, { y: 0, duration: 0.5, ease: 'power2.out' }, p);
      r.keeps.forEach((kp) => t.fromTo(kp.el, { x: kp.dx, y: kp.dy, color: C.acc }, { x: 0, y: 0, duration: 0.8, ease: 'power3.inOut' }, p).to(kp.el, { color: C.ink, duration: 0.4 }, p + 0.8));
      if (r.keeps.length) w = p + 0.45;
      const n = r.lv.length, st = Math.min(0.035, 0.75 / Math.max(1, n));
      if (n) t.fromTo(r.lv, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: 'power1.out', stagger: st }, w);
      K.sfx(t, 'drop', p);
      w += n * st + 0.3;
      r.marks.forEach((m, k) => {
        const at = w + 0.15 + k * 0.18, o = 14;
        t.fromTo(m.b, { autoAlpha: 0, left: m.r.x - o, top: m.r.y - o, width: m.r.w + 2 * o, height: m.r.h + 2 * o },
          { autoAlpha: 1, left: m.r.x, top: m.r.y, width: m.r.w, height: m.r.h, duration: 0.45, ease: 'power3.out' }, at);
        t.to(m.el, { color: '#ffd7bf', duration: 0.3 }, at + 0.15);
        K.sfx(t, 'blip', at);
      });
      return w + (r.marks.length ? 0.6 + r.marks.length * 0.18 : 0);
    }

    K.step('topic', { sec: 'topic' }, (t) => {
      t.to(tg, { autoAlpha: 1, duration: 0.5, ease: 'power1.out' }, 0.1);
      t.fromTo(tt, { y: 14 }, { y: 0, duration: 0.6, ease: 'power2.out' }, 0.1);
      t.to(ul, { strokeDashoffset: 0, duration: 0.6, ease: 'power2.inOut' }, 0.5);
      K.sfx(t, 'blip', 0.5);
      t.to({}, { duration: 0.3 }, 1.1);
    });
    /* 第一个推导步（或没有推导步时的答案步）：讲名缩到左上角，图出现 */
    const intro = (t) => {
      t.to(tg, { x: 40, y: 46, scale: smallS, duration: 0.7, ease: 'power3.inOut' }, 0);
      t.to(tt, { fill: C.muted, duration: 0.5 }, 0.1); fx.hide(t, ul, 0, 0.3);
      if (fig) fx.show(t, fig.fo, 0.35, 0.5);
    };
    /* ---- 卡片：思路（topic 之后）、定理卡（插在 before 那一步之前） ---- */
    const cl = cardLayer(g, lay.board, hasFig ? 23 : 28);
    const before = {};   // 步名 → 这一步之前要出的定理卡
    const known = new Set(steps.map((s, i) => 's' + (i + 1)).concat('answer'));
    (q.cards || []).forEach((c) => {
      let b = c.before; if (merged && b === 's' + all.length) b = 'answer';   // 末步并进答案步：写它原来的步名也认
      if (!known.has(b)) { warn(`定理卡 ${c.id} 的 before 找不到：`, c.before); return; }
      (before[b] = before[b] || []).push(c);
    });
    let first = true, shown = null;   // shown：上一步留在画面上的卡（这一步开头收起）
    /* 每一步开头：第一步把讲名缩上去、出图；上一步是卡片就收起它、板书亮回来。返回这一步能开始动的时刻 */
    const begin = (t, p) => {
      if (first) { intro(t); first = false; p = Math.max(p, 0.6); }
      if (shown) {
        t.to(shown.el, { autoAlpha: 0, y: -12, duration: 0.35, ease: 'power2.in' }, 0.05);
        t.to(bd.col, { opacity: 1, duration: 0.4 }, 0.15);
        shown = null; p = Math.max(p, 0.45);
      }
      return p;
    };
    const cardStep = (id, card, f) => K.step(id, { sec: 'derive' }, (t) => {
      const p = begin(t, 0.15);
      t.to(bd.col, { opacity: 0.12, duration: 0.4 }, Math.max(0, p - 0.1));
      let end = card.open(t, p);
      if (fig && f) end = Math.max(end, figTo(t, fig, f, p));
      shown = card;
      t.to({}, { duration: 0.3 }, end);
    });
    const thmSteps = (k) => (before[k] || []).forEach((c) => cardStep(c.id, cl.thm(K, c), c.fig));
    if (q.idea) cardStep('idea', cl.idea(K, q), q.idea.fig);
    steps.forEach((s, i) => {
      thmSteps('s' + (i + 1));
      K.step('s' + (i + 1), { sec: 'derive' }, (t) => {
        const p = begin(t, 0.15);
        let end = 0;
        if (fig && s.fig) end = figTo(t, fig, s.fig, p);
        end = Math.max(end, enter(t, i, p));
        t.to({}, { duration: 0.25 }, end);
      });
    });
    thmSteps('answer');
    K.step('answer', { sec: 'answer', answer: true }, (t) => {
      const i = rows.length - 1, af = q.answerFig || (merged && merged.fig);
      const p = begin(t, 0.3);
      if (fig && af) figTo(t, fig, af, Math.max(0.2, p - 0.1));
      const end = enter(t, i, p);
      t.to({}, { duration: 0.2 }, end);
    });
    Kit.math.last = { rows, bd, fig, specs, merged: !!merged, cards: cl };   // 给调试和自动检查用
  }

  /* 读题（kit/read.js）也要画题目的图：按 q.json 的 figure 画在 box 里，figTo 同推导步的 fig */
  const figure = (parent, box, spec) => (spec.kind === 'space' ? space(parent, box, spec) : plane(parent, box, spec));
  Kit.math = { ready, rail, lesson, mixed, wrapTex, figure, figTo, warnings: [] };
})();
