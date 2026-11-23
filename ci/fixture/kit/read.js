/* kit/read.js：读题。开讲前（还没点答案、还没点“写完了”）左栏多一个“读题”入口：题干一句一句亮出来，右边原卷图上框出这句对应的那一块，
   每句配底部一行说明（这句话什么意思、术语和记号指什么、对应图上哪一块、给的数是干什么用的）。只讲题目在说什么，不讲解法、不泄答案。
   看完（最后一步再往下走）或点右上角 × 回到开讲前；读题不进做题记录，不发 /state，不记停在哪一步。
   题目文件夹里两个文件，没有 read.json 的题不出入口：
     read.json  {pages, steps}（格式和例子见 design/任务书_做页.md 末尾“读题怎么做”）
       pages  可以不写：默认一张 "q" = 题目文件夹里的 q_dark.png，没有就用 q.png 反色压暗。别的图写 {名: {src}}，src 从题目文件夹算
       steps  每一步 {id: "rd1"…, stem, opt, page, boxes, zoom, fig}
         stem   左栏题干里亮哪一句：题干原文的子串（408 选择题是 q.json 的 text.q.stem，数学题是 stemTex，含 $，一字不差）；
                几处写数组；同一子串要亮第 n 处写 {"tex": "…", "n": 2}。不同步的子串可以一样、可以一个套一个，不能交叉。
                综合题左栏是原卷图，stem 照样写（text.q.stem 的子串），只给文字员看、给检查用，不上画面
         opt    左栏亮哪个选项（"A" 或 ["A", "C"]），讲选项在说什么时用
         page   右边用哪张图（不写沿用上一步；第一步默认 pages 里的第一张）
         boxes  图上框几块、别处压暗：[[x, y, w, h], …]，占这张图宽高的比例（和 Kit.light 一样）
         zoom   先推近到哪一块 [x, y, w, h]（比例）；不写就看整张
         fig    数学题有 figure 时：这一步图上哪些部分出现 / 变亮，写法同推导步的 fig（{on, lit}，不写沿用上一步）。
                有一步写了 fig，原卷图排在上面一条、图排在下面
     read.text.json  {"steps": {"rd1": {"h", "cap"}, …}}：这段读题的字（Gemini 写）；进度条上的段名 sec.read、入口 ui.read.go 在 kit/ui.json */
(function () {
  'use strict';
  const E = Kit.E, C = Kit.C, fx = Kit.fx;
  const getJSON = (u) => fetch(u + '?t=' + Date.now()).then((r) => (r.ok ? r.json() : Promise.reject(new Error(u + ' ' + r.status))));
  const size = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight }); im.onerror = () => rej(new Error(src)); im.src = src; });
  const warn = (...a) => { R.warnings.push(a.join(' ')); console.warn('[read]', ...a); };
  let maskN = 0;

  /* 这道题有没有读题：只看 read.json 在不在 */
  const can = (id) => fetch('questions/' + id + '/read.json?t=' + Date.now(), { method: 'GET' }).then((r) => r.ok).catch(() => false);

  /* 读齐 read.json、read.text.json，量好每张图的像素宽高。读不出来就抛错，原来那一页不动 */
  /* ex（新讲法用，可不传）：lesson.json 里另加的图和画面 {pages, steps}，接在 read.json 后面（数学题拿书页裁图当知识段的画面） */
  async function load(id, ex) {
    const qb = 'questions/' + id + '/';
    let man = await getJSON(qb + 'read.json');
    if (ex && (ex.pages || ex.steps)) man = Object.assign({}, man, { pages: Object.assign({}, man.pages || { q: null }, ex.pages || {}), steps: (man.steps || []).concat(ex.steps || []) });
    const text = await getJSON(qb + 'read.text.json').catch(() => ({}));
    const pages = {}, want = man.pages || { q: null };
    for (const name of Object.keys(want)) {
      const p = want[name];
      if (p && p.src) { pages[name] = Object.assign({ src: qb + p.src }, await size(qb + p.src)); continue; }
      try { pages[name] = Object.assign({ src: qb + 'q_dark.png' }, await size(qb + 'q_dark.png')); }
      catch (e) { pages[name] = Object.assign({ src: qb + 'q.png', invert: true }, await size(qb + 'q.png')); }   // 白底原卷：反色压暗
    }
    return { id, qb, man, text, pages };
  }

  /* ================= 左栏题干：哪一句亮 =================
     在题干原文里插不显示的记号（私用区字符：开 U+E100+k，关 U+E300+k），照常排好以后再把记号换成 <span class="rdq rdqk">。
     数学题的 $…$ 里不能插字符，那一段用 \htmlClass{rdqk}{…} 包（KaTeX 排出来就是带这个类名的一块）。 */
  const OPEN = 0xE100, CLOSE = 0xE300, SENT = new RegExp('[' + String.fromCharCode(0xE100) + '-' + String.fromCharCode(0xE4FF) + ']', 'g');
  const sub = (m) => (typeof m === 'string' ? { tex: m, n: 1 } : { tex: m.tex, n: m.n || 1 });
  /* 每步的 stem → 题干里的区间 [s, e)；同一个区间只记一次（k），记到这一步的 rq 上 */
  function ranges(str, steps) {
    const list = [];
    steps.forEach((st) => {
      st.rq = [];
      [].concat(st.stem == null ? [] : st.stem).map(sub).forEach((m) => {
        let at = -1; for (let j = 0; j < m.n; j++) { at = m.tex ? str.indexOf(m.tex, at + 1) : -1; if (at < 0) break; }
        if (at < 0) { warn(st.id, 'stem 在题干里找不到：', m.tex); return; }
        const e = at + m.tex.length;
        let r = list.find((x) => x.s === at && x.e === e);
        if (!r) {
          if (list.some((x) => (x.s < at && at < x.e && x.e < e) || (at < x.s && x.s < e && e < x.e))) { warn(st.id, 'stem 和别的步交叉，不亮：', m.tex); return; }
          r = { s: at, e, k: list.length }; list.push(r);
        }
        st.rq.push(r.k);
      });
    });
    return list;
  }
  /* 一段纯文字里插记号：同一个位置先关（短的先关）再开（长的先开），一个套一个也对 */
  function plug(s, rs) {
    let out = '';
    for (let i = 0; i <= s.length; i++) {
      rs.filter((r) => r.e === i && r.s < r.e).sort((a, b) => (a.e - a.s) - (b.e - b.s)).forEach((r) => { out += String.fromCharCode(CLOSE + r.k); });
      rs.filter((r) => r.s === i && r.s < r.e).sort((a, b) => (b.e - b.s) - (a.e - a.s)).forEach((r) => { out += String.fromCharCode(OPEN + r.k); });
      if (i < s.length) out += s[i];
    }
    return out;
  }
  /* 返回插好记号的题干。math：按 $ 切段，文字段插记号，公式段用 \htmlClass */
  function mark(str, steps, math) {
    str = String(str || '');
    const list = ranges(str, steps);
    if (!list.length) return str;
    if (!math) return plug(str, list);
    const parts = str.split('$'); let a = 0;
    return parts.map((p, i) => {
      const b = a + p.length, cut = list.map((r) => ({ s: Math.max(r.s, a) - a, e: Math.min(r.e, b) - a, k: r.k })).filter((r) => r.s < r.e);
      a = b + 1;
      if (!cut.length) return p;
      return i % 2 ? Kit.math.wrapTex(p, cut.map((r) => ({ s: r.s, e: r.e, c: 'rdq' + r.k }))) : plug(p, cut);
    }).join('$');
  }
  /* 排好以后：把文字里的记号换成 span（记号之间的字包进去，跨过 <sup> 这类小元素也接得上） */
  function spans(root) {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [];
    while (tw.nextNode()) nodes.push(tw.currentNode);
    const open = [];
    nodes.forEach((nd) => {
      const s = nd.nodeValue; SENT.lastIndex = 0;
      if (!open.length && !SENT.test(s)) return;
      const frag = document.createDocumentFragment(); let buf = '';
      const flush = () => {
        if (!buf) return;
        if (open.length) { const el = document.createElement('span'); el.className = 'rdq ' + open.map((k) => 'rdq' + k).join(' '); el.textContent = buf; frag.appendChild(el); }
        else frag.appendChild(document.createTextNode(buf));
        buf = '';
      };
      for (const ch of s) {
        const c = ch.charCodeAt(0);
        if (c >= OPEN && c < CLOSE) { flush(); open.push(c - OPEN); }
        else if (c >= CLOSE && c < CLOSE + 0x200) { flush(); const i = open.lastIndexOf(c - CLOSE); if (i >= 0) open.splice(i, 1); }
        else buf += ch;
      }
      flush(); nd.parentNode.replaceChild(frag, nd);
    });
  }
  const strip = (s) => String(s || '').replace(SENT, '');
  /* 换步时：左栏这一步的那几句、那几个选项亮起来，题干框里滚到看得见 */
  function paint(stem, opts, s) {
    stem.querySelectorAll('.rdon').forEach((e) => e.classList.remove('rdon'));
    opts.querySelectorAll('.opt.rdon').forEach((e) => e.classList.remove('rdon'));
    if (!s) return;
    (s.rq || []).forEach((k) => stem.querySelectorAll('.rdq' + k).forEach((e) => e.classList.add('rdon')));
    [].concat(s.ropt || []).forEach((k) => { const b = opts.querySelector('.opt[data-k="' + k + '"]'); if (b) b.classList.add('rdon'); });
    const el = stem.querySelector('.rdon');
    if (el) {
      const r = el.getBoundingClientRect(), sr = stem.getBoundingClientRect();
      if (r.top < sr.top + 4 || r.bottom > sr.bottom - 4) stem.scrollTo({ top: Math.max(0, stem.scrollTop + r.top - sr.top - 16), behavior: document.documentElement.classList.contains('still') || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }

  /* ================= 框的样子（读题层、轻量书页 Kit.light、逐项判断时闪回的书页小图共用；2026-11-22 v5） =================
     以前一个框一个圆角矩形：一句话折成几行时一行一个框，上下两个框的线交叉、压在相邻那行字上；框边按比例画，常常切过字（用户：“框框做的很烂，经常有互相遮挡”）。
     现在：
       贴字  框的每条边从原来的位置（外扩 PAD）就近挪到图上没有字的那几行 / 几列里（按原图像素认字：和底色差得多的点），挪不开就挑压字最少的位置。
             图的像素是异步读的：先按原样画，读好了再把轮廓换成贴好的（只改 d，时间线不用动）。
       合并  贴好以后相交、或上下 / 左右挨得很近的框合成一个轮廓（像选中一段文字的那种形状），框线不交叉、不叠。
       一步一套  每一步的框各是一套（轮廓 + 遮罩上的洞），演这一步时上一步的整套收掉、这一套亮出来；离开这张图时收干净，不会残留。
       推近包住框  zoom 没包住的框，取景范围往外扩到包住为止（不然框有一截在画面外）。 */
  const FR = (function () {
    const Q = 2;   // 认字的位图按原图一半的分辨率存（够用，省内存）
    const cache = {}, queue = [];
    let busy = false;
    const pump = () => { if (busy || !queue.length) return; busy = true; const job = queue.shift(); setTimeout(() => { try { job(); } finally { busy = false; pump(); } }, 0); };
    /* 读一张图的“字”：和底色（出现最多的亮度）差 60 以上的点。读不出来（跨域、坏图）给 null，框就照原样画 */
    function ink(src) {
      if (cache[src]) return cache[src];
      return (cache[src] = new Promise((res) => {
        const im = new Image();
        im.onload = () => queue.push(() => {
          try {
            const w = im.naturalWidth, h = im.naturalHeight, c = document.createElement('canvas'); c.width = w; c.height = h;
            const cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(im, 0, 0);
            const d = cx.getImageData(0, 0, w, h).data, hist = new Uint32Array(256);
            for (let j = 0; j < d.length; j += 32) hist[(d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8]++;
            let bg = 0; for (let v = 1; v < 256; v++) if (hist[v] > hist[bg]) bg = v;
            const W = Math.ceil(w / Q), H = Math.ceil(h / Q), bit = new Uint8Array(W * H);
            for (let y = 0; y < h; y++) for (let x = 0, j = y * w * 4; x < w; x++, j += 4) {
              const v = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
              if (v - bg > 60 || bg - v > 60) bit[((y / Q) | 0) * W + ((x / Q) | 0)] = 1;
            }
            c.width = c.height = 0; res({ w: W, h: H, bit });
          } catch (e) { res(null); }
        }) && pump();
        im.onerror = () => res(null);
        im.src = src;
      }));
    }
    /* 比例框 b → 画面坐标的框（外扩 pad）。m = {ox, oy, w, h（图在画面上的位置和大小）, pad, s（这一步的推近倍数）} */
    const raw = (b, m) => ({ x: m.ox + b[0] * m.w - m.pad, y: m.oy + b[1] * m.h - m.pad, w: b[2] * m.w + 2 * m.pad, h: b[3] * m.h + 2 * m.pad });
    /* 贴字：四条边各自在原位置附近找没有字的一条（宽度 = 框线在屏幕上的粗细），找不到就挑字最少的；离原位置越远越不划算 */
    function snap(I, b, m) {
      if (!I) return raw(b, m);
      const W = I.w, H = I.h, bit = I.bit, sx = m.w / W, sy = m.h / H;   // 位图一格 = 画面上几个单位
      const pad = m.pad / sx, padY = m.pad / sy, sw = Math.max(1, Math.ceil(3.8 / (sy * (m.s || 1)))), swx = Math.max(1, Math.ceil(3.8 / (sx * (m.s || 1))));
      const x0 = b[0] * W, y0 = b[1] * H, x1 = (b[0] + b[2]) * W, y1 = (b[1] + b[3]) * H;
      const row = (y, a, c) => { y |= 0; if (y < 0 || y >= H) return 0; let n = 0; const o = y * W, e = Math.min(W, c | 0); for (let x = Math.max(0, a | 0); x < e; x++) n += bit[o + x]; return n; };
      const col = (x, a, c) => { x |= 0; if (x < 0 || x >= W) return 0; let n = 0; const e = Math.min(H, c | 0); for (let y = Math.max(0, a | 0); y < e; y++) n += bit[y * W + x]; return n; };
      const pick = (want, lo, hi, f, len, band) => {
        lo = Math.round(lo); hi = Math.round(hi); want = Math.round(want);
        if (hi < lo) return want;
        let best = want, bs = Infinity; const h0 = band >> 1;
        for (let p = lo; p <= hi; p++) {
          let c = 0; for (let k = -h0; k <= h0; k++) c += f(p + k);
          const v = c + Math.abs(p - want) * Math.max(1, len) * 0.004;
          if (v < bs) { bs = v; best = p; }
        }
        return best;
      };
      const winY = Math.max(3, Math.round(padY * 1.7)), winX = Math.max(3, Math.round(pad * 1.7));
      const xa = x0 - pad, xb = x1 + pad, th = Math.max(1, Math.round((xb - xa) * 0.003)), inkR = (y) => row(y, xa, xb) >= th;
      /* 上下两条边按“行”来定：边切过的那一行，框住了一半以上就整行算进来，不到一半就让出去；
         然后框线放在字外 PAD 处，和相邻那一行之间的空白不够 2 个 PAD 时放在空白正中（再紧也不压到字） */
      const yc = (y0 + y1) / 2;
      const edgeY = (yb0, dir) => {   // dir = -1 上边，+1 下边；yb0 = 原来的边（不含 PAD）
        let r = Math.round(yb0), content;
        if (inkR(r)) {
          let a = r, b = r; while (a - 1 >= 0 && inkR(a - 1) && Math.abs(a - 1 - yb0) < 200) a--; while (b + 1 < H && inkR(b + 1) && Math.abs(b + 1 - yb0) < 200) b++;
          const inside = dir > 0 ? (yb0 - a) / (b - a + 1) : (b - yb0) / (b - a + 1);
          if (inside >= 0.5) content = dir > 0 ? b : a;
          else { let q = dir > 0 ? a - 1 : b + 1; while ((dir > 0 ? q > yc : q < yc) && !inkR(q)) q -= dir; content = (dir > 0 ? q > yc : q < yc) ? q : (dir > 0 ? a - 1 : b + 1); }
        } else {
          let q = r; while ((dir > 0 ? q > yc : q < yc) && !inkR(q)) q -= dir;
          content = (dir > 0 ? q > yc : q < yc) ? q : r;
        }
        let n = content + dir, lim = content + dir * (2 * padY + winY);
        while ((dir > 0 ? n <= lim : n >= lim) && !inkR(n)) n += dir;   // 图外也算空白（书页裁得贴着字时，框线放到图外）
        const gap = Math.abs(n - content) - 1, off = gap >= 2 * padY ? padY : Math.max(0.5, (gap + 1) / 2);
        return content + dir * off;
      };
      /* 按行定出来的边挪得太远（表格的竖线让每一行都有“字”，一整张表连成一“行”）、或越过中线：这条边改用就近找空白行 */
      const rowF = (y) => row(y, xa, xb), lim = 2 * padY + winY;
      const sane = (v, yb0, dir) => !((dir > 0 ? v <= yc : v >= yc) || Math.abs(v - (yb0 + dir * padY)) > lim);
      let top = edgeY(y0, -1), bot = edgeY(y1, 1);
      /* 框画在两行字中间、两头各框住不到一半：按上面的规则两行都让出去，框里一个字都没有（缩成一条缝）。这时取框住比例最大的那一行 */
      let anyInk = false; for (let y = Math.ceil(top); y <= bot && !anyInk; y++) anyInk = inkR(y);
      if (!anyInk) {
        const bands = []; let a = -1;
        for (let y = Math.max(0, Math.floor(y0) - 60); y <= Math.min(H - 1, Math.ceil(y1) + 60); y++) { if (inkR(y)) { if (a < 0) a = y; } else if (a >= 0) { bands.push([a, y - 1]); a = -1; } }
        if (a >= 0) bands.push([a, Math.min(H - 1, Math.ceil(y1) + 60)]);
        let best = null, bf = 0;
        bands.forEach(([p, q]) => { const f = (Math.min(q + 1, y1) - Math.max(p, y0)) / (q - p + 1); if (f > bf) { bf = f; best = [p, q]; } });
        if (best) {
          const room = (c, dir) => { let n = c + dir; const L = c + dir * (2 * padY + winY); while ((dir > 0 ? n <= L : n >= L) && !inkR(n)) n += dir; const g = Math.abs(n - c) - 1; return g >= 2 * padY ? padY : Math.max(0.5, (g + 1) / 2); };
          top = best[0] - room(best[0], -1); bot = best[1] + room(best[1], 1);
        }
      }
      if (!sane(top, y0, -1)) top = pick(y0 - padY, y0 - padY - winY, yc - 1, rowF, xb - xa, sw);
      if (!sane(bot, y1, 1)) bot = pick(y1 + padY, yc + 1, y1 + padY + winY, rowF, xb - xa, sw);
      const ya = top + sw, yb = bot - sw, colF = (x) => col(x, ya, yb);
      /* 左右两条边：就近挪到没有字的那一列（往外最多 1.7 个 PAD，往里到中线） */
      const left = pick(x0 - pad, x0 - pad - winX, (x0 + x1) / 2 - 1, colF, yb - ya, swx);
      const right = pick(x1 + pad, (x0 + x1) / 2 + 1, x1 + pad + winX, colF, yb - ya, swx);
      return { x: m.ox + left * sx, y: m.oy + top * sy, w: (right - left) * sx, h: (bot - top) * sy };
    }
    /* 合并：相交的、上下（左右）挨着不到 gap 的框归成一组；组里上下相邻的缝补上，左右边差不多齐的对齐，免得轮廓上出小台阶 */
    function merge(rs, gap) {
      const R = rs.filter((r) => r && r.w > 0 && r.h > 0).map((r) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }));
      const up = R.map((_, i) => i), find = (i) => (up[i] === i ? i : (up[i] = find(up[i])));
      const ov = (a, b) => [Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)];
      const near = (a, b) => { const [ox, oy] = ov(a, b); return (ox > 0 && oy > 0) || (ox > 4 && oy > -gap) || (oy > 4 && ox > -gap); };
      for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) if (near(R[i], R[j])) up[find(i)] = find(j);
      const G = {};
      R.forEach((r, i) => { (G[find(i)] = G[find(i)] || []).push(r); });
      return Object.values(G).map((g) => {
        for (let i = 0; i < g.length; i++) for (let j = 0; j < g.length; j++) {
          if (i === j) continue;
          const a = g[i], b = g[j], [ox, oy] = ov(a, b);
          /* 只补挨得近的缝（不到 gap）：隔着一行的两个框不能拉到一起，不然中间那行会被框线穿过 */
          if (ox > 4 && oy <= 0 && a.y1 <= b.y0 && b.y0 - a.y1 < gap) { const mid = (a.y1 + b.y0) / 2; a.y1 = mid; b.y0 = mid; }
          if (oy > 4 && ox <= 0 && a.x1 <= b.x0 && b.x0 - a.x1 < gap) { const mid = (a.x1 + b.x0) / 2; a.x1 = mid; b.x0 = mid; }
          const touch = a.y1 >= b.y0 - 0.5 && a.y0 <= b.y1 + 0.5;   // 上下贴着的两个框，左右边差不到 8 就对齐（免得轮廓上出小台阶）
          if (touch && Math.abs(a.x0 - b.x0) < 8) a.x0 = b.x0 = Math.min(a.x0, b.x0);
          if (touch && Math.abs(a.x1 - b.x1) < 8) a.x1 = b.x1 = Math.max(a.x1, b.x1);
        }
        return g;
      });
    }
    /* 一组框的外轮廓（并集的边），拐角都倒圆，返回 path 的 d */
    function outline(g, rad) {
      const xs = [...new Set(g.flatMap((r) => [r.x0, r.x1]))].sort((a, b) => a - b), ys = [...new Set(g.flatMap((r) => [r.y0, r.y1]))].sort((a, b) => a - b);
      const nx = xs.length - 1, ny = ys.length - 1, C = [];
      for (let i = 0; i < nx; i++) { C[i] = []; for (let j = 0; j < ny; j++) { const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2; C[i][j] = g.some((r) => r.x0 <= cx && cx <= r.x1 && r.y0 <= cy && cy <= r.y1); } }
      const on = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && C[i][j];
      const E = {}, key = (i, j) => i + ',' + j, add = (a, b) => { (E[key(a[0], a[1])] = E[key(a[0], a[1])] || []).push(b); };
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        if (!C[i][j]) continue;
        if (!on(i, j - 1)) add([i, j], [i + 1, j]);
        if (!on(i + 1, j)) add([i + 1, j], [i + 1, j + 1]);
        if (!on(i, j + 1)) add([i + 1, j + 1], [i, j + 1]);
        if (!on(i - 1, j)) add([i, j + 1], [i, j]);
      }
      let d = '';
      for (;;) {
        const k0 = Object.keys(E).find((k) => E[k].length); if (!k0) break;
        const loop = []; let cur = k0.split(',').map(Number);
        for (let guard = 0; guard < 4000; guard++) {
          const l = E[key(cur[0], cur[1])]; if (!l || !l.length) break;
          loop.push(cur); cur = l.shift();
          if (key(cur[0], cur[1]) === k0) break;
        }
        /* 去掉一条直线上的中间点 */
        const P = loop.map(([i, j]) => [xs[i], ys[j]]).filter((p, k, a) => { const q = a[(k - 1 + a.length) % a.length], n = a[(k + 1) % a.length]; return !((q[0] === p[0] && p[0] === n[0]) || (q[1] === p[1] && p[1] === n[1])); });
        if (P.length < 3) continue;
        const f = (v) => Math.round(v * 100) / 100;
        P.forEach((p, k) => {
          const q = P[(k - 1 + P.length) % P.length], n = P[(k + 1) % P.length];
          const l1 = Math.hypot(p[0] - q[0], p[1] - q[1]), l2 = Math.hypot(n[0] - p[0], n[1] - p[1]), r = Math.min(rad, l1 / 2, l2 / 2);
          const a = [p[0] + (q[0] - p[0]) * r / l1, p[1] + (q[1] - p[1]) * r / l1], b = [p[0] + (n[0] - p[0]) * r / l2, p[1] + (n[1] - p[1]) * r / l2];
          d += (k ? 'L' : 'M') + f(a[0]) + ' ' + f(a[1]) + 'Q' + f(p[0]) + ' ' + f(p[1]) + ' ' + f(b[0]) + ' ' + f(b[1]);
        });
        d += 'Z';
      }
      return d;
    }
    /* 一套框：n 条轮廓线（放 parent）+ n 个洞（放 mask）；draw(rects) 合并后画上，用不上的留空 */
    function set(parent, mask, n, o) {
      o = o || {};
      const lines = [], holes = [];
      for (let k = 0; k < n; k++) {
        lines.push(E('path', { class: 'rdf', d: '', fill: 'none', stroke: o.color || C.acc, 'stroke-width': o.sw || 2.8, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }, parent));
        if (mask) holes.push(E('path', { d: '', fill: '#000' }, mask));
      }
      return {
        lines, holes,
        draw(rects) {
          const G = merge(rects, o.gap == null ? 9 : o.gap);
          lines.forEach((l, k) => { const d = G[k] ? outline(G[k], o.rad == null ? 8 : o.rad) : ''; l.setAttribute('d', d); if (holes[k]) holes[k].setAttribute('d', d); });
          return G.length;
        },
      };
    }
    /* 推近的取景范围要包住所有框（外加 m 的边） */
    function cover(z, rs, m) {
      const ok = rs.filter((r) => r && r.w > 0);
      if (!z || !ok.length) return z;
      const x0 = Math.min(z.x, ...ok.map((r) => r.x - m)), y0 = Math.min(z.y, ...ok.map((r) => r.y - m));
      const x1 = Math.max(z.x + z.w, ...ok.map((r) => r.x + r.w + m)), y1 = Math.max(z.y + z.h, ...ok.map((r) => r.y + r.h + m));
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    /* 已经开始读的图都读完（检查脚本等它，tools/box_audit.js） */
    const ready = () => Promise.all(Object.values(cache));
    return { ink, raw, snap, merge, outline, set, cover, ready };
  })();

  /* ================= 右边：原卷图（和数学题的图） =================
     原卷图的换页、推近、框和 Kit.light 一样；数学题写了 fig 时原卷图排在上面一条，下面是 kit/math.js 画的图 */
  /* 读题画面（原卷图 + 框 + 推近）建成一层：play(t, 读题步的 id, p0) 从上一次演到的样子换成这一步的样子，返回演完的时刻。
     读题入口（build）按 read.json 的顺序一步一步演；新讲法（kit/xin.js）在讲稿里插着用，同一句可以回头再演一次（框闪一下）。 */
  function stage(K, rd) {
    const q = rd.q, steps = (rd.man.steps || []).map((s) => Object.assign({}, s));
    const figSpec = q.type === 'math' && q.figure && steps.some((s) => s.fig) ? q.figure : null;
    const A = figSpec ? { x: 30, y: 14, w: 940, h: 236 } : { x: 30, y: 30, w: 940, h: 660 };
    const ZMAX = 2.2, PAD = 6, DIM = 0.62, ID = { x: 0, y: 0, s: 1 };
    const root = E('g', { 'data-read': '' }, K.svg), defs = E('defs', null, root), cid = 'rdclip' + (++maskN);
    E('rect', figSpec ? { x: 0, y: 0, width: 1000, height: A.y + A.h + 10 } : { x: 0, y: 0, width: 1000, height: 720 }, E('clipPath', { id: cid }, defs));
    /* 白底的原卷反色：纸 → 深色，字 → 浅色（和 q_dark.png 差不多） */
    const fm = E('filter', { id: 'rdinv' + maskN, 'color-interpolation-filters': 'sRGB' }, defs);
    E('feColorMatrix', { type: 'matrix', values: '-0.8 0 0 0 0.92  0 -0.8 0 0 0.92  0 0 -0.8 0 0.9  0 0 0 1 0' }, fm);
    const cam = E('g', null, E('g', { 'clip-path': `url(#${cid})` }, root));
    gsap.set(cam, { svgOrigin: '0 0', x: 0, y: 0, scale: 1 });
    /* 把图上的一块 r 推到画面正中、尽量放大；图比画面大的方向上不让图边退进画面里（不留一大块空），比画面小的方向居中 */
    const fit = (r, b) => {
      const s = Math.min(A.w / r.w, A.h / r.h, ZMAX);
      const ax = (c, lo, len, b0, bl) => { const v = c; if (s * bl <= len) return lo + (len - s * bl) / 2 - s * b0; return Math.min(lo - s * b0, Math.max(lo + len - s * (b0 + bl), v)); };
      return { x: ax(A.x + A.w / 2 - s * (r.x + r.w / 2), A.x, A.w, b.x, b.w), y: ax(A.y + A.h / 2 - s * (r.y + r.h / 2), A.y, A.h, b.y, b.h), s };
    };
    const P = {};
    Object.keys(rd.pages).forEach((name) => {
      const pg = rd.pages[name], k = Math.min(A.w / pg.w, A.h / pg.h), dw = pg.w * k, dh = pg.h * k, ox = A.x + (A.w - dw) / 2, oy = A.y + (A.h - dh) / 2;
      const g = E('g', null, cam), mid = 'rdmask' + (++maskN);
      const mask = E('mask', { id: mid, maskUnits: 'userSpaceOnUse', x: ox - 30, y: oy - 30, width: dw + 60, height: dh + 60 }, E('defs', null, g));
      E('rect', { x: ox - 30, y: oy - 30, width: dw + 60, height: dh + 60, fill: '#fff' }, mask);
      E('image', { href: pg.src, x: ox, y: oy, width: dw, height: dh, preserveAspectRatio: 'none', filter: pg.invert ? `url(#${fm.id})` : null }, g);
      const dim = E('rect', { x: ox - 1, y: oy - 1, width: dw + 2, height: dh + 2, fill: '#0b0b0a', mask: `url(#${mid})`, 'pointer-events': 'none' }, g);
      const map = { ox, oy, w: dw, h: dh, pad: PAD };
      gsap.set(dim, { opacity: 0 }); gsap.set(g, { autoAlpha: 0 });
      P[name] = { g, mask, dim, map, src: pg.src, toS: (b) => FR.raw(b, map), box: { x: ox, y: oy, w: dw, h: dh }, cur: null };
    });
    let fig = null;
    if (figSpec) { fig = Kit.math.figure(root, { x: 230, y: 266, w: 540, h: 444 }, figSpec); gsap.set(fig.fo, { autoAlpha: 0 }); }

    /* 每步的图、推近、框先按 read.json 的顺序算好（page 不写沿用上一步）。每一步一套框（FR.set）：先按原样画，图的像素读好以后换成贴字、合并好的轮廓 */
    const first = Object.keys(P)[0], byId = {};
    let pg = null;
    steps.forEach((s) => {
      s.page = s.page || pg || first; pg = s.page;
      const pp = P[s.page]; if (!pp) throw new Error('read.json 没有这张图：' + s.page);
      if (byId[s.id]) { warn('read 步名重复：', s.id); return; }
      s._rs = (s.boxes || []).map(pp.toS);
      s._z = s.zoom ? fit(FR.cover(pp.toS(s.zoom), s._rs, 10), pp.box) : ID;
      /* 右上角那排按钮（反馈、草稿纸，约占画面右上 200×68）：框推近后落在那一块里的，镜头整体往下挪，框露出来 */
      if (s._rs.length) {
        const z = s._z, ux0 = Math.min(...s._rs.map((r) => r.x)), ux1 = Math.max(...s._rs.map((r) => r.x + r.w)), uy0 = Math.min(...s._rs.map((r) => r.y));
        const top = z.y + z.s * uy0, right = z.x + z.s * ux1, left = z.x + z.s * ux0;
        if (top < 68 && right > 800 && left < 1000) s._z = Object.assign({}, z, { y: z.y + Math.min(60, 68 - top) });
      }
      if (s._rs.length) {
        s._fr = FR.set(pp.g, pp.mask, s._rs.length); s._fr.draw(s._rs);
        gsap.set(s._fr.lines, { autoAlpha: 0 }); gsap.set(s._fr.holes, { opacity: 0 });
        const m = Object.assign({}, pp.map, { s: s._z.s });
        FR.ink(pp.src).then((I) => { if (I) s._fr.draw((s.boxes || []).map((b) => FR.snap(I, b, m))); });
      }
      byId[s.id] = s;
    });
    /* 一套框亮出来 / 收掉（时间线上） */
    const frOn = (t, s, p) => { const F = s._fr; if (!F) return; t.set(F.lines, { scale: 1.035, transformOrigin: '50% 50%' }, p); t.to(F.lines, { autoAlpha: 1, scale: 1, duration: 0.4, ease: 'power3.out' }, p); t.to(F.holes, { opacity: 1, duration: 0.35 }, p); };
    const frOff = (t, s, p, d) => { const F = s && s._fr; if (!F) return; t.to(F.lines, { autoAlpha: 0, duration: d == null ? 0.2 : d }, p); t.to(F.holes, { opacity: 0, duration: d == null ? 0.25 : d }, p); };
    let prev = null;   // 上一次演到的样子（建时间线时按演的先后记）
    function play(t, id, p0) {
      const s = byId[id]; if (!s) { warn('read.json 里没有这一步：', id); t.to({}, { duration: 0.3 }, p0 || 0); return (p0 || 0) + 0.3; }
      const o = p0 || 0, pp = P[s.page], z = s._z, rs = s._rs, last = prev, f = s.fig || (last && last.f) || null;
      let p = o + 0.15;
      const turn = !!last && last.page !== s.page;
      if (!last) { fx.show(t, pp.g, o + 0.1, 0.4); if (fig) fx.show(t, fig.fo, o + 0.2, 0.4); p = o + 0.5; }
      else if (turn) {
        fx.hide(t, P[last.page].g, o); fx.show(t, pp.g, o + 0.25, 0.4); p = o + 0.75;
        /* 换页：旧页淡出以后把它亮着的那套框、暗幕收掉（每页各记各的 cur），回到这页时从干净的样子开始 */
        const lp = P[last.page], at = o + 0.24;
        if (lp.cur) frOff(t, lp.cur, at, 0);
        t.set(lp.dim, { opacity: 0 }, at); lp.cur = null;
      }
      const lz = last ? last.z : ID, moved = (a, b) => a.x !== b.x || a.y !== b.y || a.s !== b.s;
      if (turn && moved(lz, ID)) t.set(cam, { x: 0, y: 0, scale: 1 }, o + 0.22);
      if (moved(z, turn ? ID : lz)) { fx.cam(t, cam, z, !last ? o + 0.3 : turn && moved(lz, ID) ? o + 0.25 : o + 0.1); p = Math.max(p, o + 0.65); }
      const was = pp.cur;   // 这一页上现在亮着的那一套（离开这页时清空）
      if (was && was !== s) frOff(t, was, p);
      if (was === s && s._fr) s._fr.lines.forEach((l) => { t.to(l, { opacity: 0.2, duration: 0.18 }, p).to(l, { opacity: 1, duration: 0.3 }, p + 0.18); });   // 同一句再演一次（讲完知识回到这一句）：框闪一下
      else frOn(t, s, p + (was ? 0.12 : 0));
      if (rs.length || (was && was._rs.length)) t.to(pp.dim, { opacity: rs.length ? DIM : 0, duration: 0.35 }, p);
      if (rs.length) K.sfx(t, 'blip', p);
      let end = p + 0.75;
      if (fig) end = Math.max(end, Kit.math.figTo(t, fig, f || {}, p) + 0.2);
      t.to({}, { duration: 0.2 }, end);
      prev = { id, page: s.page, z, rs, f }; pp.cur = rs.length ? s : null;
      return end + 0.2;
    }
    return { root, steps, play, has: (id) => !!byId[id], step: (id) => byId[id] };
  }
  function build(K, rd) {
    const st = stage(K, rd);
    st.steps.forEach((s) => K.step(s.id, { sec: 'read', rq: s.rq || [], ropt: s.opt || null }, (t) => { st.play(t, s.id, 0); }));
    if (!st.steps.length) K.step('rd0', { sec: 'read' }, (t) => { t.to({}, { duration: 0.3 }, 0); });
  }

  const R = { can, load, build, stage, mark, ranges, spans, strip, paint, frames: FR, warnings: [] };
  Kit.read = R;
})();
