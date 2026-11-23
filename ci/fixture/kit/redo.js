/* kit/redo.js：重讲（"再讲一遍"）。他在平板上点大画面角落的反馈按钮，打字说哪一步没懂；监听会话让 Gemini 重写字，
   编排一段重讲放在 questions/<题号>/redo/<序号>/，标 done 以后平板上反馈按钮出小点，点开播放。
   一段重讲和正常讲解用同一个播放器、同一条进度条：先把原讲解演到 base 那一步的末尾摆好画面（这些步骤不上进度条），再接重讲自己的步骤。
   目录里三个文件（格式和例子见 design/反馈流程.md）：
     redo.json  {id, feedback, base, pages, steps}
       base   从原讲解哪一步（步骤 id）的末尾接着讲；null = 从空白画面开始（原讲解的东西都藏着）
       steps  每一步写成下面四种之一，id 自己起（r1、r2…），sec 不写就是 "redo"（进度条上的段名 sec.redo 在 kit/ui.json）：
         {id, replay: "<原讲解的步骤 id>"}       把原讲解那一步再演一遍（base 要是它的前一步，画面才接得上）
         {id, mark: [[x,y,w,h],…], zoom: [x,y,w,h]}  在原画面上圈几块、别处压暗；zoom 先推近。坐标是画布 1000×720 上的像素
         {id, page: "<图名>", boxes: [...], zoom: [...]}  书页加框，和 Kit.light 一样（比例坐标）；图在 pages 里登记，src 从 board2 根目录算
         {id, js: true}                          自己写画面：redo.js 里 Kit.redo.define('<题号>/<序号>', {setup(K, R), <id>(t, R)})
     text.json  {steps: {<id>: {h, cap}}, …}：这段重讲的字（Gemini 写），找不到的键再去题目、知识块、外壳里找
     redo.js    只有 js 步骤时才要 */
(function () {
  'use strict';
  const E = Kit.E, C = Kit.C, fx = Kit.fx;
  const defs = {};
  const AREA = { x: 30, y: 30, w: 940, h: 660 }, ZMAX = 2.2, ID = { x: 0, y: 0, s: 1 };
  const fit = (r) => { const s = Math.min(AREA.w / r[2], AREA.h / r[3], ZMAX); return { x: 500 - s * (r[0] + r[2] / 2), y: 360 - s * (r[1] + r[3] / 2), s }; };
  const same = (a, b) => a.x === b.x && a.y === b.y && a.s === b.s;
  const getJSON = (u) => fetch(u + '?t=' + Date.now()).then((r) => (r.ok ? r.json() : Promise.reject(new Error(u + ' ' + r.status))));
  const loadScript = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error(src)); document.head.appendChild(s); });
  let maskN = 0;

  /* dir：questions/<题号>/redo/<序号>。读齐三个文件；js 步骤要的 redo.js 每次重新载入（重讲改过了也能看到新的） */
  async function load(dir) {
    dir = dir.replace(/\/+$/, '');
    const man = await getJSON(dir + '/redo.json');
    const text = await getJSON(dir + '/text.json').catch(() => ({}));
    const key = dir.replace(/^questions\//, '').replace('/redo/', '/');
    if ((man.steps || []).some((s) => s.js)) { delete defs[key]; await loadScript(dir + '/redo.js?t=' + Date.now()); if (!defs[key]) throw new Error(key + ' redo.js 没有登记'); }
    return { dir, key, man, text };
  }

  /* 拼时间线：orig 是原讲解的 build(K)。K.step 先包一层：base 之后的原步骤只记下来不上时间线（replay 要用） */
  function build(K, orig, rd) {
    const man = rd.man, base = man.base == null ? null : man.base, svg = K.svg, step0 = K.step, fns = {};
    let cut = base == null;
    K.step = (id, meta, fn) => { fns[id] = { meta, fn }; if (cut) return; step0(id, meta, fn); if (id === base) cut = true; };
    try { orig(K); } finally { K.step = step0; }
    if (base != null && !fns[base]) throw new Error('原讲解没有步骤 ' + base);
    K.cut();
    const view0 = K.view;
    /* 画面分两种屏：原画面（og，和圈框层、自己画的层一起放在镜头 cam 里）和书页（每组连着的书页步骤一屏） */
    const og = E('g', { 'data-redo': 'orig' }); while (svg.firstChild) og.appendChild(svg.firstChild);
    const cam = E('g', { 'data-redo': 'cam' }, svg); cam.appendChild(og);
    const markL = E('g', { 'data-redo': 'mark' }, cam), jsL = E('g', { 'data-redo': 'js' }, cam);
    gsap.set(cam, { svgOrigin: '0 0', x: 0, y: 0, scale: 1 });
    let screen = cam, z = ID, marks = null;
    const view = (t, g, pos) => { if (g === screen) return 0; fx.hide(t, screen, pos || 0, 0.25); fx.show(t, g, (pos || 0) + 0.2, 0.3); screen = g; return 0.5; };
    const zoomTo = (t, nz, pos) => { if (same(nz, z)) return 0; fx.cam(t, cam, nz, pos || 0, 0.6); z = nz; return 0.6; };
    /* 每一步开头：收掉上一步的圈框；要换屏就换；要回到不推近就拉回去。返回这一步自己的动画从几秒开始 */
    function pre(t, s, target) {
      let p = 0;
      if (marks) { fx.hide(t, marks, 0, 0.25); marks = null; p = 0.25; }
      if (target && target !== screen) { p = Math.max(p, view(t, target, 0)); }
      if (target === cam && !s.keepZoom && !s.zoom && !same(z, ID)) p = Math.max(p, zoomTo(t, ID, 0));
      return p;
    }
    const R = { K, q: rd.q, g: jsL, orig: og, cam, fit, view: (t, name, pos) => view(t, name === 'orig' ? cam : name, pos), zoom: (t, r, pos) => zoomTo(t, r ? fit(r) : ID, pos) };
    const js = defs[rd.key] || {};
    if (js.setup) js.setup(K, R);

    const steps = man.steps || [];
    let sec = 'redo';
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]; s.sec = s.sec || sec; sec = s.sec;
      if (s.page) {
        /* 连着的书页步骤交给 Kit.light 画（同一个 build，镜头和框在这几步之间接着走） */
        const group = [s]; while (steps[i + 1] && steps[i + 1].page) { i++; steps[i].sec = steps[i].sec || sec; sec = steps[i].sec; group.push(steps[i]); }
        const bg = E('g', { 'data-redo': 'book' }, svg); gsap.set(bg, { autoAlpha: 0 });
        const L = Kit.light({ pages: man.pages || {}, steps: group.map((x) => ({ id: x.id, sec: x.sec, page: x.page, boxes: x.boxes, zoom: x.zoom })), points: [] });
        K.view = () => {};   // 换屏由这里管
        K.step = (id, meta, fn) => step0(id, meta, (t) => { const p = pre(t, {}, bg); if (!p) fn(t); else { const sub = gsap.timeline(); fn(sub); t.add(sub, p); } });
        try { L.build(K, { g: bg }); } finally { K.step = step0; K.view = view0; }
        continue;
      }
      if (s.replay) {
        const f = fns[s.replay]; if (!f) throw new Error('原讲解没有步骤 ' + s.replay);
        const meta = Object.assign({}, f.meta, { sec: s.sec, replayOf: s.replay });
        step0(s.id, meta, (t) => { const p = pre(t, s, cam); const sub = gsap.timeline(); f.fn(sub); t.add(sub, p); });
        continue;
      }
      if (s.mark || s.zoom) {
        const boxes = s.mark || [];
        const mg = E('g', null, markL), mid = 'rdmask' + (++maskN);
        const mask = E('mask', { id: mid, maskUnits: 'userSpaceOnUse', x: -2000, y: -2000, width: 5000, height: 4720 }, E('defs', null, mg));
        E('rect', { x: -2000, y: -2000, width: 5000, height: 4720, fill: '#fff' }, mask);
        boxes.forEach((b) => E('rect', { x: b[0], y: b[1], width: b[2], height: b[3], rx: 8, fill: '#000' }, mask));
        const dim = E('rect', { x: -2000, y: -2000, width: 5000, height: 4720, fill: '#0b0b0a', opacity: boxes.length ? 0.62 : 0, mask: `url(#${mid})`, 'pointer-events': 'none' }, mg);
        const frames = boxes.map((b) => E('rect', { x: b[0], y: b[1], width: b[2], height: b[3], rx: 8, fill: 'none', stroke: C.acc, 'stroke-width': 2.8, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }, mg));
        gsap.set(mg, { autoAlpha: 0 });
        step0(s.id, { sec: s.sec }, (t) => {
          let p = pre(t, s, cam);
          if (s.zoom) p += zoomTo(t, fit(s.zoom), p);
          fx.show(t, mg, p, 0.3);
          frames.forEach((f, j) => { const b = boxes[j]; fx.frameIn(t, f, { x: b[0], y: b[1], w: b[2], h: b[3] }, p + j * 0.25); });
          if (boxes.length) K.sfx(t, 'blip', p);
          t.to({}, { duration: 0.2 }, p + 0.75 + boxes.length * 0.25);
          marks = mg;
        });
        continue;
      }
      if (s.js) {
        const f = js[s.id]; if (typeof f !== 'function') throw new Error('redo.js 里没有步骤 ' + s.id);
        step0(s.id, { sec: s.sec }, (t) => { const p = pre(t, s, s.screen === 'keep' ? null : cam); const sub = gsap.timeline(); f(sub, R); t.add(sub, p); });
        continue;
      }
      throw new Error('看不懂的重讲步骤 ' + s.id);
    }
  }

  Kit.redo = { define: (key, d) => { defs[key] = d; }, load, build, defs };
})();
