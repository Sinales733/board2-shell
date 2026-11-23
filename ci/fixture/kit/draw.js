/* kit/draw.js：各页讲解共用的画法和动作。画法只管“怎么画、怎么动”，不带任何给人看的字。 */
(function () {
  'use strict';
  const E = Kit.E;
  const C = {
    slot: '#1c1c1b', slotLine: '#3b3a37', other: '#3a3835', otherInk: '#b9b6ad', ink: '#f0efec', ink2: '#d9d7d0', muted: '#a7a59b', faint: '#7f7d75',
    acc: '#e08a69', accSoft: '#3a2a22', onAcc: '#20140e', blue: '#7fb2e5', blueSoft: '#27384a', ok: '#74c491', okSoft: 'rgba(116,196,145,.14)', no: '#e5766f',
    surface: '#1d1d1c', surface2: '#272725', line: '#34332f', bg: '#151515',
  };

  /* ---- 时间线上的常用动作 ---- */
  const fx = {
    show: (t, els, pos, d) => t.to(els, { autoAlpha: 1, duration: d || 0.3, ease: 'power1.out' }, pos),
    hide: (t, els, pos, d) => t.to(els, { autoAlpha: 0, duration: d || 0.22, ease: 'power1.in' }, pos),
    swap(t, a, b, pos) { fx.hide(t, a, pos); fx.show(t, b, pos + 0.2); },
    pop: (t, el, pos) => t.to(el, { autoAlpha: 1, scale: 1, duration: 0.4, ease: 'back.out(2.2)' }, pos),
    pulse: (t, el, pos, s) => t.to(el, { scale: s || 1.16, duration: 0.16, ease: 'power2.out' }, pos).to(el, { scale: 1, duration: 0.42, ease: 'power2.inOut' }, pos + 0.16),
    /* 一条线从头画到尾，画到头再冒出箭头 */
    draw(t, a, pos, d) {
      d = d || 0.45;
      t.to(a.path, { autoAlpha: 1, duration: 0.05 }, pos);
      t.to(a.path, { strokeDashoffset: 0, duration: d, ease: 'power2.inOut' }, pos);
      if (a.head) t.to(a.head, { autoAlpha: 1, duration: 0.15 }, pos + d * 0.8);
    },
    undraw(t, a, pos) { t.to([a.path, a.head].filter(Boolean), { autoAlpha: 0, duration: 0.25 }, pos); t.to(a.path, { strokeDashoffset: a.len, duration: 0.01 }, pos + 0.26); },
    /* 数字或文字原地换成另一个：旧的往上淡出，新的从下面进来 */
    flip(t, oldEl, newEl, pos) {
      t.to(oldEl, { autoAlpha: 0, y: -8, duration: 0.22, ease: 'power1.in' }, pos);
      t.to(newEl, { autoAlpha: 1, y: 0, duration: 0.3, ease: 'back.out(2)' }, pos + 0.18);
    },
    /* 矩形（框、遮罩上的洞）移到新位置 r = {x, y, w, h} */
    rect: (t, els, r, pos, d, ease) => t.to(els, { attr: { x: r.x, y: r.y, width: r.w, height: r.h }, duration: d || 0.55, ease: ease || 'power3.inOut' }, pos),
    /* 框出现：从大一圈收紧到位，同时显形 */
    frameIn(t, els, r, pos) {
      const o = 14;
      t.set(els, { attr: { x: r.x - o, y: r.y - o, width: r.w + 2 * o, height: r.h + 2 * o } }, pos);
      fx.rect(t, els, r, pos, 0.45, 'power3.out');
    },
    /* 镜头：整组画面推近 / 拉远到 z = {x, y, s}（组要先 gsap.set(g, {svgOrigin: '0 0'})） */
    cam: (t, g, z, pos, d) => t.to(g, { x: z.x, y: z.y, scale: z.s, duration: d || 0.7, ease: 'power3.inOut' }, pos),
  };

  /* ---- 画法 ---- */
  /* 从 A 点到 B 点的箭头。pad 是两头各缩进多少，bend 是弯多少（0 是直线）。先藏着，用 fx.draw 画出来。 */
  function arrow(parent, A, B, o) {
    o = o || {};
    const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    const p0 = o.pad0 == null ? 0 : o.pad0, p1 = o.pad1 == null ? 0 : o.pad1;
    const s = { x: A.x + ux * p0, y: A.y + uy * p0 }, e = { x: B.x - ux * p1, y: B.y - uy * p1 };
    const bend = o.bend || 0, mx = (s.x + e.x) / 2 - uy * bend, my = (s.y + e.y) / 2 + ux * bend;
    const color = o.color || C.blue;
    const path = E('path', { d: `M${s.x},${s.y} Q${mx},${my} ${e.x},${e.y}`, fill: 'none', stroke: color, 'stroke-width': o.w || 2.4, 'stroke-linecap': 'round' }, parent);
    const len = path.getTotalLength();
    path.setAttribute('stroke-dasharray', len + ' ' + len);
    gsap.set(path, { autoAlpha: 0, strokeDashoffset: len });
    let head = null;
    if (o.head !== false) {
      const ang = Math.atan2(e.y - my, e.x - mx) * 180 / Math.PI;
      head = E('path', { d: 'M3,0 L-9,-5.5 L-9,5.5 Z', fill: color, transform: `translate(${e.x},${e.y}) rotate(${ang})` }, parent);
      gsap.set(head, { autoAlpha: 0 });
    }
    return { path, head, len };
  }
  function text(parent, x, y, size, fill, str, extra) { return E('text', Object.assign({ x, y, 'font-size': size, fill }, extra || {}), parent, str); }
  /* 圆角标签：底 + 字，居中在 (cx, cy) */
  function pill(parent, cx, cy, w, h, fill, ink, str, size) {
    const g = E('g', null, parent);
    E('rect', { x: cx - w / 2, y: cy - h / 2, width: w, height: h, rx: h / 2, fill }, g);
    const tx = text(g, cx, cy + (size || 15) * 0.36, size || 15, ink, str, { 'text-anchor': 'middle', 'font-weight': 700 });
    return { g, tx };
  }
  /* 磁头：一个发亮的框，罩在正在读的那一块上。inner 用来做“读了一下”的弹跳。 */
  function reader(parent, w, h) {
    const g = E('g', null, parent), inner = E('g', null, g);
    E('rect', { x: -5, y: -5, width: w + 10, height: h + 10, rx: 12, fill: 'none', stroke: C.ink, 'stroke-width': 3.2, class: 'glow' }, inner);
    gsap.set(g, { autoAlpha: 0 }); gsap.set(inner, { transformOrigin: '50% 50%' });
    return { g, inner };
  }

  Kit.C = C; Kit.fx = fx; Kit.draw = { arrow, text, pill, reader };
})();
