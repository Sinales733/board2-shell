/* kit/sections.js：每页讲解都有的段落，按数据画，不用每道题手写。
   一页讲解的顺序：where（这题在书里哪一块）→ 知识块自己的若干步 → exams（真题怎么考）→ o_A…（逐项判断）→ answer。
   Kit.board 是通用的对比表：知识块在自己的步骤里往表里填，逐项判断时在表上高亮、贴选项圆牌、闪记号。
   这里不带任何给人看的字，全部用 K.T('键') 取（先查题目的字，再查知识块的字，最后查 kit/ui.json）。 */
(function () {
  'use strict';
  const E = Kit.E, C = Kit.C, fx = Kit.fx, D = Kit.draw, tx = D.text;
  const hide0 = (els) => gsap.set(els, { autoAlpha: 0 });

  /* ================= 对比表 =================
     cfg：x、w 表的左边和宽；y 第一行的上沿；rh 行距；hy 表头的基线；from 记号从哪飞进来（画面上的一点）。
     cols：[{k, x, v}]，x 是这一列的中线；v 为真的列放字（board.v.<行>），其余列放 ✓✗。
     rows：[{k, ok: {列: 1/0}}]。字：表头 board.h.<列>，行名 board.r.<行>。 */
  function board(K, parent, cfg) {
    const T = K.T, X = cfg.x, RW = cfg.w, RH = cfg.rh, BY = (r) => cfg.y + r * RH, RHH = RH - 8;
    const vcol = cfg.cols.find((c) => c.v), mcols = cfg.cols.filter((c) => !c.v);
    const g = E('g', null, parent);
    cfg.cols.forEach((c) => tx(g, c.x, cfg.hy, 15, C.muted, T('board.h.' + c.k), { 'text-anchor': 'middle' }));
    const rowG = [], vals = [], marks = [], src = [];
    cfg.rows.forEach((row, r) => {
      const rg = E('g', null, g), y = BY(r);
      E('rect', { x: X, y, width: RW, height: RHH, rx: 10, fill: C.surface, stroke: C.line }, rg);
      tx(rg, X + 18, y + 30, 20, C.ink, T('board.r.' + row.k), { 'font-weight': 700 });
      if (vcol) {
        const rd = tx(rg, vcol.x, y + 30.5, 21, C.ink, T('board.v.' + row.k), { 'text-anchor': 'middle', 'font-weight': 700 });
        gsap.set(rd, { autoAlpha: 0, scale: 0.5, transformOrigin: '50% 50%' }); vals.push(rd);
      }
      marks.push(mcols.map((c) => {
        const ok = row.ok[c.k], mg = E('g', null, rg);
        E('rect', { x: c.x - 46, y: y + 2, width: 92, height: 42, fill: 'transparent' }, mg);
        tx(mg, c.x, y + 33, 29, ok ? C.ok : C.no, ok ? '✓' : '✗', { 'text-anchor': 'middle', 'font-weight': 700 });
        gsap.set(mg, { autoAlpha: 0, x: cfg.from.x - c.x, y: cfg.from.y - (y + 23), scale: 2, transformOrigin: '50% 50%' });
        return mg;
      }));
      src.push([]); rowG.push(rg);
    });
    const hl = E('rect', { x: X, y: BY(0), width: RW, height: RHH, rx: 10, fill: 'rgba(224,138,105,.10)', stroke: C.acc, 'stroke-width': 2.2, 'pointer-events': 'none' }, g);
    hide0([g, hl]);
    const R = (k) => cfg.rows.findIndex((x) => x.k === k), M = (k) => mcols.findIndex((x) => x.k === k);
    const B = {
      g, hl, rows: rowG, row: R, bottom: BY(cfg.rows.length - 1) + RHH,
      /* 填上“值”那一格 */
      fill: (t, row, pos) => fx.pop(t, vals[R(row)], pos),
      /* ✓✗ 从画面中间放大出现，再飞进格子里；记下是哪一步得出的（点它时重演那一步）。
         默认带对错声；o = {quiet: true} 不出声（judge 里自己往表里盖时用，免得和逐项判断那一声同一拍响两次） */
      stamp(t, row, col, pos, o) {
        const r = R(row), c = M(col), m = marks[r][c];
        src[r][c] = K.cur;
        t.to(m, { autoAlpha: 1, scale: 3, duration: 0.28, ease: 'back.out(3)' }, pos);
        t.to(m, { x: 0, y: 0, scale: 1, duration: 0.6, ease: 'power3.inOut' }, pos + 0.5);
        if (!(o && o.quiet)) K.sfx(t, cfg.rows[r].ok[col] ? 'right' : 'wrong', pos);
      },
      pulse: (t, row, col, pos, s) => fx.pulse(t, marks[R(row)][M(col)], pos, s),
      /* 高亮框移到某一行 */
      focus: (t, row, pos) => t.to(hl, { y: R(row) * RH, duration: 0.45, ease: 'power3.inOut' }, pos),
      /* 答案那一行变绿，其余行压暗 */
      win(t, row, pos) {
        const r = R(row);
        t.to(hl, { y: r * RH, stroke: C.ok, fill: C.okSoft, duration: 0.45, ease: 'power3.inOut' }, pos);
        t.to(rowG.filter((_, i) => i !== r), { opacity: 0.4, duration: 0.4 }, pos);
      },
      /* 选项圆牌，贴在行的左边沿；同一行有几个就并排放小一点。pairs：[[选项, 行], ...]，返回 {选项: 圆牌} */
      badges(pairs) {
        const out = {};
        pairs.forEach(([k, row]) => {
          const same = pairs.filter((p) => p[1] === row), n = same.length, i = same.findIndex((p) => p[0] === k), r = R(row);
          const cx = X - 19 + (n > 1 ? 0.5 + (i - (n - 1) / 2) * 19 : 0);
          const p = D.pill(rowG[r], cx, BY(r) + 23, n > 1 ? 19 : 26, 26, C.acc, C.onAcc, k, 15);
          gsap.set(p.g, { autoAlpha: 0, scale: 0.4, transformOrigin: '50% 50%' }); out[k] = p.g;
        });
        return out;
      },
      /* 点表里的 ✓✗：把得出这一格的那一步重演一遍。extra(step) 再加一个条件（比如只在知识块自己的步骤里能点） */
      hots(extra) {
        marks.forEach((row, r) => row.forEach((m, c) => {
          const s0 = src[r][c]; if (!s0) return;
          K.hot(m, { hint: false, when: (s, i) => i >= K.indexOf(s0) && extra(s) && s.id !== s0, go: s0 });
        }));
      },
    };
    return B;
  }

  /* ================= where：这题在书里哪一块（照王道目录，字在知识块的 book 组） =================
     cfg：g 画在哪；sec、sub 哪一节、哪一小节亮（从 0 数）。 */
  function where(K, cfg) {
    const T = K.T, g = cfg.g, W1 = { x: 70, w: 860 };
    function chips(parent, list, y, size, lit) {
      let x = W1.x, row = 0; const out = [];
      list.forEach((s, i) => {
        const cg = E('g', null, parent);
        const t = tx(cg, 0, 0, size, C.muted, s);
        const w = t.getComputedTextLength() + 30, h = size + 24;
        if (x + w > W1.x + W1.w) { x = W1.x; row++; }
        const cy = y + row * (h + 12);
        const bg = E('rect', { x, y: cy, width: w, height: h, rx: 12, fill: C.surface, stroke: C.line });
        cg.insertBefore(bg, t); t.setAttribute('x', x + 15); t.setAttribute('y', cy + h / 2 + size * 0.36);
        let on = null, t2 = null;
        if (i === lit) {
          on = E('rect', { x, y: cy, width: w, height: h, rx: 12, fill: C.acc }, cg);
          t2 = tx(cg, x + 15, cy + h / 2 + size * 0.36, size, C.onAcc, s, { 'font-weight': 700 });
          gsap.set([on, t2], { autoAlpha: 0 });
        }
        gsap.set(cg, { autoAlpha: 0, y: 12, transformOrigin: '50% 50%' });
        out.push({ g: cg, on, t2, cx: x + w / 2, cy: cy + h / 2, bottom: cy + h });
        x += w + 12;
      });
      return out;
    }
    const S1 = cfg.sec, S2 = cfg.sub;
    const bot = (cs, d) => (cs.length ? Math.max.apply(null, cs.map((c) => c.bottom)) : d);
    const wBook = tx(g, W1.x, 86, 19, C.muted, T('book.name'));
    const wChap = tx(g, W1.x, 146, 40, C.ink, T('book.chapter'), { class: 'serif', 'font-weight': 700 });
    const wSecs = chips(g, T('book.secs'), 178, 20, S1);
    /* “小节”那一排跟着“节”实际占了几行往下排（只占一行时还在 270） */
    const wSubs = chips(g, T('book.subs'), 270 + bot(wSecs, 222) - 222, 19, S2);
    const subBottom = bot(wSubs, -Infinity);
    const wParts = chips(g, T('book.parts'), subBottom + 84, 22, -1);
    const wLink = D.arrow(g, { x: wSubs[S2].cx, y: wSubs[S2].bottom + 4 }, { x: wSubs[S2].cx, y: subBottom + 78 }, { color: C.acc, w: 2.6 });
    g.insertBefore(wLink.path, g.firstChild);   // 线压在芯片下面：小节折成两行时，线从下一行的芯片后面穿过去，不盖字
    const wPages = tx(g, W1.x + W1.w, 86, 19, C.acc, T('book.pages'), { 'text-anchor': 'end', class: 'mono', 'font-weight': 700 });
    hide0([wBook, wChap, wPages]);
    /* 整块太高、下沿超过 YMAX 时，所有东西（g 里现有的子元素）挪进一个组，以画面上沿正中为原点整体缩小 */
    const YMAX = 700, low = bot(wParts, 0);
    if (low > YMAX) {
      const s = (YMAX - 56) / (low - 56), z = E('g', { transform: `translate(500 56) scale(${s.toFixed(4)}) translate(-500 -56)` });
      while (g.firstChild) z.appendChild(g.firstChild);
      g.appendChild(z);
    }

    K.step('where', { sec: 'where' }, (t) => {
      fx.show(t, g, 0, 0.2);
      fx.show(t, [wBook, wChap], 0.1, 0.4);
      wSecs.forEach((c, i) => t.to(c.g, { autoAlpha: 1, y: 0, duration: 0.4, ease: 'power2.out' }, 0.45 + i * 0.09));
      t.to([wSecs[S1].on, wSecs[S1].t2], { autoAlpha: 1, duration: 0.3 }, 0.95); K.sfx(t, 'blip', 0.95);
      wSubs.forEach((c, i) => t.to(c.g, { autoAlpha: 1, y: 0, duration: 0.4, ease: 'power2.out' }, 1.2 + i * 0.06));
      t.to([wSubs[S2].on, wSubs[S2].t2], { autoAlpha: 1, duration: 0.3 }, 2.0); fx.pulse(t, wSubs[S2].g, 2.0, 1.1); K.sfx(t, 'blip', 2.0);
      fx.draw(t, wLink, 2.4, 0.35);
      wParts.forEach((c, i) => t.to(c.g, { autoAlpha: 1, y: 0, duration: 0.4, ease: 'back.out(1.6)' }, 2.7 + i * 0.12));
      fx.show(t, wPages, 3.1);
    });
  }

  /* 原卷里的上标，题库写成“2^8B”：数字^数字 的指数画成上标（小一号、抬高），别的字不动；没有上标的字和 tx 画得一模一样 */
  const SUP = /(\d)\^(\d+)/g;
  function rich(g, x, y, size, fill, s, extra) {
    if (typeof s !== 'string' || !s.match(SUP)) return tx(g, x, y, size, fill, s, extra);
    const t = tx(g, x, y, size, fill, '', extra), up = size * 0.38;
    let i = 0, m, hi = false;
    const add = (str, sup) => { if (!str) return; const a = sup ? { 'font-size': size * 0.68 } : {}; if (sup !== hi) { a.dy = sup ? -up : up; hi = sup; } E('tspan', a, t, str); };
    SUP.lastIndex = 0;
    while ((m = SUP.exec(s))) { add(s.slice(i, m.index) + m[1], false); add(m[2], true); i = SUP.lastIndex; }
    add(s.slice(i), false);
    return t;
  }

  /* 量一串字画出来有多宽（和真画的时候同一个父元素、同样的字号字重） */
  function textW(g, s, size, bold) {
    const t = tx(g, 0, 0, size, C.ink, s, { 'font-weight': bold ? 700 : 400 }), w = t.getComputedTextLength();
    t.remove(); return w;
  }
  /* 一行字折成两行：在合适的字之间折（标点后面、“的”“中”后面、“与和及并或以”前面优先；英文单词和数字不拆开），
     好折的地方里挑两行最匀的。两行放不下返回 null；force 为真时再试三行、四行。 */
  function split(g, s, size, bold, maxW, force) {
    const ch = Array.from(s), A = /[A-Za-z0-9+\-.\/]/, SP = /\s/, OPEN = /[（(「“‘《]/, CLOSE = /[，、。；：）)」”’》,;:]/;
    const ok = (i) => { const a = ch[i - 1], b = ch[i]; if (CLOSE.test(b) || OPEN.test(a)) return false; return SP.test(a) || SP.test(b) || !(A.test(a) || A.test(b)); };
    const good = (i) => CLOSE.test(ch[i - 1]) || /[的中]/.test(ch[i - 1]) || /[与和及并或以]/.test(ch[i]);
    const memo = {}, W = (a) => (a in memo ? memo[a] : (memo[a] = textW(g, a, size, bold)));
    /* 从第 from 个字起排成 n 行，返回 {cost, l}：cost 是最长一行占多少，好折的地方每处减 0.3 */
    function best(from, n) {
      const rest = ch.slice(from).join('').trim();
      if (n === 1) return rest && W(rest) <= maxW ? { cost: W(rest) / maxW, l: [rest] } : null;
      let b = null;
      for (let i = from + 1; i < ch.length; i++) {
        if (!ok(i)) continue;
        const a = ch.slice(from, i).join('').trim(); if (!a || W(a) > maxW) continue;
        const r = best(i, n - 1); if (!r) continue;
        const cost = Math.max(W(a) / maxW, r.cost + (good(i) ? 0.3 : 0)) - (good(i) ? 0.3 : 0);
        if (!b || cost < b.cost) b = { cost, l: [a].concat(r.l) };
      }
      return b;
    }
    for (let n = 2; n <= (force ? 4 : 2); n++) { const r = best(0, n); if (r) return r.l; }
    return force ? [s] : null;
  }

  /* ================= exams：真题怎么考（照书上的“考点追踪”，行名在 book.points） =================
     cfg：g 画在哪；points 每个考点考过哪几年；years [起, 止]；row、year 本题是哪一行哪一年（这一格画成白的并圈出来）。
       row 不填（或 null）：书上考点追踪里没有这一年，不圈、不加粗，表照常出。 */
  function exams(K, cfg) {
    const T = K.T, g = cfg.g, EX = cfg.points, ROW = cfg.row == null ? -1 : cfg.row;
    const Y0 = cfg.years[0], NY = cfg.years[1] - Y0 + 1, GX = 356, CW = 34, GY = 142, RH = 54;
    const exTitle = tx(g, 40, 74, 31, C.ink, T('exams.title'), { class: 'serif', 'font-weight': 700 });
    const exNote = tx(g, 40, 686, 15, C.faint, T('exams.note'));
    const exYears = E('g', null, g);
    for (let k = 0; k < NY; k++) tx(exYears, GX + k * CW + 14, GY - 14, 14, C.faint, String(Y0 + k).slice(2), { 'text-anchor': 'middle', class: 'mono' });
    const exRows = [], exLit = [];
    /* 考点名右对齐到表格左沿，左边至少留 MG。放不下的那一行折成两行（行高加 LH，年份格子在这一行里上下居中）；
       折成两行还放不下，整列的字号缩一档再排。原来放得下的表和以前一模一样。 */
    const names = T('book.points'), MG = 16, LH = 22, maxW = GX - 16 - MG;
    let fs = 17.5;
    const lay = (sz) => names.map((s, r) => { const b = r === ROW, w = textW(g, s, sz, b); return w <= maxW ? [s] : split(g, s, sz, b, maxW); });
    let lines = lay(fs);
    if (lines.some((l) => !l)) { fs = 15.5; lines = lay(fs).map((l, r) => l || split(g, names[r], fs, r === ROW, maxW, true)); }
    /* 行太多、表的下沿超过 LIM（下面还有一行注释）时：行距、格子高、字号按比例收一档（字号最小 14），整张表留在画布里。
       没超的表 k = 1，和以前一模一样。 */
    const LIM = 662, natural = lines.reduce((a, l) => a + RH + (l.length - 1) * LH, 0) - (RH - 36);
    let rh = RH, lh = LH, ch = 36, ty = 24;
    if (GY + natural > LIM) {
      const k = (LIM - GY) / natural;
      fs = Math.max(14, fs * k); rh = RH * k; lh = LH * k; ch = 36 * k; ty = ch / 2 + fs * 0.36;
      lines = lay(fs).map((l, r) => l || split(g, names[r], fs, r === ROW, maxW, true));
    }
    const rowY = [], cellDy = [];
    names.forEach((s, r) => { const ex = (lines[r].length - 1) * lh; rowY.push(r ? rowY[r - 1] + rh + (lines[r - 1].length - 1) * lh : GY); cellDy.push(ex / 2); });
    names.forEach((name, r) => {
      const rg = E('g', null, g), y = rowY[r] + cellDy[r], me = r === ROW, L = lines[r];
      L.forEach((s, i) => tx(rg, GX - 16, y + ty - (L.length - 1) * lh / 2 + i * lh, fs, me ? C.ink : C.ink2, s, { 'text-anchor': 'end', 'font-weight': me ? 700 : 400 }));
      for (let k = 0; k < NY; k++) E('rect', { x: GX + k * CW, y, width: 28, height: ch, rx: 8, fill: C.surface2 }, rg);
      EX[r].forEach((yr) => {
        const k = yr - Y0, c = E('rect', { x: GX + k * CW, y, width: 28, height: ch, rx: 8, fill: me && yr === cfg.year ? C.ink : C.acc }, rg);
        gsap.set(c, { autoAlpha: 0, scale: 0.3, transformOrigin: '50% 50%' }); exLit.push({ c, yr, r });
      });
      hide0(rg); exRows.push(rg);
    });
    /* 圈出本题那一格；不在考点追踪里（ROW = -1）就不圈 */
    const exRing = ROW < 0 ? null : E('rect', { x: GX + (cfg.year - Y0) * CW - 6, y: rowY[ROW] + cellDy[ROW] - 6, width: 40, height: ch + 12, rx: 12, fill: 'none', stroke: C.ink, 'stroke-width': 2.5 }, g);
    if (exRing) gsap.set(exRing, { autoAlpha: 0, scale: 1.6, transformOrigin: '50% 50%' });
    hide0([exTitle, exNote, exYears]);
    exLit.sort((a, b) => a.yr - b.yr || a.r - b.r);

    K.step('exams', { sec: 'exams' }, (t) => {
      K.view(t, g);
      fx.show(t, [exTitle, exYears], 0.3);
      t.to(exRows, { autoAlpha: 1, duration: 0.3, stagger: 0.06 }, 0.5);
      exLit.forEach((x, i) => { fx.pop(t, x.c, 1.2 + i * 0.09); if (i % 3 === 0) K.sfx(t, 'blip', 1.2 + i * 0.09); });
      if (exRing) t.to(exRing, { autoAlpha: 1, scale: 1, duration: 0.4, ease: 'back.out(2)' }, 1.2 + exLit.length * 0.09 + 0.2);
      else t.to({}, { duration: 0.4 }, 1.2 + exLit.length * 0.09 + 0.2);   // 不圈也占同样的时间，这一步长短不变
      fx.show(t, exNote, 3.2);
    });
  }

  /* ================= check + answer：四个选项逐项判断，然后揭晓答案 =================
     cfg（来自 q.json 的 check 段）：opts {选项: {row 对比表哪一行, pulse 闪哪几列的记号, verdict ok/no}}；
       选项说的东西不在对比表里（比如 2020-24 的“动态分区分配”）就写 {off: true, verdict}：高亮框退场，圆牌落在表的下面，旁边一句 check.off；
       order 选项顺序；need 题目要求的几个条件（check.<键>）；trapAt 到哪个选项时出陷阱提示条（check.trap）；answer、answerRow。
       pick: "false"：题目问“错误的是 / 不正确的是 / 不符合……的是”，要挑说法不成立的那一项。verdict 照旧是“选不选它”（ok = 本题答案），
         记号改成表示说法本身成不成立：要选的那项 ✗，其余 ✓（checkList 右边的记号、外壳左栏的记号都按这个）；
         声音照旧跟着 verdict 走：right = 找到要选的那项，wrong = 排除了一项。组合型（有 check.items）不认 pick，选项本身不是说法。
     hooks（知识块 build 的返回值）：board 对比表；leave(t) 进入逐项判断时知识块自己的收场；restore(t) 答案步里恢复的东西；
       area {g, x, w} 右上角放“题目要求 + 陷阱提示条”的地方；judge、final 见上面 judgeAt。 */
  /* 知识块插进逐项判断的口子（check 和 checkList 都认）：
     hooks.judge(t, k, p, o)：判选项 k 的那一步里调用。t 这一步的时间线，p 这一步里“开始判”的时刻，o 是 q.json 里这个选项的配置
       （组合型题目逐条判说法时 k 是 I、II…，o 是 {item: true, verdict}）。返回一个数 d 表示自己的动画占多长：
       下结论（✓✗、对错声、记号闪、陷阱提示条、理由）挪到 p + max(d, 0.8)；不返回就照旧在 p + 0.8。
     hooks.final(t, p)：答案那一步里调用，p 是“答案行变绿”的时刻；返回 d 时，答案那行字和完成声挪到 p + max(d, 0.35)。
     返回下结论的时刻。 */
  function judgeAt(hooks, t, k, p, o) {
    const d = typeof hooks.judge === 'function' ? hooks.judge(t, k, p, o) : null;
    return p + (typeof d === 'number' && isFinite(d) ? Math.max(d, 0.8) : 0.8);
  }
  function finalAt(hooks, t, p) {
    const d = typeof hooks.final === 'function' ? hooks.final(t, p) : null;
    return p + (typeof d === 'number' && isFinite(d) ? Math.max(d, 0.35) : 0.35);
  }

  function check(K, cfg, hooks) {
    const T = K.T, Bd = hooks.board, A = hooks.area, RX = A.x, RW = A.w;
    const badge = Bd.badges(cfg.order.filter((k) => !cfg.opts[k].off).map((k) => [k, cfg.opts[k].row]));
    /* 不在表里的选项：圆牌和一句说明放在表的下面 */
    const offG = {};
    cfg.order.filter((k) => cfg.opts[k].off).forEach((k) => {
      const g = E('g', null, A.g), y = Bd.bottom + 34;
      badge[k] = D.pill(g, RX + 13, y, 26, 26, C.acc, C.onAcc, k, 15).g;
      const note = tx(g, RX + 38, y + 7, 20, C.ink2, T('check.off'));
      gsap.set(badge[k], { autoAlpha: 0, scale: 0.4, transformOrigin: '50% 50%' }); hide0(note); offG[k] = note;
    });
    let boxGone = false;   // 高亮框是不是被上一个“表外选项”收走了
    const gNeed = E('g', null, A.g);
    tx(gNeed, RX, 92, 23, C.ink, T('check.need'), { 'font-weight': 700 });
    let nx = RX; const needChips = cfg.need.map((k, i) => {
      const g = E('g', null, gNeed), t = tx(g, 0, 143, 20, C.acc, T('check.' + k), { 'font-weight': 700 }), w = t.getComputedTextLength() + 66;
      g.insertBefore(E('rect', { x: nx, y: 114, width: w, height: 44, rx: 22, fill: C.accSoft, stroke: C.acc, 'stroke-width': 1.5 }), t);
      tx(g, nx + 24, 143, 19, C.acc, '①②③④'[i], { 'text-anchor': 'middle' }); t.setAttribute('x', nx + 45);
      gsap.set(g, { autoAlpha: 0, scale: 0.8, transformOrigin: '50% 50%' }); nx += w + 14; return g;
    });
    const gTrap = E('g', null, A.g), AMB = '#d9a441';
    E('rect', { x: RX, y: 188, width: RW, height: 92, rx: 13, fill: '#2b2418', stroke: AMB, 'stroke-width': 1.5 }, gTrap);
    E('path', { d: `M${RX + 32},210 L${RX + 50},242 L${RX + 14},242 Z`, fill: 'none', stroke: AMB, 'stroke-width': 2.4, 'stroke-linejoin': 'round' }, gTrap);
    tx(gTrap, RX + 32, 237, 16, AMB, '!', { 'text-anchor': 'middle', 'font-weight': 700 });
    [].concat(T('check.trap')).forEach((s, i) => tx(gTrap, RX + 66, 225 + i * 33, 19, C.ink, s));
    gsap.set(gTrap, { autoAlpha: 0, y: 10 });
    /* 答案那行字：表下面有“表外选项”的说明时，往下让一行 */
    const answer = tx(A.g, RX, A.ansY || (Object.keys(offG).length ? 668 : 642), 25, C.ok, T('check.answer'), { 'font-weight': 700 });
    hide0([gNeed, answer]);

    cfg.order.forEach((k, n) => {
      const o = cfg.opts[k], ok = o.verdict === 'ok', trap = k === cfg.trapAt;
      K.step('o_' + k, { sec: 'check', opt: k, verdict: o.verdict }, (t) => {
        let p = 0.15;
        if (n === 0) {
          hooks.leave(t);
          fx.show(t, gNeed, 0.5); needChips.forEach((c, i) => fx.pop(t, c, 0.8 + i * 0.25));
          p = 1.5;
        }
        if (o.off) {
          fx.hide(t, Bd.hl, p, 0.3); boxGone = true;
          fx.pop(t, badge[k], p + 0.35); fx.show(t, offG[k], p + 0.6);
        } else {
          if (boxGone) { fx.show(t, Bd.hl, p, 0.25); boxGone = false; }
          Bd.focus(t, o.row, p);
          fx.pop(t, badge[k], p + 0.35);
        }
        const v = judgeAt(hooks, t, k, p, o);   // 下结论的时刻：知识块自己的判法演完之后；没有就是 p + 0.8
        if (!o.off) o.pulse.forEach((c, i) => Bd.pulse(t, o.row, c, v + i * 0.18, 1.7));
        K.sfx(t, ok ? 'right' : 'wrong', v);
        if (trap) t.to(gTrap, { autoAlpha: 1, y: 0, duration: 0.4, ease: 'power2.out' }, v + 0.5);
        t.to({}, { duration: 0.2 }, v + (trap ? 1.0 : 0.65));
      });
    });

    K.step('answer', { sec: 'answer', answer: true }, (t) => {
      if (boxGone) fx.show(t, Bd.hl, 0, 0.25);
      Bd.win(t, cfg.answerRow, 0.1);
      hooks.restore(t);
      const v = finalAt(hooks, t, 0.1);
      fx.show(t, answer, v); K.sfx(t, 'done', v);
      fx.pulse(t, badge[cfg.answer], v + 0.15, 1.5);
      t.to({}, { duration: 0.3 }, v + 0.75);
    });
  }

  /* ================= 不靠对比表的逐项判断：选项排成几行，一行一行判 =================
     知识块没交出对比表（hooks 里没有 board）时用这个。每行：选项字母、选项原文（q.opts.<k>）、✓✗、一句理由（check.why.<k>）。
     组合型选项（题干列了 I、II… 几条说法）：cfg.items {I: 'ok'/'no', …} 先逐条判说法（步骤 s_I…，原文 q.items.<k>），再判选项。
     cfg.opts.<k>.at 写知识块某一步的名字：判这个选项时，上方先闪回那一步书页上框出的地方（hooks.peek 给图和框）。 */
  let maskN = 0;   // 遮罩、裁剪的 id 编号（同一页里不能重名）
  function checkList(K, cfg, hooks, g) {
    const T = K.T, items = cfg.items ? Object.keys(cfg.items) : [], pf = cfg.pick === 'false' && !items.length;   // pf：挑不成立的那一项，选项行的记号表示说法成不成立
    const rows = items.map((k) => ({ k, item: true, verdict: cfg.items[k] }))
      .concat(cfg.order.map((k) => ({ k, verdict: cfg.opts[k].verdict, at: cfg.opts[k].at })));
    const peeks = {};
    rows.forEach((r) => { const p = r.at && hooks.peek && hooks.peek(r.at); if (p) peeks[r.k] = p; });
    const n = rows.length, many = n > 4, RH = many ? 66 : 104, X = 40, RW = 920, ANS = 52, GAP = items.length ? 14 : 0;
    /* 闪回的小图放在上方一条里；行太多、上方放不下一张看得清的图时，小图临时盖在“说法”那几行上，闪一下就收 */
    let band = Object.keys(peeks).length ? Math.min(220, 720 - 24 - n * RH - GAP - ANS - 12) : 0;
    const over = band > 0 && band < 150; if (over) band = 0;
    const Y0 = band ? 24 + band + 12 : Math.max(24, (720 - ANS - n * RH - GAP) / 2);
    const rowY = (i) => Y0 + i * RH + (items.length && i >= items.length ? GAP : 0);
    const TA = over ? { y: Y0, h: rowY(items.length || n) - GAP - Y0 - 10 } : { y: 24, h: band };
    const H = RH - 10, rowG = [], badges = [], marks = [], whys = [];
    rows.forEach((r, i) => {
      const y = rowY(i), rg = E('g', null, g), ok = (r.verdict === 'ok') !== pf;   // ok 这里是“记号打 ✓”：挑不成立的那项时反过来
      E('rect', { x: X, y, width: RW, height: H, rx: 12, fill: C.surface, stroke: C.line }, rg);
      const b = D.pill(rg, X + 36, y + (many ? 22 : 33), r.item ? 44 : 32, 30, C.acc, C.onAcc, r.k, 16);
      gsap.set(b.g, { transformOrigin: '50% 50%' }); badges.push(b.g);
      rich(rg, X + 72, y + (many ? 28 : 41), many ? 21 : 25, C.ink, T((r.item ? 'q.items.' : 'q.opts.') + r.k), { 'font-weight': 700 });
      const w = tx(rg, X + 72, y + (many ? 50 : 76), many ? 17 : 20, C.ink2, T('check.why.' + r.k));
      gsap.set(w, { autoAlpha: 0, y: 6 }); whys.push(w);
      const m = tx(rg, X + RW - 46, y + H / 2 + (many ? 11 : 14), many ? 32 : 40, ok ? C.ok : C.no, ok ? '✓' : '✗', { 'text-anchor': 'middle', 'font-weight': 700 });
      gsap.set(m, { autoAlpha: 0, scale: 2.6, transformOrigin: '50% 50%' }); marks.push(m);
      hide0(rg); rowG.push(rg);
    });
    const hl = E('rect', { x: X, y: rowY(0), width: RW, height: H, rx: 12, fill: 'rgba(224,138,105,.10)', stroke: C.acc, 'stroke-width': 2.2, 'pointer-events': 'none' }, g);
    /* 闪回的书页小图：只放框出的那一块，框照原样画上 */
    const thumbs = {};
    Object.keys(peeks).forEach((k) => {
      const p = peeks[k], R = p.region;
      /* 取景往外多留一点：框贴字以后框线在字外一个边距处，不留的话框边被小图边切掉。左右各 2.5 个边距；上下各约 1.8 个（够放下框线，上下两行最多露一丝，且被压暗） */
      const s0 = Math.min(RW / (R[2] * p.w), (TA.h - 12) / (R[3] * p.h)), on = Kit.read && Kit.read.frames, ex = on ? 12.5 / s0 : 0, ey = on ? 9 / s0 : 0;
      const rx = R[0] * p.w - ex, ry = R[1] * p.h - ey, rw = R[2] * p.w + 2 * ex, rh = R[3] * p.h + 2 * ey;
      const s = Math.min(RW / rw, (TA.h - 12) / rh), tw = rw * s, th = rh * s, x0 = 500 - tw / 2, y0 = TA.y + (TA.h - th) / 2;
      const tg = E('g', null, g);
      if (over) E('rect', { x: X - 10, y: TA.y - 8, width: RW + 20, height: TA.h + 16, rx: 14, fill: C.bg, opacity: 0.97 }, tg);
      E('rect', { x: x0 - 6, y: y0 - 6, width: tw + 12, height: th + 12, rx: 10, fill: p.paper || C.surface2, stroke: C.line }, tg);
      const sv = E('svg', { x: x0, y: y0, width: tw, height: th, viewBox: `${rx} ${ry} ${rw} ${rh}` }, tg);
      E('image', { href: p.src, x: 0, y: 0, width: p.w, height: p.h, preserveAspectRatio: 'none' }, sv);
      const bx = (b) => ({ x: b[0] * p.w - 5 / s, y: b[1] * p.h - 5 / s, width: b[2] * p.w + 10 / s, height: b[3] * p.h + 10 / s, rx: 6 / s });
      const mid = 'lpeek' + (++maskN), mk = E('mask', { id: mid, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: p.w, height: p.h }, E('defs', null, sv));   // 框外压暗，和书页那一步一样
      E('rect', { x: 0, y: 0, width: p.w, height: p.h, fill: '#fff' }, mk);
      const FRk = Kit.read && Kit.read.frames;
      let fr;
      if (FRk) {   // 和书页那一步同一种框（kit/read.js 的 Kit.read.frames）：贴字、相邻几行合成一个轮廓
        E('rect', { x: 0, y: 0, width: p.w, height: p.h, fill: '#0b0b0a', opacity: 0.55, mask: `url(#${mid})` }, sv);
        const m = { ox: 0, oy: 0, w: p.w, h: p.h, pad: 5 / s, s }, F = FRk.set(sv, mk, p.boxes.length, { sw: 2.6, rad: 6 / s, gap: 9 / s });
        F.draw(p.boxes.map((b) => FRk.raw(b, m)));
        FRk.ink(p.src).then((I) => { if (I) F.draw(p.boxes.map((b) => FRk.snap(I, b, m))); });
        fr = F.lines;
      } else {
        p.boxes.forEach((b) => E('rect', Object.assign(bx(b), { fill: '#000' }), mk));
        E('rect', { x: 0, y: 0, width: p.w, height: p.h, fill: '#0b0b0a', opacity: 0.55, mask: `url(#${mid})` }, sv);
        fr = p.boxes.map((b) => E('rect', Object.assign(bx(b), { fill: 'none', stroke: C.acc, 'stroke-width': 2.6, 'vector-effect': 'non-scaling-stroke' }), sv));
      }
      gsap.set(tg, { autoAlpha: 0, scale: 0.92, transformOrigin: '50% 50%' }); gsap.set(fr, { autoAlpha: 0 });
      thumbs[k] = { g: tg, fr };
    });
    const answer = tx(g, X, 720 - 20, 25, C.ok, T('check.answer'), { 'font-weight': 700 });
    hide0([hl, answer]);
    const hideThumbs = (t, but, pos) => Object.keys(thumbs).forEach((k) => { if (k !== but) fx.hide(t, thumbs[k].g, pos); });

    rows.forEach((r, i) => {
      const ok = r.verdict === 'ok', th = thumbs[r.k];
      const meta = r.item ? { sec: 'check', item: r.k, verdict: r.verdict } : { sec: 'check', opt: r.k, verdict: r.verdict };
      K.step((r.item ? 's_' : 'o_') + r.k, meta, (t) => {
        let p = 0.15;
        if (i === 0) {
          if (hooks.leave) hooks.leave(t);
          K.view(t, g);
          t.to(rowG, { autoAlpha: 0.35, duration: 0.3, stagger: 0.07 }, 0.4);
          fx.show(t, hl, 0.9); p = 1.1;
        }
        hideThumbs(t, r.k, 0.05);
        if (th) {
          fx.pop(t, th.g, p); t.to(th.fr, { autoAlpha: 1, duration: 0.2 }, p + 0.35);
          th.fr.forEach((f) => t.fromTo(f, { attr: { 'stroke-width': 2.6 } }, { attr: { 'stroke-width': 6 }, duration: 0.16, yoyo: true, repeat: 1 }, p + 0.45));
          K.sfx(t, 'blip', p + 0.4);
          if (over) { fx.hide(t, th.g, p + 1.7); p += 1.95; } else p += 0.95;
        }
        t.to(hl, { y: rowY(i) - rowY(0), duration: 0.45, ease: 'power3.inOut' }, p);
        t.to(rowG[i], { autoAlpha: 1, duration: 0.3 }, p);
        fx.pulse(t, badges[i], p + 0.35, 1.25);
        const v = judgeAt(hooks, t, r.k, p, r.item ? { item: true, verdict: r.verdict } : cfg.opts[r.k]);
        t.to(marks[i], { autoAlpha: 1, scale: 1, duration: 0.45, ease: 'back.out(2.4)' }, v);
        K.sfx(t, ok ? 'right' : 'wrong', v);
        t.to(whys[i], { autoAlpha: 1, y: 0, duration: 0.3 }, v + 0.2);
        t.to({}, { duration: 0.2 }, v + 0.65);
      });
    });

    K.step('answer', { sec: 'answer', answer: true }, (t) => {
      const ai = rows.findIndex((r) => !r.item && r.k === cfg.answer);
      hideThumbs(t, null, 0);
      t.to(hl, { y: rowY(ai) - rowY(0), stroke: C.ok, fill: C.okSoft, duration: 0.45, ease: 'power3.inOut' }, 0.1);
      t.to(rowG.filter((_, j) => j !== ai), { opacity: 0.4, duration: 0.4 }, 0.1);
      if (hooks.restore) hooks.restore(t);
      const v = finalAt(hooks, t, 0.1);
      fx.show(t, answer, v); K.sfx(t, 'done', v);
      fx.pulse(t, badges[ai], v + 0.15, 1.5);
      t.to({}, { duration: 0.3 }, v + 0.75);
    });
  }

  /* ================= 轻量知识块：书上原图加标注 =================
     不写画面代码，用数据描述：units/<块>/unit.js 里只写 Kit.unit('<块>', Kit.light({...}))。
     d.where / points / years / book 和完整知识块一样（points 可以是空的：整页就没有“真题怎么考”）；
     d.pages {名字: {src, w, h}}：舞台上用的书页图（tools/bookpage.py 做的深色图）和它的像素宽高；
     d.steps [{id, sec, page, boxes, zoom, peek}]：每一步用哪张图、框哪几处、要不要先推近。
       boxes [[x, y, w, h], …] 和 zoom [x, y, w, h] 都是占这张图宽高的比例（0–1）；
       sec 进度条上的段名（sec.<sec>），不写就沿用上一步；peek 闪回时小图取哪一块，不写就是这一步所有框合起来的那一块（上下各留最矮那个框高的四分之一，不带上下两行的半截字）。
       镜头几页共用：换页时先回到整页，新的一步写了 zoom 再推过去。
     字照旧：steps.<id>.cap / .h。 */
  function light(d) {
    const cs = document.currentScript, base = cs ? cs.src.replace(/[^/]*$/, '') : '';   // 图片地址从 unit.js 所在的目录算
    let sec = 'book';
    d.steps.forEach((s) => { s.sec = s.sec || sec; sec = s.sec; });
    const ids = {}; d.steps.forEach((s, i) => { ids[s.id] = i; });
    const union = (bs) => {
      const x0 = Math.min.apply(null, bs.map((b) => b[0])), y0 = Math.min.apply(null, bs.map((b) => b[1]));
      const x1 = Math.max.apply(null, bs.map((b) => b[0] + b[2])), y1 = Math.max.apply(null, bs.map((b) => b[1] + b[3]));
      return [x0, y0, x1 - x0, y1 - y0];
    };
    return {
      secs: d.steps.map((s) => s.sec).filter((s, i, a) => a.indexOf(s) === i),
      where: d.where, points: d.points || [], years: d.years || [2009, 2026], book: d.book || [],
      build(K, U) {
        const g = U.g, AREA = { x: 30, y: 30, w: 940, h: 660 }, PAD = 6, ZMAX = 2.2, DIM = 0.62;
        const ID = { x: 0, y: 0, s: 1 };
        const pk = E('g', { 'data-cam': 'poke' }, g), cam = E('g', { 'data-cam': 'step' }, pk);   // pk：点区域时的推近；cam：每一步自己的推近。分两层，互不打架
        gsap.set([pk, cam], { svgOrigin: '0 0', x: 0, y: 0, scale: 1 });
        const cid = 'lclip' + (++maskN);   // 推近时书页不能溢出画布，盖到左栏和进度条上
        E('rect', { x: 0, y: 0, width: 1000, height: 720 }, E('clipPath', { id: cid }, E('defs', null, g)));
        g.setAttribute('clip-path', `url(#${cid})`);
        /* 把舞台上的一块 r 推到画面正中、尽量放大 */
        const fit = (r) => { const s = Math.min(AREA.w / r.w, AREA.h / r.h, ZMAX); return { x: 500 - s * (r.x + r.w / 2), y: 360 - s * (r.y + r.h / 2), s }; };
        const P = {};
        Object.keys(d.pages).forEach((name) => {
          const pg = d.pages[name], k = Math.min(AREA.w / pg.w, AREA.h / pg.h), dw = pg.w * k, dh = pg.h * k;
          const ox = AREA.x + (AREA.w - dw) / 2, oy = AREA.y + (AREA.h - dh) / 2;
          const pgG = E('g', null, cam), mid = 'lmask' + (++maskN);
          const mask = E('mask', { id: mid, maskUnits: 'userSpaceOnUse', x: ox - 30, y: oy - 30, width: dw + 60, height: dh + 60 }, E('defs', null, pgG));
          E('rect', { x: ox - 30, y: oy - 30, width: dw + 60, height: dh + 60, fill: '#fff' }, mask);
          E('image', { href: base + pg.src, x: ox, y: oy, width: dw, height: dh, preserveAspectRatio: 'none' }, pgG);
          const dim = E('rect', { x: ox - 1, y: oy - 1, width: dw + 2, height: dh + 2, fill: '#0b0b0a', mask: `url(#${mid})`, 'pointer-events': 'none' }, pgG);
          /* 框（2026-11-22 起用 kit/read.js 的 Kit.read.frames）：每一步一套轮廓 + 遮罩上的洞，贴字、相邻的合成一个，换步整套换；离开这页时收干净 */
          const map = { ox, oy, w: dw, h: dh, pad: PAD }, FR = Kit.read && Kit.read.frames;
          const toS = (b) => ({ x: ox + b[0] * dw - PAD, y: oy + b[1] * dh - PAD, w: b[2] * dw + 2 * PAD, h: b[3] * dh + 2 * PAD });
          gsap.set(dim, { opacity: 0 }); hide0(pgG);
          P[name] = { pg, pgG, dim, mask, map, src: base + pg.src, toS, regions: {}, FR };
        });

        /* ---- 每一步：换页、推近、框换成这一步的那一套 ---- */
        const frOn = (t, F, p) => { if (!F) return; t.set(F.lines, { scale: 1.035, transformOrigin: '50% 50%' }, p); t.to(F.lines, { autoAlpha: 1, scale: 1, duration: 0.4, ease: 'power3.out' }, p); t.to(F.holes, { opacity: 1, duration: 0.35 }, p); };
        const frOff = (t, F, p, d) => { if (!F) return; t.to(F.lines, { autoAlpha: 0, duration: d == null ? 0.2 : d }, p); t.to(F.holes, { opacity: 0, duration: d == null ? 0.25 : d }, p); };
        let prev = null;
        d.steps.forEach((s, i) => {
          const pp = P[s.page], rs = (s.boxes || []).map(pp.toS), FR = pp.FR;
          const z = s.zoom ? fit(FR ? FR.cover(pp.toS(s.zoom), rs, 10) : pp.toS(s.zoom)) : ID, last = prev;
          /* 这一步的那套框：先按原样画，书页像素读好以后换成贴字、合并好的轮廓 */
          let F = null;
          if (rs.length && FR) {
            F = FR.set(pp.pgG, pp.mask, rs.length); F.draw(rs);
            gsap.set(F.lines, { autoAlpha: 0 }); gsap.set(F.holes, { opacity: 0 });
            const m = Object.assign({}, pp.map, { s: z.s });
            FR.ink(pp.src).then((I) => { if (I) F.draw(s.boxes.map((b) => FR.snap(I, b, m))); });
          }
          K.step(s.id, { sec: s.sec }, (t) => {
            let p = 0.15;
            const turn = i > 0 && last.page !== s.page;
            if (i === 0) { K.view(t, g); fx.show(t, pp.pgG, 0.25, 0.4); p = 0.75; }
            else if (turn) {
              fx.hide(t, P[last.page].pgG, 0); fx.show(t, pp.pgG, 0.25, 0.4); p = 0.75;
              frOff(t, last.F, 0.24, 0); if (last.rs.length) t.set(P[last.page].dim, { opacity: 0 }, 0.24);   // 旧页收干净，回到它时从干净的样子开始
            }
            /* 镜头是几页共用的：换页时旧页收掉以后镜头先回到整页（上一步推近着也一样），新页要推近再从整页推过去 */
            const lz = last ? last.z : ID, moved = (a, b) => a.x !== b.x || a.y !== b.y || a.s !== b.s;
            if (turn && moved(lz, ID)) t.set(cam, { x: 0, y: 0, scale: 1 }, 0.22);
            if (moved(z, turn ? ID : lz)) { fx.cam(t, cam, z, i === 0 ? 0.3 : turn && moved(lz, ID) ? 0.25 : 0.1); p = Math.max(p, 0.65); }
            const was = last && !turn ? last : null;
            if (was) frOff(t, was.F, p);
            frOn(t, F, p + (was && was.F ? 0.12 : 0));
            if (rs.length || (was && was.rs.length)) t.to(pp.dim, { opacity: rs.length ? DIM : 0, duration: 0.35 }, p);
            if (rs.length) K.sfx(t, 'blip', p);
            t.to({}, { duration: 0.2 }, p + 0.75);
          });
          rs.forEach((r, j) => { const key = s.boxes[j].join(','); if (!(key in pp.regions)) pp.regions[key] = { r, from: i }; });
          prev = { page: s.page, z, rs, F };
        });

        /* ---- 能点的地方：被框过的区域，点了推近；推近以后点空白回到整页 ---- */
        const here = (st) => (st && st.id in ids ? d.steps[ids[st.id]] : null);
        let gen = 0, zin = false;   // zin：现在是不是点区域推近着。推近着的时候区域都不接点击，点哪都是“空白”，回到整页
        /* 收尾：换步、拖动时把推近撤掉。画面放到微任务里撤：紧接着点的是“空白”时不跳，从当前位置平滑拉回 */
        const settle = (my, extra) => () => { if (extra) extra.remove(); zin = false; Promise.resolve().then(() => { if (gen === my) { gsap.killTweensOf(pk); gsap.set(pk, { x: 0, y: 0, scale: 1 }); } }); };
        Object.keys(P).forEach((name) => {
          const pp = P[name];
          const back = E('rect', { x: -3000, y: -3000, width: 7000, height: 7000, fill: 'transparent' }, pp.pgG);   // “空白”：盖在书页上、压在区域下面，推近以后点它回到整页
          K.hot(back, { hint: false, when: (st) => { const h = here(st); return zin && !!h && h.page === name; }, run(t) { const my = ++gen; fx.cam(t, pk, ID, 0, 0.55); return settle(my); } });
          Object.keys(pp.regions).forEach((key) => {
            const R = pp.regions[key], el = E('rect', { x: R.r.x, y: R.r.y, width: R.r.w, height: R.r.h, fill: 'transparent' }, pp.pgG);
            K.hot(el, {
              /* 还没框到的区域、推近着的时候，区域不接点击（不然会挡住下面的“空白”） */
              when: (st) => { const h = here(st), ok = !zin && !!h && h.page === name && ids[h.id] >= R.from; el.style.pointerEvents = ok ? '' : 'none'; return ok; },
              run(t, st) {
                const my = ++gen; zin = true;
                const c = { x: gsap.getProperty(cam, 'x'), y: gsap.getProperty(cam, 'y'), s: gsap.getProperty(cam, 'scale') };
                const Z = fit(R.r), sp = Z.s / c.s;   // 要的总效果 Z = pk ∘ cam，所以 pk = Z ∘ cam⁻¹
                fx.cam(t, pk, { x: Z.x - sp * c.x, y: Z.y - sp * c.y, s: sp }, 0, 0.6);
                const ring = E('rect', { x: R.r.x, y: R.r.y, width: R.r.w, height: R.r.h, rx: 8, fill: 'none', stroke: C.ink, 'stroke-width': 2.4, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }, pp.pgG);
                gsap.set(ring, { autoAlpha: 0 }); t.to(ring, { autoAlpha: 1, duration: 0.2 }, 0.45).to(ring, { autoAlpha: 0, duration: 0.5 }, 1.1);
                K.sfx(t, 'blip', 0.1);
                return settle(my, ring);
              },
            });
          });
        });

        return {
          /* 逐项判断时闪回：某一步的书页、框和取景范围 */
          peek(id) {
            const s = d.steps[ids[id]]; if (!s || !s.boxes || !s.boxes.length) return null;
            const pg = d.pages[s.page], m = 0.015;
            if (s.peek) return { src: base + pg.src, w: pg.w, h: pg.h, boxes: s.boxes, paper: d.paper || '#242320', region: [s.peek[0] - m, s.peek[1] - m * pg.w / pg.h, s.peek[2] + 2 * m, s.peek[3] + 2 * m * pg.w / pg.h] };
            const u = union(s.boxes), mv = 0.25 * Math.min.apply(null, s.boxes.map((b) => b[3]));   // 上下各留最矮那个框高的四分之一
            return { src: base + pg.src, w: pg.w, h: pg.h, boxes: s.boxes, paper: d.paper || '#242320', region: [u[0] - m, u[1] - mv, u[2] + 2 * m, u[3] + 2 * mv] };
          },
        };
      },
    };
  }

  /* ================= 拼成一页 =================
     三块画面（书目位置、知识块、真题年份表）各一组，同一时间只显示一组；K.view(t, g) 切到 g 那一组。
     知识块没有考点追踪（points 为空）就不出“真题怎么考”；没有对比表就用 checkList，多一组画面。 */
  function lesson(K, q, unit) {
    const scr = [0, 1, 2].map(() => E('g', null, K.svg)); hide0(scr);
    K.view = (t, g, pos) => { scr.forEach((x) => { if (x !== g) fx.hide(t, x, pos || 0, 0.25); }); fx.show(t, g, (pos || 0) + 0.2, 0.3); };
    where(K, Object.assign({ g: scr[0] }, unit.where));
    const hooks = unit.build(K, { g: scr[1] });
    if (unit.points && unit.points.length) exams(K, { g: scr[2], points: unit.points, years: unit.years, row: (q.exams || {}).row, year: q.year });
    /* 本题演算：知识块带 solve、题目带 solve 数据时，用这道题的数据把过程演一遍。步骤的 sec 写 'solve'，画在知识块自己的那组画面上。
       solve 可以直接往 hooks 上挂东西，也可以返回一个对象（比如 {judge, final}），合并进 hooks */
    if (unit.solve && q.solve) { const r = unit.solve(K, hooks, q.solve, q); if (r && typeof r === 'object' && r !== hooks) Object.assign(hooks, r); }
    const cfg = Object.assign({ order: q.opts, answer: q.answer }, q.check);
    let chk = scr[1];
    if (hooks.board) check(K, cfg, hooks);
    else { const g = E('g', null, K.svg); hide0(g); scr.push(g); checkList(K, cfg, hooks, g); chk = g; }
    /* 新讲法（kit/xin.js）要知道这几组画面各是哪一组，好在跳着用步骤时先切到那一组 */
    return { scr, chk, view: K.view };
  }

  Kit.board = board;
  Kit.light = light;
  Kit.sections = { where, exams, check, checkList, lesson };
})();
