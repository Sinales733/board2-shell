/* kit/phone.js：iPhone 竖屏（视口宽 ≤ 500 且竖屏）专用；平板、横屏上什么都不做（Kit.phone.on() 为假，各个钩子直接返回 false）。
   1. 镜头：画面太小，每一步把镜头推近到这一步新出现 / 变亮的东西——这一步时间线上 tween 的目标元素里，演完时还看得见、不是整层大背景的那些，取并集；
      一个都没有的步（只有字的步）沿用上一步的取景；有动画但全是整层切换 / 推近的步（没有框的读题步）看整张。
      改的是 #stage 里那张 svg 的 viewBox（1000×720 的画布上取一块，宽高比跟着画面区），矢量和原卷图都是重新按大小画的，不糊。
      镜头只由时间线的位置决定：一步开头的 0.7 秒里从上一步的取景滑到这一步的，拖进度条、手指拖着倒着看、跳步都跟着走；still=1 截图时直接到位。
      每一步的取景在第一次要用时量一次（把时间线临时拨到这一步末尾量、马上拨回来，同一帧里，不会闪），记下来。
   2. 手势（shell.js 的画面手势里调这几个钩子）：双指捏合放大 / 缩小；放大以后单指拖着平移（没放大时单指横滑照旧翻步、长按照旧“问这里”）；
      手动动过镜头，这一步里自动镜头不抢回来，换到别的步恢复自动（从手动停的地方滑过去）；双击画面、或右下角的小图标，在“自动推近 / 整图”之间切换。
   3. 新讲法的题：画面和讲稿之间一条把手，上下拖调画面的高度（占屏高 25%–68%，默认 43%），记在本机 localStorage 的 b2phSplit。
   样式在 kit/phone.css（同一个媒体查询）。 */
(function () {
  'use strict';
  const mq = matchMedia('(max-width: 500px) and (orientation: portrait)');
  const on = () => mq.matches;
  const W = 1000, H = 720, EPS = 1e-3;
  const ZAUTO = 3.2, ZMAX = 6, BLEND = 0.7;   // 自动推近最多放大到整图的 3.2 倍；手指最多 6 倍；换步时镜头滑 0.7 秒
  const still = () => document.documentElement.classList.contains('still');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  const stored = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const U = (k) => (window.Board2 && Board2.api ? Board2.api.U(k) : k);

  let C = null;          // 当前这一页：{P, host, svg, cache, manual, ovr, shown, vb}
  let mode = 'auto';     // auto 自动推近 / whole 整图（双击、小图标切换，换题也保留）

  /* ---------- 量这一步的取景 ---------- */
  function shown(el, root) {
    let o = 1;
    for (let e = el; e && e !== root && e.nodeType === 1; e = e.parentNode) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
      o *= +cs.opacity; if (o < 0.05) return 0;
    }
    return o;
  }
  /* 量第 i 步：这一步里被动画、演完还看得见的元素，各自的框（画布坐标）和它在时间线上开始动的时刻 t。
     返回 {items, any}：any = 这一步有没有动 DOM 元素（一个都没有 = 只有字的步，取景沿用上一步） */
  function measure(i) {
    const c = C; if (c.cache[i] !== undefined) return c.cache[i];
    const P = c.P, M = P._tl, s = P.steps[i];
    const kid = M.getChildren(false, false, true).find((x) => Math.abs(x.startTime() - s.start) < EPS);
    const els = new Map();   // 元素 → 最早开始动的时刻（整条时间线上的秒数）
    const gt = (tw) => { let t = tw.startTime(); for (let p = tw.parent; p && p !== M; p = p.parent) t += p.startTime(); return t; };
    if (kid) kid.getChildren(true, true, false).forEach((tw) => {
      if (!tw.targets) return;
      const t = gt(tw), inst = tw.duration() < 0.1;   // 瞬间改的（set、put）：多半是换步时把上一步的状态收拾掉；只有它们的元素记成 inst
      tw.targets().forEach((el) => {
        if (!(el && el.nodeType === 1 && c.svg.contains(el)) || el.closest('mask, clipPath, defs, pattern, marker') || el.hasAttribute('mask')) return;   // 带 mask 的是“别处压暗”的暗幕，不算
        const o = els.get(el);
        if (!o) els.set(el, { t, inst });
        else if (o.inst && !inst) els.set(el, { t, inst: false });
        else if (o.inst === inst && t < o.t) o.t = t;
      });
    });
    const items = [];
    if (els.size) {
      const t0 = M.time();
      M.seek(s.end, true);   // 拨到这一步末尾量（不触发回调、不出声），量完拨回去；在同一帧里，画面不会闪
      const inv = c.svg.getScreenCTM().inverse(), pt = c.svg.createSVGPoint();
      const map = (x, y) => { pt.x = x; pt.y = y; const q = pt.matrixTransform(inv); return [q.x, q.y]; };
      const rg = document.createRange(), list = [...els.keys()];
      const real = list.some((el) => !els.get(el).inst);
      list.forEach((el) => {
        if (list.some((o) => o !== el && el.contains(o))) return;   // 这一步里自己的子元素也在动：只认更小的那些（整栏往上挪、整行淡入时，取的是新写的那几个字）
        if (real && els.get(el).inst) return;   // 这一步有真正在动的东西：只被瞬间改过的不算
        if (shown(el, c.svg) < 0.5) return;   // 演完是藏着的、或被压暗的（淡出、压暗别的东西）不算
        let r = el.getBoundingClientRect();
        if (!(el instanceof SVGElement) && el.firstChild) { rg.selectNodeContents(el); const q = rg.getBoundingClientRect(); if (q.width || q.height) r = q; }   // 板书里的一行（HTML）：按字实际占的地方，不按整行的盒子
        if (r.width < 1 && r.height < 1) return;
        const a = map(r.left, r.top), b = map(r.right, r.bottom);
        const x0 = clamp(Math.min(a[0], b[0]), 0, W), x1 = clamp(Math.max(a[0], b[0]), 0, W), y0 = clamp(Math.min(a[1], b[1]), 0, H), y1 = clamp(Math.max(a[1], b[1]), 0, H);
        if (x1 - x0 < 2 && y1 - y0 < 2) return;
        if ((x1 - x0) * (y1 - y0) > W * H * 0.5) return;   // 盖住大半个画布的：整层切换、镜头组、暗幕，不算
        items.push({ x0, y0, x1, y1, t: els.get(el).t });
      });
      M.seek(t0, true);
    }
    return (c.cache[i] = { items, any: els.size > 0 });
  }
  const R = (u) => ({ x: u.x0, y: u.y0, w: u.x1 - u.x0, h: u.y1 - u.y0 });
  const join = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), t: Math.min(a.t, b.t), t1: Math.max(a.t1 == null ? a.t : a.t1, b.t1 == null ? b.t : b.t1) });
  /* 第 i 步的镜头关键帧 [{r, t}]（按开始动的先后）；inherit = 只有字的步；[] = 看整张。
     先试整步取一个框；这个框太宽（推不到整图的 1.6 倍，字还是小）时，把动的东西按位置聚成几簇（相距远的分开，最多 4 簇），镜头一簇一簇跟过去。
     只有一个元素（原卷、书页上横跨整行的一句话的框）不拆，照旧 */
  const ZCL = 1.6, NCL = 4, TCL = 0.8;
  function plan(i, z) {
    const key = i + '|' + z.w + 'x' + z.h; if (C.plans[key]) return C.plans[key];
    const m = measure(i), s = C.P.steps[i];
    let out;
    if (!m.any) out = { inherit: true };
    else if (!m.items.length) out = { keys: [] };
    else {
      const u = m.items.reduce(join);
      const zoomOf = (c) => { const r = R(c), p = 16 + 0.06 * Math.max(r.w, r.h); return Math.min(z.w / (r.w + 2 * p), z.h / (r.h + 2 * p)) / k0(z); };
      if (m.items.length === 1 || zoomOf(u) >= ZCL) out = { keys: [{ r: R(u), t: s.start }] };
      else {
        let cl = m.items.map((x) => Object.assign({}, x));
        const best = (need) => {   // 合起来面积涨得最少的一对；need：合起来还要能推近 ZCL 倍
          let bi = -1, bj = -1, bv = Infinity;
          for (let a = 0; a < cl.length; a++) for (let b = a + 1; b < cl.length; b++) {
            const j = join(cl[a], cl[b]); if (need && (zoomOf(j) < ZCL || j.t1 - j.t > TCL)) continue;   // 合起来还推得近、而且差不多同时出现，才算一簇
            const v = (j.x1 - j.x0) * (j.y1 - j.y0) - (cl[a].x1 - cl[a].x0) * (cl[a].y1 - cl[a].y0) - (cl[b].x1 - cl[b].x0) * (cl[b].y1 - cl[b].y0);
            if (v < bv) { bv = v; bi = a; bj = b; }
          }
          return bi < 0 ? null : [bi, bj];
        };
        const merge = (p) => { const j = join(cl[p[0]], cl[p[1]]); cl = cl.filter((x, k) => k !== p[0] && k !== p[1]); cl.push(j); };
        for (let p = best(true); p; p = best(true)) merge(p);
        /* 零碎的小簇（一个小记号、一个年份格）并进旁边还推得近的那簇，不单独跑一趟 */
        const area = (c) => (c.x1 - c.x0) * (c.y1 - c.y0);
        for (let go = true; go && cl.length > 1;) {
          go = false;
          const k = cl.findIndex((c) => area(c) < 12000); if (k < 0) break;
          let bj = -1, bv = Infinity;
          cl.forEach((c, j) => { if (j === k) return; const m = join(cl[k], c); if (zoomOf(m) >= ZCL * 0.8 && area(m) < bv) { bv = area(m); bj = j; } });
          if (bj >= 0) { merge([Math.min(k, bj), Math.max(k, bj)]); go = true; } else cl[k].big = true;
          if (cl.every((c) => c.big || area(c) >= 12000)) break;
        }
        while (cl.length > NCL) merge(best(false));
        cl.sort((a, b) => a.t - b.t);
        out = { keys: cl.map((c) => ({ r: R(c), t: c.t })) };
      }
    }
    return (C.plans[key] = out);
  }
  /* 第 i 步演完时的取景 */
  function finalView(i, z) {
    for (let k = i; k >= 0; k--) { const p = plan(k, z); if (!p.inherit) return p.keys.length ? viewOf(p.keys[p.keys.length - 1].r, z) : whole(z); }
    return whole(z);
  }
  /* 第 i 步在时刻 t 正对着的那一簇（测试用） */
  function focus(i, t) {
    const z = size();
    for (let k = i; k >= 0; k--) {
      const p = plan(k, z); if (p.inherit) continue;
      if (!p.keys.length) return null;
      if (k < i) return p.keys[p.keys.length - 1].r;
      let r = p.keys[0].r; p.keys.forEach((x) => { if (t >= x.t - 0.2) r = x.r; }); return r;
    }
    return null;
  }

  /* ---------- 镜头：{cx, cy, k}，k = 每个画布单位多少像素 ---------- */
  const size = () => ({ w: C.host.clientWidth, h: C.host.clientHeight });
  const k0 = (z) => Math.min(z.w / W, z.h / H);   // 整张刚好放下
  function fix(v, z) {
    const k = clamp(v.k, k0(z), k0(z) * ZMAX), vw = z.w / k, vh = z.h / k;
    return { k, cx: vw >= W ? W / 2 : clamp(v.cx, vw / 2, W - vw / 2), cy: vh >= H ? H / 2 : clamp(v.cy, vh / 2, H - vh / 2) };
  }
  const whole = (z) => ({ cx: W / 2, cy: H / 2, k: k0(z) });
  function viewOf(r, z) {
    if (!r) return whole(z);
    const p = 16 + 0.06 * Math.max(r.w, r.h);
    let k = Math.min(z.w / (r.w + 2 * p), z.h / (r.h + 2 * p), k0(z) * ZAUTO);
    if (k < k0(z) * 1.12) return whole(z);   // 差不多就是整张：不推，免得每步镜头小抖一下
    return fix({ cx: r.x + r.w / 2, cy: r.y + r.h / 2, k }, z);
  }
  const lerp = (a, b, f) => ({ cx: a.cx + (b.cx - a.cx) * f, cy: a.cy + (b.cy - a.cy) * f, k: Math.exp(Math.log(a.k) + (Math.log(b.k) - Math.log(a.k)) * f) });
  function stepAt(t) { const st = C.P.steps; for (let i = 0; i < st.length; i++) if (t <= st[i].end + EPS) return i; return st.length - 1; }
  function target(z) {
    const P = C.P;
    if (mode === 'whole' || !P.steps.length) return whole(z);
    if (C.manual && C.manual.i === P.index) return fix(C.manual.v, z);
    const t = P._tl.time(), i = stepAt(t), s = P.steps[i], p = plan(i, z);
    if (p.inherit) return C.ovr && C.ovr.i === i ? fix(C.ovr.v, z) : finalView(i, z);
    const V = p.keys.length ? p.keys.map((x) => viewOf(x.r, z)) : [whole(z)];
    const from = C.ovr && C.ovr.i === i ? fix(C.ovr.v, z) : i > 0 ? finalView(i - 1, z) : V[0];
    const S = sched(s, p.keys);
    let v = lerp(from, V[0], ease((t - S[0][0]) / (S[0][1] - S[0][0])));
    for (let j = 1; j < V.length; j++) if (t >= S[j][0]) v = lerp(V[j - 1], V[j], ease((t - S[j][0]) / (S[j][1] - S[j][0])));
    return v;
  }
  /* 每一簇镜头从几秒滑到几秒：第一簇在这一步开头 0.7 秒里滑到；后面的在它开始动前 0.2 秒起滑（约 0.5 秒），前一段没滑完不开始，挤不下就压短；整步演完时停在最后一簇 */
  function sched(s, keys) {
    const d = Math.min(BLEND, Math.max(0.05, (s.end - s.start) * 0.6)), out = [[s.start, s.start + d]];
    let b0 = s.start + d;
    for (let j = 1; j < keys.length; j++) {
      let a = Math.max(b0, keys[j].t - 0.2), b = Math.min(s.end, a + 0.5);
      if (b - a < 0.05) a = Math.max(s.start, b - 0.05);
      out.push([a, b]); b0 = b;
    }
    return out;
  }
  function apply(v, z) {
    C.shown = v;
    const vw = z.w / v.k, vh = z.h / v.k, vb = [v.cx - vw / 2, v.cy - vh / 2, vw, vh].map((n) => n.toFixed(2)).join(' ');
    if (vb !== C.vb) { C.vb = vb; C.svg.setAttribute('viewBox', vb); }
  }
  let raf = 0;
  function update() {
    if (!C) return;
    if (!on()) { if (C.vb) { C.svg.setAttribute('viewBox', `0 0 ${W} ${H}`); C.vb = null; C.shown = null; } return; }
    const z = size(); if (!z.w || !z.h) return;
    let v = target(z);
    if (C.anim) {   // 切“自动 / 整图”、手动镜头收回：从刚才的样子滑过去
      const f = (performance.now() - C.anim.t) / 350;
      if (f >= 1 || still()) C.anim = null; else { v = lerp(C.anim.from, v, ease(f)); if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); }); }
    }
    apply(v, z); paintBtn();
  }
  function glide() { if (C && C.shown && !still()) C.anim = { from: C.shown, t: performance.now() }; update(); }

  /* 一页讲解装好（shell.js 的 open 里，createPlayer 之后）调一次 */
  function attach(P, host) {
    C = { P, host, svg: host.querySelector('svg'), cache: [], plans: {}, manual: null, ovr: null, shown: null, vb: null, anim: null };
    const c = C;
    P.on('time', () => { if (C === c) update(); });
    P.on('step', (i) => { if (C !== c) return; if (c.manual && c.manual.i !== i) { c.ovr = { i, v: c.shown }; c.manual = null; } update(); });
    ui(); update();
  }
  if (window.ResizeObserver) { const ro = new ResizeObserver(() => update()); ro.observe(document.getElementById('stage') || document.documentElement); }   // 转屏、拖分界线、问答面板挤画面：画面区大小变了，镜头重算
  mq.addEventListener ? mq.addEventListener('change', () => { ui(); update(); split(); }) : mq.addListener(() => { ui(); update(); split(); });

  /* 自动推近 ⇄ 整图；手动放大着的时候点也是去整图。手动镜头一并收掉 */
  function toggle() { mode = mode === 'whole' ? 'auto' : 'whole'; if (C) { C.manual = null; C.ovr = null; } glide(); }

  /* ---------- 手势钩子（shell.js 调） ---------- */
  const pts = new Map(); let pz = null;
  const gate = () => !window.Board2 || !!Board2.gate || !Board2.P;
  const zoomed = () => !!(C && C.manual && C.manual.i === C.P.index && C.manual.v.k > k0(size()) * 1.05);
  function setManual(v) { const z = size(); C.manual = { i: C.P.index, v: fix(v, z) }; C.anim = null; update(); }
  /* 手指落下：第二根手指落下 = 开始捏合，返回 true（shell 把第一根手指的手势作废） */
  function down(e) {
    if (!on() || !C || e.pointerType === 'mouse') return false;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size < 2 || gate() || C.P.index < 0) return false;
    const [a, b] = [...pts.values()];
    const r = C.host.getBoundingClientRect();
    pz = { d: Math.max(20, Math.hypot(a[0] - b[0], a[1] - b[1])), m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], v: Object.assign({}, C.shown || whole(size())), r };
    pts.forEach((p, id) => { try { C.host.setPointerCapture(id); } catch (err) {} });
    return true;
  }
  function move(e) {
    if (!pts.has(e.pointerId)) return false;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (!pz) return false;
    if (pts.size >= 2) {
      const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const z = size(), k = clamp(pz.v.k * d / pz.d, k0(z), k0(z) * ZMAX), ox = pz.r.left + z.w / 2, oy = pz.r.top + z.h / 2;
      const ux = pz.v.cx + (pz.m[0] - ox) / pz.v.k, uy = pz.v.cy + (pz.m[1] - oy) / pz.v.k;   // 捏合开始时两指中点下面的那一点，跟着两指中点走
      setManual({ cx: ux - (m[0] - ox) / k, cy: uy - (m[1] - oy) / k, k });
    }
    return true;
  }
  function up(e) { pts.delete(e.pointerId); if (pz && pts.size < 2) pz = null; }
  /* 单指移动：放大着就是平移，返回 true（shell 不当成翻步） */
  function pan(e, g) {
    if (!on() || !C || !zoomed()) return false;
    if (!g.pan) g.pan = { x: e.clientX, y: e.clientY, v: Object.assign({}, C.manual.v), on: false };
    const dx = e.clientX - g.pan.x, dy = e.clientY - g.pan.y;
    if (!g.pan.on && Math.hypot(dx, dy) < 6) return true;
    g.pan.on = true; g.dead = true;
    setManual({ cx: g.pan.v.cx - dx / g.pan.v.k, cy: g.pan.v.cy - dy / g.pan.v.k, k: g.pan.v.k });
    return true;
  }
  /* 点空白：等 0.28 秒看是不是双击；双击切“自动推近 / 整图”，单击照旧往下走（fn） */
  let tp = null;
  function tap(e, fn) {
    if (!on() || !C) return false;
    const now = performance.now();
    if (tp && now - tp.t < 330 && Math.hypot(e.clientX - tp.x, e.clientY - tp.y) < 40) { clearTimeout(tp.h); tp = null; toggle(); return true; }
    if (tp) { clearTimeout(tp.h); const f = tp.fn; tp = null; f(); }
    const T = { t: now, x: e.clientX, y: e.clientY, fn };
    T.h = setTimeout(() => { if (tp === T) tp = null; fn(); }, 280);
    tp = T; return true;
  }

  /* ---------- 右下角的小图标（看整图 / 自动推近）和讲稿上面的把手：只在手机上建 ---------- */
  let btn = null, grab = null;
  const ICON = {
    whole: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',   // 现在是自动推近：点了看整图
    auto: '<svg viewBox="0 0 24 24"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/><rect x="9" y="9" width="6" height="6" rx="1.2"/></svg>',   // 现在是整图：点了回到自动推近
  };
  function ui() {
    if (!on() || btn) return;
    const wrap = document.querySelector('.stagewrap'); if (!wrap) return;
    btn = document.createElement('button'); btn.className = 'ic phcam'; btn.type = 'button';
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    wrap.appendChild(btn);
    grab = document.createElement('div'); grab.className = 'phgrab'; grab.setAttribute('role', 'separator'); grab.innerHTML = '<i></i>';
    const rail = document.getElementById('rail'); rail.insertBefore(grab, rail.firstChild);
    dragSplit(grab); split(); paintBtn();
  }
  function paintBtn() {
    if (!btn) return;
    const k = mode === 'whole' ? 'auto' : 'whole';
    if (btn.dataset.k !== k) { btn.dataset.k = k; btn.innerHTML = ICON[k]; }
    btn.setAttribute('aria-label', U(k === 'whole' ? 'ui.cam.whole' : 'ui.cam.auto'));
    if (grab) grab.setAttribute('aria-label', U('ui.cam.split'));
  }

  /* ---------- 新讲法：画面 / 讲稿的分界线 ---------- */
  let ratio = clamp(+stored('b2phSplit', 0.43) || 0.43, 0.25, 0.68);
  function split() { const r = document.documentElement.style; if (on()) r.setProperty('--phr', ratio.toFixed(3)); else r.removeProperty('--phr'); }
  function dragSplit(el) {
    let d = null;
    el.addEventListener('pointerdown', (e) => {
      const sw = document.querySelector('.stagewrap'); if (!sw) return;
      d = { y: e.clientY, r: ratio, h: innerHeight }; el.setPointerCapture(e.pointerId); el.classList.add('on'); e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => { if (!d) return; ratio = clamp(d.r + (e.clientY - d.y) / d.h, 0.25, 0.68); split(); });
    const end = () => { if (!d) return; d = null; el.classList.remove('on'); store('b2phSplit', ratio); if (window.Board2 && Board2.api) Board2.api.fitRail(); };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  }
  split();

  /* ---------- 原卷 / 书页浮层（.sheet）关掉以后页面别停在放大状态 ----------
     浮层里放大看图用的是 Safari 自己的双指缩放（整页一起放大）；浮层一关，把 viewport 的 meta 换一下再换回来，Safari 会把页面缩回 1 倍 */
  function unzoom() {
    const vv = window.visualViewport, m = document.querySelector('meta[name=viewport]'); if (!m || !vv || vv.scale <= 1.01) return;
    const c0 = m.getAttribute('content');
    m.setAttribute('content', c0.replace(/initial-scale=[\d.]+/, 'initial-scale=1.0').replace(/maximum-scale=[\d.]+/, 'maximum-scale=1.0') + ', minimum-scale=1.0');
    setTimeout(() => { m.setAttribute('content', c0); window.scrollTo(0, 0); }, 300);
  }
  const sh = document.getElementById('sheet');
  if (sh) new MutationObserver(() => { if (on() && !sh.classList.contains('on')) unzoom(); }).observe(sh, { attributes: true, attributeFilter: ['class'] });

  Kit.phone = {
    on, attach, down, move, up, pan, tap, toggle, update, _plan: (i, z) => plan(i, z), _sched: (i, z) => { const p = plan(i, z); return p.keys && p.keys.length ? sched(C.P.steps[i], p.keys) : []; },
    get mode() { return mode; },
    /* 测试用：现在的镜头、这一步的取景框、画面区大小 */
    info() {
      if (!C || !on()) return null;
      const z = size(), i = C.P.index;
      const p = i >= 0 ? plan(i, z) : null;
      return { mode, i, manual: !!(C.manual && C.manual.i === i), z, k0: k0(z), view: C.shown, vb: C.vb, focus: i >= 0 ? focus(i, C.P._tl.time()) : null, keys: p && p.keys ? p.keys.length : 0, ratio };
    },
  };
})();
