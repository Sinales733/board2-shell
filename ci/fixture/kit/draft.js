/* kit/draft.js：全局草稿纸。任何界面右上角都有一个小按钮（问答气泡的左边），点一下整页盖一层纸，再点收起。
   2026-11-22 改成无限画布：纸没有边、没有“页”。笔迹存在“纸面坐标”里，屏幕只是一个能平移、能缩放的取景窗（V：屏幕 = 纸面 × z + (x, y)）。
   笔和手分工：Apple Pencil（pointerType pen）落笔就画；单根手指不画、穿透到下面照常点按、翻步、滑动（纸和画布都是 pointer-events:none，
     在 window 的捕获阶段把要画的那支笔的 pointer 事件拦下来自己画，不让它传给下面）。没带笔时工具条“更多”里打开“手指也能画”（默认关）：打开后单指画。
   双指 = 移动、缩放取景窗（只在草稿纸开着时）：两指中点下面那个纸面上的点一直跟着两指中点走，两指张开合拢按距离比例缩放（5% 到 3000%），可同时进行。
     第二根手指落下的那一刻，第一根手指在下面已经开始的手势（翻步的拖动、长按“问这里”、进度条）发一个 pointercancel 作废，之后两根手指的事件都吞掉；
     手指（任何一根）落在纸上面的那几层（问答面板、选题抽屉、原卷 / 书页、薄弱点、出处书页、“问这里”、工具条）上的不算，照常给那些层。
     手势中途抬起一根，剩下的一根接着拖；全抬起才结束。“手指也能画”打开时，第一根手指已经在画的那一笔作废，改成双指手势。
     Safari 的页面级双指缩放、回弹：草稿纸开着时双指的 touchmove 和 gesturestart / gesturechange / gestureend 都 preventDefault。
   防手掌：笔正在画、或刚抬起 0.35 秒内落下的手指一律当掌根：pointer 事件吞掉，也不算进双指手势（到它抬起为止）；手势进行中笔落下，手势就地停住。
   画质：缩放后按矢量重画（每笔存的是点，不是位图），线宽跟着缩放等比变（纸面上粗细不变）；新写的一笔按“屏幕上看着一样粗”记：
     每笔记下写它时的比例 k = 1 / z、起点 o（纸面坐标），点是相对起点的屏幕像素（取 0.5），纸面坐标 = o + 点 × k，粗细（w，屏幕像素）在纸面上也乘 k。橡皮同理。
   快：每笔的包围盒算一次记着，只画和取景窗相交的；缩得很小时相邻点不到一个像素的跳过；粗细相近的连续几段合成一条路径一次画。
     双指移动时先把画布当成一张图做 CSS 变换（几乎不花时间），手停下来（0.12 秒不动）或抬手后再按矢量重画；如果上一次整张重画不到 8 毫秒，移动中每帧直接矢量重画。
   纸：透明度滑条（工具条中间那根竖条）拉到顶是不透明的纸，往下拉纸变淡、能看见下面的讲解；记住上次的值。纸本身不算“浮层”，开着照常翻步。
     纸淡着在讲解上勾画时，移动或缩放过取景窗，笔迹自然和下面的讲解对不上；回到 100% 且在原点（x = y = 0）时和以前一样一一对齐。
   工具：笔 / 橡皮（擦成透明，也是一笔，能撤销）/ 颜色（墨、红、蓝、绿四种，存的是名字，昼夜两套各有各的色值）/ 撤销 / 透明度 /
     缩放比例（显示“100%”这样的数；点它回到 100%，并回到有笔迹的地方：原点那一屏有笔迹就回原点，否则全部笔迹装得下就居中显示全部，装不下就去最后写的那一笔；一笔都没有回原点）/
     更多（清空整张草稿要点两次、手指也能画）/ 收起。
   Apple Pencil 双击：网页拿不到，原生套壳收到双击时派发 window 上的 b2-pencil-doubletap（或调 window.B2PencilDoubleTap()）。
     草稿纸开着：笔 ⇄ 橡皮来回切（颜色是单独记的，切回笔还是上次的颜色），切到的那个按钮闪一下；草稿纸收着：打开并切到笔。
   工具条按住把手拖到哪都行，松手贴到最近的左边或右边；横屏问答面板开着时贴右边的自动让到面板左边，竖屏不压到面板上。
   存：每道题一份（不在题内、补练里用一份公共的 _common），存矢量笔迹和这道题的取景窗。停笔 1.2 秒自动存、换题前存、收起时存、离开页面前存；只挪了取景窗 4 秒后存。
     存到电脑：GET /draft?id= 、POST /draft（server.py，写 data/draft/<题号>.json）；接口 404（服务没重启）或没连上时存在本机 localStorage（b2draft:<题号>），
     下次打开两边取新的那份；电脑上存成功就删掉本机那份。
   格式（v: 2）：{v: 2, t, view: {cx, cy, z} | null, s: [笔…], pages: []}
     笔 {c: 颜色名, w: 屏幕粗细, e: 是不是橡皮 0/1, k: 写时的 1/z, o: [纸面 x, 纸面 y], p: [x, y, 压感, …]（相对 o 的屏幕像素）}。
     view 是屏幕中心对着的纸面点和缩放；null = 原点（屏幕左上角 = 纸面 (0, 0)、100%）。pages: [] 只是为了 server.py 的格式检查（它要求有 pages 数组），不放东西。
   旧格式（v: 1，{cur, pages: [{w, h, s: [{c, w, e, p}]}]}，点是那页出生时的 CSS 像素）读到就迁移：每一页按顺序从上往下排，页间留 160 的空，
     第 i 页的笔 o = [0, 前面各页高度 + 空的总和]、k = 1、点原样；第 1 页正好在原点，所以 100% 在原点时和以前的位置一模一样。
     旧的 cur 不是第 1 页时，取景窗放在那一页的左上角。迁移完记成待存，下次存就是新格式。本机暂存的那份同样走这一套。
   转屏：不再整页缩放；屏幕中心对着纸面上的同一个点，缩放不变。
   原生笔迹（2026-11-23，iPad 套壳 App 1.3 起）：App 在页面最开头设 window.B2Native.ink = true，并提供 webkit.messageHandlers.b2ink。
     这时新写的字由 App 用 PencilKit 画、存（iPad 上一份，电脑上另存 data/draft/pk_<题号>.json，不碰 <题号>.json）；
     这里照旧管纸、透明度、工具条、双指平移缩放、每题一份，旧的 v2 笔迹只读、照原样画在新字下面，<题号>.json 不再写。
     笔落在纸上：照样吞掉（不让下面的讲解收到），但不画；工具、颜色、手指也能画、昼夜、开关、题号、取景窗、纸上面那几层的位置都发给 App；
     撤销、清空只管新字（发给 App）；“回到有笔迹的地方”把新字的范围也算上。不在 App 里（Safari、电脑浏览器）一切照旧。
     v7（2026-11-23，配 App 1.6）：换题立刻告诉 App（题号一变就换，不等轮询）；App 交回的每题取景窗不被 load 冲掉；取景窗限在纸面 ±48000 内。
     v8（2026-11-23，配 App 1.7）：手指书写时抬手没把手指从 F 里删掉，下一笔落下被当成“第二根手指”，App 那边正在写的一笔被作废——改掉；
     只有真有手指在 App 那边写着时才发 cancel；App 在写的手指 / 笔，touchmove 一律不让下面滚动，手指书写时落在纸上的手指 touchstart 也拦下（页面不滚、不点到下面）；
     笔或手指落下告诉 App 一声（down，App 据此发现“网页看到落笔、App 没收到”）；App 退回网页自己画时调 native.off()。
     v9（2026-11-23，配 App 1.8）：App 改成正规用 PencilKit——草稿纸打开时 App 的画布盖在最上面自己接触摸（笔写字、手指挪纸、双指缩放），
     工具用苹果自带的工具盘，开关用 App 自己的按钮。这里在 App 里只剩：纸（透明度沿用上次的值）、旧 v2 笔迹只读垫底、每题一份、开关状态和题号告诉 App。
     不拦、不吞、不 preventDefault 任何触摸，不发 cancel / down / view / undo / clear；取景窗由 App 定（native.at），这里跟着画旧稿；
     工具条 #dtool 不显示，草稿纸按钮只占位（App 的按钮盖在同一个地方）。浏览器（Safari）里一切照旧。
     v10（2026-11-24，配 App 1.8）：App 里也用这条工具条（不用苹果的工具盘）：笔 / 橡皮 / 颜色 / 手指书写跟着状态消息发给 App，
     撤销、清空、缩放比例发给 App 做；App 回报能不能撤销（native.update）。工具条和展开的小弹层所在的地方 App 的画布让出来给这里。
     清空从“更多”挪到工具条第一层（Safari 里也一样），两次确认照旧：第一次点变成确认态（红框 + 旁边一句 ui.draft.clearSure），4 秒内再点才清。
     App 里清空 = App 的新笔迹 + 这里垫底的旧 v2 笔迹一起清（旧的写回电脑），App 的撤销能把两样都恢复（本次打开期间）。
     每点一下工具条告诉 App 一声（tap，带这边的时间），App 记诊断日志。
     v11（2026-11-24，配 App 1.8，复审后）：抬起时手指已滑出按钮不算；工具条外一有新的按下就不再拦 click，只拦按下点附近、600 毫秒内的；
     小弹层开合、拖手柄松手、转屏立刻报位置；清空确认气泡吞掉触摸；清空和 App 的撤销一一对应（每次清空记一份，换题、收起清掉）；
     旧稿写回电脑失败先存本机、连上再补传，两次写按先后排队；进入确认态 300 毫秒内的第二下不算；换题取消确认态；
     放不下时工具条先收紧、再折成两列；缩放比例按钮回到 100% 并回到有笔迹的地方（App 里把新笔迹的范围也算上）；键盘弹出时位置按可见区域换算；键盘、读屏点的 click（detail=0）不被吃掉。
     v12（2026-11-24，配 App 1.8，第二次复审后）：旧稿晚到时不覆盖加载期间用户做的事（挪过纸不重置取景、清空过就连回来的一起清、写的字接在后面）；
     加载期间 App 摆过取景窗就不再按旧稿重摆；离线清空的旧稿在 App 告诉"连上了 / 回到前台"时自动补传（先对时间，电脑那份更新就不传）；
     本机存不下时留在内存里补传；问答面板放大后放不下工具条时整个收起（不再折成多列）；报给 App 的工具条位置用算出来的目标位置（不等过渡结束）；
     问答面板、抽屉、提示条一出现 / 消失立刻报；旧版 App（B2Native.v < 4）不藏网页的草稿纸按钮；键盘弹着时旧稿按可见区域错开。
     工具条按钮在手指 / 笔抬起（pointerup）时就生效，不等浏览器合成的 click：模拟器里实测，刚在 App 的画布上写完字，
     第一下点工具条的 click 要晚将近 2 秒才到（App 1.8 测试日志），1.7 真机上工具条“点了好久才动”也是这个样子。 */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const B = () => window.Board2;
  const U = (k) => (B() && B().api ? B().api.U(k) : '');
  const UIKEY = 'b2draftUI', LKEY = 'b2draft:';
  const COLORS = ['ink', 'red', 'blue', 'green'];
  const PAL = {
    night: { ink: '#f0efec', red: '#f0776f', blue: '#7fb2e5', green: '#74c491' },
    day: { ink: '#1f1d1a', red: '#c33a32', blue: '#2b64a3', green: '#2a7f4a' },
  };
  const PEN_W = 2.6, ERASE_W = 26, ZMIN = 0.05, ZMAX = 30, GAP = 160, PALM_MS = 350;
  const rd = (v) => Math.round(v * 2) / 2;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const theme = () => (document.documentElement.dataset.theme === 'day' ? 'day' : 'night');
  const stored = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const clampZ = (z) => Math.max(ZMIN, Math.min(ZMAX, z));
  const dpr = () => window.devicePixelRatio || 1;

  /* ---------- 原生笔迹（iPad 套壳 App） ---------- */
  const NI = () => !!(window.B2Native && window.B2Native.ink && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.b2ink);
  const tell = (m) => { try { window.webkit.messageHandlers.b2ink.postMessage(m); } catch (e) {} };
  const ui = Object.assign({ alpha: 1, finger: false, color: 'ink', tool: 'pen', side: 'r', y: 0.5 }, stored(UIKEY, {}));
  const saveUI = () => store(UIKEY, ui);
  const D = { clears: [], open: false, id: null, doc: null, hist: [], cur: null, lastPen: 0, lastDraw: 0, server: null, dirty: false, vdirty: false, saveT: 0, tok: 0, warned: false,
    W: innerWidth, H: innerHeight, rms: 0, xf: null, stats: { renders: 0, drawn: 0 } };
  const V = { x: 0, y: 0, z: 1 };   // 取景窗：屏幕 = 纸面 × z + (x, y)

  /* ---------- 界面 ---------- */
  const ICO = {
    btn: '<path d="M4 20l1.2-4.6L15.6 5a2.1 2.1 0 0 1 3 3L8.2 18.4zM13.8 6.8l3 3"/><path d="M13 20h7"/>',
    grip: '<circle cx="9" cy="7" r="1.3"/><circle cx="15" cy="7" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="17" r="1.3"/><circle cx="15" cy="17" r="1.3"/>',
    pen: '<path d="M4 20l1.2-4.6L15.6 5a2.1 2.1 0 0 1 3 3L8.2 18.4z"/>',
    eraser: '<path d="M8.5 19.5h11M5.2 14.8l8.6-8.6a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8l-7.3 7.3a3 3 0 0 1-2.1.9H8.5l-3.3-3.3a1 1 0 0 1 0-1.3zM10 10l5 5"/>',
    undo: '<path d="M9 14L4.5 9.5 9 5"/><path d="M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-3"/>',
    more: '<circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    clear: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
  };
  const svg = (k) => `<svg viewBox="0 0 24 24">${ICO[k]}</svg>`;
  const root = document.createElement('div'); root.id = 'draft'; root.className = 'draft';
  root.innerHTML = '<div class="dpaper"></div><canvas class="dcv"></canvas>';
  const paper = root.firstChild, cv = root.lastChild, ctx = cv.getContext('2d');
  const btn = document.createElement('button'); btn.id = 'draftBtn'; btn.className = 'ic dbtn'; btn.innerHTML = svg('btn');
  const tool = document.createElement('div'); tool.id = 'dtool'; tool.className = 'dtool';
  tool.innerHTML = `<div class="dgrip" data-a="grip" role="separator">${svg('grip')}</div>`
    + `<button class="ic" data-a="pen">${svg('pen')}</button><button class="ic" data-a="eraser">${svg('eraser')}</button>`
    + `<button class="ic dcol" data-a="color"><i></i></button><button class="ic" data-a="undo">${svg('undo')}</button>`
    + `<button class="ic dclr" data-a="clear">${svg('clear')}</button>`
    + '<div class="dal" data-a="alpha" role="slider" aria-valuemin="0" aria-valuemax="100"><i></i><b></b></div>'
    + '<button class="dzm" data-a="zoom"><span>100%</span></button>'
    + `<button class="ic" data-a="more">${svg('more')}</button><button class="ic" data-a="close">${svg('close')}</button>`
    + `<div class="dpop dpal" data-p="color">${COLORS.map((c) => `<button class="ic" data-c="${c}"><i></i></button>`).join('')}</div>`
    + '<div class="dpop dmore" data-p="more"><button class="dfin" data-a="finger" role="switch"><span></span><i></i></button></div>'
    + '<div class="dpop dsure" data-p="sure" aria-hidden="true"><span></span></div>';
  const T = (a) => tool.querySelector(`[data-a="${a}"]`);
  if (NI() && (+window.B2Native.v || 0) >= 4) { const st = document.createElement('style'); st.textContent = '#draftBtn{visibility:hidden!important}'; document.head.appendChild(st); }   // 旧版 App（v < 4）没有自己的按钮，不能藏   // 原生笔迹：草稿纸按钮用 App 的（盖在同一处），这颗只占位
  function mount() { document.body.appendChild(root); placeBtn(); document.body.appendChild(tool); watchFb(); labels(); paintTool(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();

  function labels() {
    const set = (el, k) => el && el.setAttribute('aria-label', U(k));
    btn.setAttribute('aria-label', U(D.open ? 'ui.draft.close' : 'ui.draft.open'));
    ['grip', 'pen', 'eraser', 'color', 'undo', 'alpha', 'more', 'close'].forEach((a) => set(T(a), 'ui.draft.' + a));
    tool.querySelectorAll('.dpal [data-c]').forEach((b) => set(b, 'ui.draft.c.' + b.dataset.c));
    const sure = T('clear').classList.contains('sure');
    T('clear').setAttribute('aria-label', U(sure ? 'ui.draft.clearSure' : 'ui.draft.clear'));
    tool.querySelector('.dsure span').textContent = U('ui.draft.clearSure');
    T('finger').querySelector('span').textContent = U('ui.draft.finger');
    paintZoom(true); paintUndo();
  }
  let lt = 0; const lw = setInterval(() => { const b = B(); if ((b && b.ui && b.ui.ui) || ++lt > 80) { clearInterval(lw); labels(); } }, 250);   // kit/ui.json 到了再写字

  function paintTool() {
    const pal = PAL[theme()];
    root.style.setProperty('--da', String(ui.alpha));
    T('pen').classList.toggle('on', ui.tool === 'pen'); T('eraser').classList.toggle('on', ui.tool === 'eraser');
    T('color').querySelector('i').style.background = pal[ui.color];
    tool.querySelectorAll('.dpal [data-c]').forEach((b) => { b.querySelector('i').style.background = pal[b.dataset.c]; b.classList.toggle('on', b.dataset.c === ui.color); });
    const al = T('alpha'); al.style.setProperty('--v', String(ui.alpha)); al.setAttribute('aria-valuenow', String(Math.round(ui.alpha * 100)));
    T('finger').classList.toggle('on', !!ui.finger); T('finger').setAttribute('aria-checked', String(!!ui.finger));
    paintUndo(); sync();
  }
  const pctOf = (z) => (z < 0.095 ? Math.round(z * 1000) / 10 : Math.round(z * 100));
  let lastPct = null;
  function paintZoom(force) {
    const n = pctOf(V.z); if (n === lastPct && !force) return; lastPct = n;
    const b = T('zoom'); b.querySelector('span').textContent = n + '%';
    b.setAttribute('aria-label', String(U('ui.draft.zoom') || '').replace('{n}', n));
  }
  const NV = { undo: false, bounds: null };   // App 回报的：新笔迹能不能撤销、新笔迹在纸面上的范围 [x0, y0, x1, y1]
  function paintUndo() { T('undo').disabled = NI() ? !NV.undo : !D.hist.length; }
  /* 纸上面那几层（工具条、草稿纸按钮、弹层、问答面板、抽屉……）在屏幕上的位置：App 在这些地方不收笔、不显示新字 */
  /* 键盘弹出时页面会在屏幕上整体错开（visualViewport.offsetTop）：报给 App 的位置要换成屏幕上的 */
  const vvOff = () => { const v = window.visualViewport; return v ? [v.offsetLeft || 0, v.offsetTop || 0] : [0, 0]; };
  function aboveRects() {
    const o = vvOff(), out = [], add = (el) => { if (!el) return; const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) out.push([r.left - o[0], r.top - o[1], r.width, r.height]); };
    if (!tool.classList.contains('dhide')) {
      if (D.toolGoal && !tool.classList.contains('moving')) { const g = D.toolGoal; out.push([g[0] - o[0], g[1] - o[1], g[2], g[3]]); }   // 过渡还没走完也报它要到的地方
      else add(tool);
    }
    if (!NI()) add(btn); tool.querySelectorAll('.dpop.on').forEach(add); add($('.toast.on'));
    ABOVE.forEach((k) => { const el = $(k); if (el && el.classList.contains('on')) add(el); });
    return out;
  }
  let lastSent = '';
  function sync(force) {
    if (!NI()) return;
    const br = btn.getBoundingClientRect();
    /* 网页的草稿纸按钮在 App 里只占位；它所在的地方被抽屉、问答面板这些层盖住时告诉 App，App 的按钮也跟着藏（和网页按钮被盖住一样） */
    let covered = false;
    try {   // 按钮本身 visibility:hidden，取它中心点下面看得见的那个元素：属于这几层之一就是被盖住了
      if (br.width > 0) { const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2); covered = !!(hit && ABOVE.some((k) => { const el = hit.closest(k); return !!el && el.classList.contains('on'); })); }
    } catch (e) {}
    const m = { k: 'state', open: D.open, id: D.open ? D.id : null, tool: ui.tool, color: ui.color, finger: !!ui.finger, theme: theme(), view: { x: V.x, y: V.y, z: V.z }, rects: D.open ? aboveRects() : [],
      btn: [br.left - vvOff()[0], br.top - vvOff()[1], br.width, br.height], covered, labels: { open: U('ui.draft.open'), close: U('ui.draft.close') } };
    const js = JSON.stringify(m); if (js === lastSent && !force) return; lastSent = js; m.ts = Date.now(); tell(m);   // ts：发出时刻（App 量"晚到"用），不参与比较
  }
  function flash(a) { const b = T(a); tool.querySelectorAll('.flash').forEach((x) => x.classList.remove('flash')); void b.offsetWidth; b.classList.add('flash'); clearTimeout(b._ft); b._ft = setTimeout(() => b.classList.remove('flash'), 700); }

  /* 工具条的位置：贴左边或右边，竖着的位置按屏幕高度的比例记；横屏问答面板开着时贴右边的让到面板左边，竖屏不压面板。
     2026-11-22 动画走查：面板一开关（类名、宽度、高度变量一变）当场按面板“到位以后”的大小算出工具条的目标位置，用 transform 过渡过去，
     和面板同一档时长、同一条缓动（draft.css），同一帧起步、同一帧到位。 */
  const portrait = () => matchMedia('(orientation: portrait)').matches;
  const cssVar = (el, k) => parseFloat(getComputedStyle(el).getPropertyValue(k)) || 0;
  function fbGoal() {   // 问答面板到位以后占的地方：横屏给左边沿 x，竖屏给上沿 y；没开给 null
    const fb = $('#fbp'); if (!fb || !fb.classList.contains('on')) return null;
    const W = innerWidth, H = innerHeight, wide = fb.classList.contains('wide'), de = document.documentElement;
    if (!portrait()) {
      const w = wide ? Math.max(300, Math.min(W * 0.66, 820)) : Math.max(300, Math.min(W * 0.4, cssVar(de, '--fbw') * W / 100 || W * 0.34));
      return { x: W - w };
    }
    const kb = parseFloat(fb.style.getPropertyValue('--kb')) || 0;
    const h = wide ? H - kb - 56 : Math.min((cssVar(de, '--fbh') || 50) * H / 100, H - kb - 8);
    return { y: H - kb - h };
  }
  function layout() {
    if (!tool.classList.contains('on') || tool.classList.contains('moving')) return;
    const W = innerWidth, H = innerHeight, g = fbGoal();
    let top = 8, bot = H - 8, right = W;
    if (g) { if (g.x != null) right = g.x; else bot = Math.min(bot, g.y - 8); }
    /* 放不下（竖屏问答面板开着、屏幕矮）：先收紧（间距、透明度竖条变短）；还放不下（比如问答面板放大了）就整个收起，
       面板缩回去再出现。收起时不报给 App（App 的开关按钮还在，照样能收起草稿纸）。不折成多列：多列会盖住面板上的按钮。 */
    tool.classList.remove('dtight');
    if (tool.offsetHeight > bot - top) tool.classList.add('dtight');
    const hide = tool.offsetHeight > bot - top;
    if (hide && !tool.classList.contains('dhide')) closePops();
    tool.classList.toggle('dhide', hide);
    const h = tool.offsetHeight, w = tool.offsetWidth;
    const x = Math.round(ui.side === 'l' ? 10 : right - w - 10), y = Math.round(Math.max(top, Math.min(bot - h, ui.y * H - h / 2)));
    tool.style.setProperty('--dx', x + 'px'); tool.style.setProperty('--dy', y + 'px'); tool.dataset.side = ui.side;
    D.toolGoal = [x, y, w, h];
    sync();   // 报的就是算出来的目标位置（aboveRects 用 D.toolGoal），不用等过渡走完
  }
  /* 全局按钮放进问答气泡那一组（.fbx）的最左边，和气泡一起排版、一起移动；被问答面板 / 原卷浮层盖住时自然被盖住（层的高低在 draft.css）。
     没有题的空页只留它（shell.css）；.fbx 不在（别的页面）才放在 body 右上角。 */
  function placeBtn() {
    const fx = $('.fbx');
    if (fx) { if (btn.parentNode !== fx) fx.insertBefore(btn, fx.firstChild); }
    else if (btn.parentNode !== document.body) { document.body.appendChild(btn); Object.assign(btn.style, { position: 'fixed', right: '16px', top: '12px' }); }
  }
  setInterval(() => { layout(); watchId(); sync(); }, 400);
  /* 纸上面那几层（问答面板、抽屉、原卷、提示条）一出现 / 消失就立刻报给 App，不等上面 400 毫秒的轮询 */
  if (NI()) {
    const isAbove = (t) => t && t.nodeType === 1 && (ABOVE.some((k) => t.matches(k)) || t.classList.contains('toast'));
    new MutationObserver((ms) => { if (D.open && ms.some((m) => isAbove(m.target))) sync(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['class'], subtree: true });
    new MutationObserver(() => { if (D.open) sync(); }).observe(document.body || document.documentElement, { childList: true });
  }
  /* 诊断（App 里）：网页主线程有没有被卡住——每 50 毫秒打一次拍，两拍之间隔了 250 毫秒以上就记下"从几点起卡了多久"；
     草稿纸自己的几个函数（重画、报状态）超过 30 毫秒也记一笔。App 的状态探针读 window.__b2perf。 */
  if (NI()) {
    const P = window.__b2perf = { gaps: [], slow: [] }; let beat = performance.now(), bt = 0;
    /* 只在草稿纸开着时打拍（open / close 里开关） */
    P.start = () => { if (bt) return; beat = performance.now(); bt = setInterval(() => { const n = performance.now(); if (n - beat > 250) { const g = Math.round(performance.timeOrigin + beat) + '+' + Math.round(n - beat); P.gaps.push(g); if (P.gaps.length > 12) P.gaps.shift(); if (window.__b2shotmode) try { window.webkit.messageHandlers.b2shell.postMessage({ k: 'clicklog', v: 'web main blocked ' + g }); } catch (e) {} } beat = n; }, 50); };
    P.stop = () => { clearInterval(bt); bt = 0; };
    if (window.__b2shotmode) P.start();   // 云端测试（截图模式）：草稿纸收着也打拍，查"收起后第一下点页面晚"这类事（平时只在开着时跑）
    P.stop0 = P.stop; if (window.__b2shotmode) P.stop = () => {};
    P.time = (name, f) => function () { const t0 = performance.now(); try { return f.apply(this, arguments); } finally { const d = performance.now() - t0; if (d > 30) { P.slow.push(name + '@' + Math.round(performance.timeOrigin + t0) + '+' + Math.round(d)); if (P.slow.length > 12) P.slow.shift(); } } };
  }
  (function hookId() {   // 原生笔迹：Board2.id / Board2.mock 一被改就立刻 watchId（不然换题后最长 0.4 秒内写的字会记到上一题）
    const S = B(); if (!NI() || !S || S.__b2DraftHook) return; S.__b2DraftHook = 1;
    ['id', 'mock'].forEach((k) => {
      let v = S[k];
      try {
        Object.defineProperty(S, k, { configurable: true, enumerable: true, get() { return v; },
          set(n) { const ch = n !== v; v = n; if (ch && D.open) Promise.resolve().then(watchId); } });
      } catch (e) {}
    });
  })();   // 兜底；正常情况下面板一变就已经算好了
  /* 转屏 / 窗口变了：屏幕中心对着纸面上的同一个点，缩放不变 */
  addEventListener('resize', () => {
    const W = innerWidth, H = innerHeight;
    if (NI()) { D.W = W; D.H = H; layout(); if (D.open) { size(); render(); } return; }   // 原生笔迹：取景窗由 App 定（它转屏时自己保持中心），转完会把新的告诉这里
    if (D.doc && (W !== D.W || H !== D.H)) {
      const cx = (D.W / 2 - V.x) / V.z, cy = (D.H / 2 - V.y) / V.z;
      D.W = W; D.H = H; setView(W / 2 - cx * V.z, H / 2 - cy * V.z, V.z, true);
    } else { D.W = W; D.H = H; }
    layout(); if (D.open) { size(); render(); } sync();
  });
  function watchFb() {
    const fb = $('#fbp'); if (!fb) return;
    const mo = new MutationObserver(() => { tool.classList.toggle('fbsize', fb.classList.contains('sizing')); layout(); });
    mo.observe(fb, { attributes: true, attributeFilter: ['class', 'style'] });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });   // --fbw / --fbh（kit/ask.js 的 applySize）
  }

  /* ---------- 打开、收起、换题 ---------- */
  const keyNow = () => { const b = B(); return b && b.id && !b.mock ? b.id : '_common'; };
  async function open() {
    D.open = true; root.classList.add('on'); tool.classList.add('on', 'jump'); btn.classList.add('open'); labels();
    if (window.__b2perf && __b2perf.start) __b2perf.start();
    size(); layout(); void tool.offsetWidth; tool.classList.remove('jump');   // 刚露出来：直接出现在该在的地方，不从左上角飞过去
    const k = keyNow(); if (k !== D.id || !D.doc) await load(k); render(); sync(true);
  }
  function close() {
    endTouchAll(); flush(); D.open = false; D.cur = null; closePops(); D.clears = [];
    if (window.__b2perf && __b2perf.stop) __b2perf.stop();
    root.classList.remove('on'); tool.classList.remove('on'); btn.classList.remove('open'); labels(); sync(true);
  }
  btn.addEventListener('click', () => (D.open ? close() : open()));
  function watchId() { if (!D.open) return; const k = keyNow(); if (k !== D.id) { flush(); D.cur = null; load(k).then(() => { render(); sync(true); }); } }

  /* ---------- 存、取、旧格式迁移 ---------- */
  const blank = () => ({ v: 2, t: 0, view: null, s: [], pages: [] });
  const okNum = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  function normStroke(x) {
    if (!x || !Array.isArray(x.p)) return null;
    const p = x.p.map(Number); p.length -= p.length % 3; if (!p.length || p.some((v) => !isFinite(v))) return null;
    const o = Array.isArray(x.o) ? x.o : [0, 0];
    return { c: COLORS.includes(x.c) ? x.c : 'ink', w: okNum(+x.w, x.e ? ERASE_W : PEN_W), e: x.e ? 1 : 0, k: okNum(+x.k, 1) > 0 ? okNum(+x.k, 1) : 1, o: [okNum(+o[0], 0), okNum(+o[1], 0)], p };
  }
  function okView(v) { return v && isFinite(+v.cx) && isFinite(+v.cy) && +v.z > 0 ? { cx: +v.cx, cy: +v.cy, z: clampZ(+v.z) } : null; }
  /* 读进来的一份：新格式整理一下；旧格式（多页）迁移。返回 [doc, 是不是迁移来的] */
  function fix(doc) {
    if (!doc || typeof doc !== 'object') return [blank(), false];
    if (doc.v === 2 && Array.isArray(doc.s)) return [{ v: 2, t: okNum(doc.t, 0), view: okView(doc.view), s: doc.s.map(normStroke).filter(Boolean), pages: [] }, false];
    if (!Array.isArray(doc.pages)) return [blank(), false];
    const out = blank(); out.t = okNum(doc.t, 0); let y = 0, ycur = 0;
    const cur = Math.max(0, Math.min(doc.pages.length - 1, doc.cur | 0));
    doc.pages.forEach((pg, i) => {
      if (!pg || !Array.isArray(pg.s)) return;
      if (i === cur) ycur = y;
      pg.s.forEach((st) => { const n = normStroke(st && { c: st.c, w: st.w, e: st.e, k: 1, o: [0, y], p: st.p }); if (n) out.s.push(n); });
      y += (+pg.h > 0 ? +pg.h : innerHeight) + GAP;
    });
    if (ycur > 0) out.view = { cx: innerWidth / 2, cy: ycur + innerHeight / 2, z: 1 };   // 旧的“当前页”不是第一页：取景窗放到那一页的左上角
    return [out, true];
  }
  function applyDocView() {
    const v = D.doc && D.doc.view; D.W = innerWidth; D.H = innerHeight;
    if (!v) { V.x = 0; V.y = 0; V.z = 1; } else { V.z = v.z; V.x = D.W / 2 - v.cx * v.z; V.y = D.H / 2 - v.cy * v.z; }
    paintZoom();
  }
  async function load(id) {
    const tok = ++D.tok;
    unsure(); D.clears = [];
    /* 先放一张空的占位稿，等电脑那份回来（真机走局域网可能要好几百毫秒）。占位期间用户做的事（挪纸、清空、写字）回来后不许被盖掉 */
    const ph = blank(); ph.ph = true;
    D.id = id; D.doc = ph; D.hist = []; applyDocView(); paintUndo();
    const v0 = { x: V.x, y: V.y, z: V.z };
    if (NI()) sync(true);   // 原生笔迹：换题立刻告诉 App，之后写的字记到新题
    const local = stored(LKEY + id, null);
    let srv = null;
    if (D.server !== false) {
      try {
        const r = await fetch('draft?id=' + encodeURIComponent(id) + '&t=' + Date.now());
        if (r.status === 404) D.server = false; else if (r.ok) { D.server = true; srv = (await r.json()).doc || null; }
      } catch (e) {}
    }
    if (tok !== D.tok) return;
    const pick = local && local.doc && (!srv || (local.doc.t || 0) > (srv.t || 0)) ? local.doc : srv;
    const [doc, mig] = fix(pick ? JSON.parse(JSON.stringify(pick)) : null);
    if (ph.cleared) {   // 加载中已经清空过：回来的旧稿算在那次清空里一起清掉（撤销那次清空时一起回来）
      const rec = NI() ? D.clears.find((c) => c.ph === ph) : D.hist.find((h) => h.k === 'clear' && h.ph === ph);
      if (rec) rec.s = doc.s.concat(rec.s);
      doc.s = [];
    }
    doc.s = doc.s.concat(ph.s);   // 加载中写的（网页自己画的时候）接在后面
    const moved = V.x !== v0.x || V.y !== v0.y || V.z !== v0.z;
    D.doc = doc; bbs = new WeakMap();   // D.hist 保留：加载中的写字、清空照样能撤销
    D.dirty = !!(pick && ((pick === (local && local.doc) && D.server) || mig)) || ph.s.length > 0 || !!ph.cleared;   // 本机那份更新 / 迁移 / 加载中改过：待会儿存
    D.migrated = mig ? { from: id, strokes: doc.s.length } : null;
    if (NI() && ((pick && pick === (local && local.doc)) || ph.cleared)) putV2();   // App 里：本机那份更新、或加载中清空过：写回电脑
    /* 加载中取景窗动过（自己挪了纸，或 App 已经按它存的取景窗摆好并告诉了这里）：不按旧稿再摆一次；没动过才用旧稿存的取景窗（App 没存过时它跟着用） */
    if (moved) { if (!NI()) setView(V.x, V.y, V.z, true); } else applyDocView();
    paintUndo(); if (D.dirty) later();
  }
  /* App 里写回旧稿（只有清空 / 撤销清空时）：按先后排队一个一个写；写不上（离线、电脑没开）先存本机，下次打开这道题时本机那份更新就补传 */
  let v2q = Promise.resolve();
  const memPend = new Map();   // 本机存不下（localStorage 满了 / 不让存）的待传旧稿，留在内存里补传
  function postV2(id, doc) {
    return fetch('draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, doc }) })
      .then((r) => {
        if (!r.ok) return;
        const l = stored(LKEY + id, null); if (l && l.doc && l.doc.t === doc.t) try { localStorage.removeItem(LKEY + id); } catch (e) {}
        const m = memPend.get(id); if (m && m.t === doc.t) memPend.delete(id);
      })
      .catch(() => {});
  }
  function putV2() {
    if (!D.doc || !D.id) return;
    const id = D.id, doc = JSON.parse(JSON.stringify(D.doc)); doc.t = Date.now(); delete doc.ph; delete doc.cleared;
    if (!store(LKEY + id, { doc, pend: 1 })) memPend.set(id, doc);   // 先存本机：电脑那头没写成也不会回来；本机也存不下就记在内存里
    else memPend.delete(id);
    v2q = v2q.then(() => postV2(id, doc));
  }
  /* App 告诉"连上电脑了 / 回到前台了"时：把所有待传的旧稿按时间先后补传。先取电脑那份对时间，电脑那份更新（别处改过）就不传、丢掉本机的 */
  function retryPending() {
    if (!NI()) return;
    const items = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i); if (!k || k.indexOf(LKEY) !== 0) continue;
        const v = stored(k, null); if (v && v.pend && v.doc) items.push({ id: k.slice(LKEY.length), doc: v.doc });
      }
    } catch (e) {}
    memPend.forEach((doc, id) => { if (!items.some((x) => x.id === id)) items.push({ id, doc }); });
    items.sort((a, b) => (a.doc.t || 0) - (b.doc.t || 0));
    items.forEach(({ id, doc }) => {
      v2q = v2q.then(() => fetch('draft?id=' + encodeURIComponent(id) + '&t=' + Date.now()).then((r) => (r.ok ? r.json() : null)).catch(() => null)
        .then((j) => {
          if (j === null) return;   // 还是连不上：留着下次
          const srv = j && j.doc;
          if (srv && (srv.t || 0) >= (doc.t || 0)) { try { localStorage.removeItem(LKEY + id); } catch (e) {} memPend.delete(id); return; }
          return postV2(id, doc);
        }));
    });
  }
  function later(ms) { clearTimeout(D.saveT); D.saveT = setTimeout(flush, ms || 1200); }
  function keepLocal(id, doc) { if (!store(LKEY + id, { doc })) return; if (!D.warned && B() && B().api) { D.warned = true; B().api.toast(U('ui.draft.local')); } }
  function flush(leaving) {
    clearTimeout(D.saveT);
    if (NI()) { D.dirty = false; D.vdirty = false; return; }   // 原生笔迹：旧的 <题号>.json 只读，不再写（新字和取景窗由 App 存）
    if (!(D.dirty || D.vdirty) || !D.doc || !D.id) return;
    const id = D.id, doc = D.doc; doc.t = Date.now(); D.dirty = false; D.vdirty = false;
    const body = JSON.stringify({ id, doc });
    if (D.server === false) { keepLocal(id, doc); return; }
    if (leaving) { store(LKEY + id, { doc }); try { fetch('draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: body.length < 60000 }); } catch (e) {} return; }   // 离开页面：本机先存一份，电脑上的下次打开对时间取新的
    fetch('draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).then((r) => {
      if (r.ok) { try { localStorage.removeItem(LKEY + id); } catch (e) {} D.server = true; return; }
      if (r.status === 404) D.server = false;
      keepLocal(id, doc);
    }).catch(() => keepLocal(id, doc));
  }
  addEventListener('pagehide', () => flush(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });

  /* ---------- 取景窗 ---------- */
  /* 设取景窗；记进这道题的草稿（屏幕中心对着的纸面点 + 缩放），只挪了取景窗的 4 秒后存 */
  function setView(x, y, z, quiet) {
    V.x = x; V.y = y; V.z = z; paintZoom();
    if (!D.doc) return;
    const W = innerWidth, H = innerHeight;
    D.doc.view = Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6 && Math.abs(z - 1) < 1e-9 && W === D.W && H === D.H ? null
      : { cx: Math.round((W / 2 - x) / z * 100) / 100, cy: Math.round((H / 2 - y) / z * 100) / 100, z: +z.toPrecision(6) };
    if (!quiet || D.doc.s.length) { D.vdirty = true; if (!D.dirty) later(4000); }
  }
  /* 渲染出来的那张位图对应的取景窗（D.xf）和现在的取景窗不一样时，用 CSS 变换把位图挪过去（手势中途、飞回去的路上） */
  function paintXf() {
    const R = D.xf; if (!R) { cv.style.transform = ''; return; }
    const s = V.z / R.z, tx = V.x - R.x * s, ty = V.y - R.y * s;
    cv.style.transform = `matrix(${s},0,0,${s},${tx},${ty})`;
  }
  let raf = 0, stallT = 0;
  function frame() {   // 取景窗变了以后的一帧
    raf = 0;
    if (D.rms < 8) { render(); return; }
    if (!D.xf) D.xf = { x: D.rv.x, y: D.rv.y, z: D.rv.z };
    paintXf();
    clearTimeout(stallT); stallT = setTimeout(() => { if (G || fly || NI()) render(); }, 120);   // 手停住了：矢量重画一次
  }
  const want = () => { if (!raf) raf = requestAnimationFrame(frame); };
  /* 点缩放比例：回到 100%，并回到有笔迹的地方 */
  function homeView(nat) {
    const W = innerWidth, H = innerHeight, s = D.doc ? D.doc.s.filter((x) => !x.e) : [];
    const boxes = s.map(bbox); if (nat && NV.bounds) boxes.push(NV.bounds);   // App 里：新笔迹整体算一块（也当"最后写的"）
    if (!boxes.length) return nat ? null : { x: 0, y: 0, z: 1 };   // App 里一笔都没有：交给 App 以屏幕中心回到 100%
    let any = false, a = [Infinity, Infinity, -Infinity, -Infinity];
    boxes.forEach((b) => { if (b[2] > 0 && b[0] < W && b[3] > 0 && b[1] < H) any = true; a = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]; });
    if (any) return { x: 0, y: 0, z: 1 };
    let c;
    if (a[2] - a[0] <= W * 0.9 && a[3] - a[1] <= H * 0.9) c = [(a[0] + a[2]) / 2, (a[1] + a[3]) / 2];
    else { const b = boxes[boxes.length - 1]; c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }
    return { x: Math.round(W / 2 - c[0]), y: Math.round(H / 2 - c[1]), z: 1 };
  }
  let fly = 0;
  function flyTo(to) {
    cancelAnimationFrame(fly); fly = 0;
    const ms = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--m-big')) || 0;
    const W = innerWidth, H = innerHeight, z0 = V.z, c0 = [(W / 2 - V.x) / V.z, (H / 2 - V.y) / V.z], c1 = [(W / 2 - to.x) / to.z, (H / 2 - to.y) / to.z];
    if (!ms || !D.open) { setView(to.x, to.y, to.z); render(); return; }
    const t0 = performance.now();
    const step = (now) => {
      const u = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - u, 3);
      const z = z0 * Math.pow(to.z / z0, e), cx = c0[0] + (c1[0] - c0[0]) * e, cy = c0[1] + (c1[1] - c0[1]) * e;
      if (u >= 1) { fly = 0; setView(to.x, to.y, to.z); render(); return; }
      setView(W / 2 - cx * z, H / 2 - cy * z, z); frame(); fly = requestAnimationFrame(step);
    };
    fly = requestAnimationFrame(step);
  }

  /* ---------- 画 ---------- */
  let bbs = new WeakMap();
  function bbox(st) {   // 纸面坐标的包围盒（含半个线宽）
    let b = bbs.get(st); if (b) return b;
    const p = st.p, k = st.k; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) { const x = p[i], y = p[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const pad = st.w * 1.37 / 2 + 1;
    b = [st.o[0] + (x0 - pad) * k, st.o[1] + (y0 - pad) * k, st.o[0] + (x1 + pad) * k, st.o[1] + (y1 + pad) * k];
    bbs.set(st, b); return b;
  }
  function size() {
    const r = dpr(), W = innerWidth, H = innerHeight;
    if (cv.width !== Math.round(W * r) || cv.height !== Math.round(H * r)) { cv.width = Math.round(W * r); cv.height = Math.round(H * r); }
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
  }
  const widthAt = (st, pr) => (st.e ? st.w : st.w * (0.42 + 0.95 * pr));
  function style(st) {
    ctx.globalCompositeOperation = st.e ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ctx.fillStyle = st.e ? '#000' : PAL[theme()][st.c] || PAL[theme()].ink;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  }
  /* 一笔的坐标系：笔里的点（相对起点的屏幕像素）→ 设备像素 */
  function setST(st, s) { const r = dpr(); ctx.setTransform(r * s, 0, 0, r * s, r * (V.x + st.o[0] * V.z), r * (V.y + st.o[1] * V.z)); }
  /* 正在写的这一笔：第 i 个点到了，画从上一段中点到这一段中点的二次曲线（控制点是第 i-1 个点），粗细取控制点的压感 */
  function seg(st, i) {
    const p = st.p, n = p.length / 3; if (i < 1 || i >= n) return;
    const x0 = i === 1 ? p[0] : (p[(i - 2) * 3] + p[(i - 1) * 3]) / 2, y0 = i === 1 ? p[1] : (p[(i - 2) * 3 + 1] + p[(i - 1) * 3 + 1]) / 2;
    const cx = p[(i - 1) * 3], cy = p[(i - 1) * 3 + 1], x1 = (cx + p[i * 3]) / 2, y1 = (cy + p[i * 3 + 1]) / 2;
    ctx.lineWidth = widthAt(st, p[(i - 1) * 3 + 2]);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(cx, cy, x1, y1); ctx.stroke();
  }
  function tail(st) {
    const p = st.p, n = p.length / 3;
    if (n === 1) { ctx.beginPath(); ctx.arc(p[0], p[1], widthAt(st, p[2]) / 2, 0, Math.PI * 2); ctx.fill(); return; }
    const k = (n - 1) * 3, x0 = n === 2 ? p[0] : (p[k - 3] + p[k]) / 2, y0 = n === 2 ? p[1] : (p[k - 2] + p[k + 1]) / 2;
    ctx.lineWidth = widthAt(st, p[k + 2]); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(p[k], p[k + 1]); ctx.stroke();
  }
  /* 整笔重画：屏幕上不到 0.7 像素的相邻点跳过；粗细按 7% 一档取整，同一档的连续几段并成一条路径一次画；太细的笔画至少 0.4 像素宽 */
  const LQ = 0.07;
  function drawAll(st) {
    const p = st.p, n = p.length / 3, s = V.z * st.k;
    setST(st, s); style(st);
    const minW = st.e ? 0 : 0.4 / s, step = 0.7 / s, q = (w) => { const ws = Math.max(w * s, 0.01); return Math.exp(Math.round(Math.log(ws) / LQ) * LQ) / s; };
    if (n === 1) { ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(minW, widthAt(st, p[2])) / 2, 0, Math.PI * 2); ctx.fill(); return; }
    const ix = [0]; let lx = p[0], ly = p[1];
    for (let i = 1; i < n - 1; i++) { const x = p[i * 3], y = p[i * 3 + 1]; if (Math.abs(x - lx) + Math.abs(y - ly) >= step) { ix.push(i); lx = x; ly = y; } }
    ix.push(n - 1);
    const m = ix.length; let cw = -1;
    if (m === 2) { ctx.lineWidth = Math.max(minW, widthAt(st, p[2])); ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]); ctx.stroke(); return; }
    const X = (j) => p[ix[j] * 3], Y = (j) => p[ix[j] * 3 + 1], P = (j) => p[ix[j] * 3 + 2];
    for (let j = 1; j < m; j++) {
      const x0 = j === 1 ? X(0) : (X(j - 2) + X(j - 1)) / 2, y0 = j === 1 ? Y(0) : (Y(j - 2) + Y(j - 1)) / 2;
      const cx = X(j - 1), cy = Y(j - 1), x1 = (cx + X(j)) / 2, y1 = (cy + Y(j)) / 2;
      const w = q(Math.max(minW, widthAt(st, P(j - 1))));
      if (w !== cw) { if (cw > 0) ctx.stroke(); ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x0, y0); cw = w; }
      ctx.quadraticCurveTo(cx, cy, x1, y1);
    }
    const xl = X(m - 1), yl = Y(m - 1), w = q(Math.max(minW, widthAt(st, P(m - 1))));
    if (w !== cw) { ctx.stroke(); ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo((X(m - 2) + xl) / 2, (Y(m - 2) + yl) / 2); }
    ctx.lineTo(xl, yl); ctx.stroke();
  }
  function visible(st, W, H) {
    const b = bbox(st), z = V.z;
    return b[2] * z + V.x > 0 && b[0] * z + V.x < W && b[3] * z + V.y > 0 && b[1] * z + V.y < H;
  }
  function render() {
    if (!D.open || !D.doc) return;
    const t0 = performance.now();
    size(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
    const W = innerWidth, H = innerHeight; let n = 0;
    for (const st of D.doc.s) if (visible(st, W, H)) { drawAll(st); n++; }
    if (D.cur && D.cur.st && D.cur.st.p.length && !D.doc.s.includes(D.cur.st)) drawAll(D.cur.st);
    ctx.globalCompositeOperation = 'source-over'; ctx.setTransform(1, 0, 0, 1, 0, 0);
    D.xf = null; D.rv = { x: V.x, y: V.y, z: V.z }; cv.style.transform = '';
    D.rms = performance.now() - t0; D.stats.renders++; D.stats.drawn = n;
    paintUndo();
  }
  new MutationObserver(() => { paintTool(); render(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  /* ---------- 笔和手 ---------- */
  const ABOVE = ['#fbp', '#drawer', '#sheet', '#weak', '#akPg', '#akHere'];
  function above(t) {
    if (!t || !t.closest) return false;
    if (t.closest('#dtool, #draftBtn, .toast')) return true;
    return ABOVE.some((k) => { const el = t.closest(k); return !!el && el.classList.contains('on'); });
  }
  const penBusy = () => (D.cur && D.cur.pen) || performance.now() - D.lastPen < PALM_MS;
  const wants = (e) => D.open && D.doc && !above(e.target) && (e.pointerType === 'pen' || (ui.finger && (e.pointerType === 'touch' || e.pointerType === 'mouse')));
  const eat = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  /* 手指的 pointer：F = 落在纸上（不在上面那几层）、还按着的手指（穿透给下面的，或手指也能画时正在画的）；SW = 吞掉的（掌根、双指手势里的），一直吞到它抬起 */
  const F = new Map(), SW = new Set(); let synth = false;
  function swallowFingers() {   // 双指手势开始：下面已经收到 pointerdown 的手指发一个 pointercancel，让它们的手势作废，之后吞掉
    F.forEach((r, id) => {
      SW.add(id);
      if (r.pass) { synth = true; try { r.t.dispatchEvent(new PointerEvent('pointercancel', { pointerId: id, pointerType: 'touch', isPrimary: !!r.primary, bubbles: true, clientX: r.x, clientY: r.y })); } catch (e) {} synth = false; }
    });
    F.clear();
    if (D.cur && !D.cur.pen) { D.cur = null; render(); }   // 手指也能画：第一根手指刚画的那一笔作废
    D.lastDraw = performance.now();
  }
  function pt(e, c) { const pr = e.pointerType === 'pen' ? (e.pressure > 0 ? e.pressure : 0.5) : 0.5; c.st.p.push(rd(e.clientX - c.sx), rd(e.clientY - c.sy), Math.round(pr * 100) / 100); }
  addEventListener('pointerdown', (e) => {
    if (!D.open || NI()) return;   // 原生笔迹：触摸全是 App 的画布在收，这里什么都不拦
    if (e.pointerType === 'touch') {
      if (above(e.target)) return;
      if (G || SW.has(e.pointerId)) { eat(e); SW.add(e.pointerId); return; }
      if (penBusy()) { eat(e); SW.add(e.pointerId); return; }   // 掌根
      if (F.size || T2.size >= 2) { eat(e); SW.add(e.pointerId); swallowFingers(); claim = true; return; }   // 第二根手指：双指手势
      F.set(e.pointerId, { t: e.target, pass: !ui.finger, primary: e.isPrimary, x: e.clientX, y: e.clientY });
      if (!ui.finger) return;   // 单指穿透给下面
    }
    if (!wants(e)) return;
    eat(e); closePops();
    if (G && e.pointerType === 'pen') stopGesture();   // 双指正在挪，笔落下：手势就地停住
    if (D.cur) end(D.cur.e || e);
    if (D.xf || raf || fly) { cancelAnimationFrame(fly); fly = 0; cancelAnimationFrame(raf); raf = 0; render(); }
    const erase = ui.tool === 'eraser' || (e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32)));
    const sx = e.clientX, sy = e.clientY;
    const st = { c: ui.color, w: erase ? ERASE_W : PEN_W, e: erase ? 1 : 0, k: +(1 / V.z).toPrecision(6), o: [r3((sx - V.x) / V.z), r3((sy - V.y) / V.z)], p: [] };
    D.cur = { id: e.pointerId, st, sx, sy, pen: e.pointerType === 'pen', e };
    pt(e, D.cur); setST(st, 1); style(st);
    if (e.pointerType === 'pen') D.lastPen = performance.now();
  }, true);
  addEventListener('pointermove', (e) => {
    if (NI()) return;
    if (SW.has(e.pointerId)) { eat(e); return; }
    if (!D.cur || e.pointerId !== D.cur.id) { const r = F.get(e.pointerId); if (r) { r.x = e.clientX; r.y = e.clientY; } return; }
    eat(e);
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : []; const c = D.cur, st = c.st;
    const r = dpr(); ctx.setTransform(r, 0, 0, r, r * c.sx, r * c.sy); style(st);
    (evs.length ? evs : [e]).forEach((x) => { pt(x, c); seg(st, st.p.length / 3 - 1); });
    if (e.pointerType === 'pen') D.lastPen = performance.now();
  }, true);
  function end(e) {
    const c = D.cur; D.cur = null; if (!c) return;
    const st = c.st, r = dpr(); ctx.setTransform(r, 0, 0, r, r * c.sx, r * c.sy); style(st); tail(st); ctx.globalCompositeOperation = 'source-over';
    D.doc.s.push(st); D.hist.push({ k: 'add' });
    D.dirty = true; D.lastDraw = performance.now(); if (c.pen) D.lastPen = performance.now();
    paintUndo(); later();
  }
  const up = (e) => {
    if (synth || NI()) return;
    if (SW.has(e.pointerId)) { eat(e); SW.delete(e.pointerId); return; }
    F.delete(e.pointerId);
    if (!D.cur || e.pointerId !== D.cur.id) return; eat(e); end(e);
  };
  addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true);
  /* 画完、双指挪完那一下浏览器照样会补一个 click 给下面的东西（选项、题干），吞掉 */
  addEventListener('click', (e) => { if (D.open && !NI() && performance.now() - D.lastDraw < 450 && !above(e.target)) eat(e); }, true);

  /* ---------- 双指：移动、缩放取景窗（touch 事件算，pointer 那边只管吞） ---------- */
  /* T2 = 落在纸上的手指（不在上面那几层、不是掌根、不是笔）；G = 正在进行的双指手势 */
  const T2 = new Map(), PALM = new Set(); let G = null, claim = false;
  const finger = (t) => t.touchType !== 'stylus';
  function anchor() {   // 手指的集合变了：按现在的位置重新定锚点
    const pts = [...G.t.values()]; if (!pts.length) return;
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    G.c = [cx, cy]; G.d = pts.length > 1 ? pts.reduce((a, p) => a + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length : 0;
    G.z0 = V.z; G.P = [(cx - V.x) / V.z, (cy - V.y) / V.z];
  }
  function startGesture() {
    if (G) return;
    cancelAnimationFrame(fly); fly = 0;
    G = { t: new Map(T2), dead: false }; swallowFingers(); claim = false; anchor();
  }
  function moveGesture() {
    if (!G || G.dead) return;
    const pts = [...G.t.values()]; if (!pts.length) return;
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    let z = G.z0;
    if (G.d > 8 && pts.length > 1) { const d = pts.reduce((a, p) => a + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length; z = clampZ(G.z0 * d / G.d); }
    setView(cx - G.P[0] * z, cy - G.P[1] * z, z); want();
  }
  function stopGesture() { if (!G) return; G.dead = true; if (D.xf) render(); }
  function endGesture() { G = null; D.lastDraw = performance.now(); clearTimeout(stallT); cancelAnimationFrame(raf); raf = 0; if (D.open) render(); }
  function endTouchAll() { T2.clear(); PALM.clear(); F.clear(); SW.clear(); if (G) endGesture(); claim = false; }
  addEventListener('touchstart', (e) => {
    if (!D.open || NI()) return;
    for (const t of e.changedTouches) {
      if (!finger(t)) continue;
      if (above(t.target)) continue;
      if (penBusy()) { PALM.add(t.identifier); continue; }
      const p = { x: t.clientX, y: t.clientY };
      T2.set(t.identifier, p); if (G) { if (!G.dead) G.t.set(t.identifier, p); }
    }
    if (G) { if (!G.dead) anchor(); e.preventDefault(); return; }
    if (T2.size >= 2 || (claim && T2.size)) { startGesture(); e.preventDefault(); }
  }, { capture: true, passive: false });
  addEventListener('touchmove', (e) => {
    if (!D.open || NI()) return;
    let mine = false;
    for (const t of e.changedTouches) { const p = T2.get(t.identifier); if (p) { p.x = t.clientX; p.y = t.clientY; mine = true; } }
    if (G) { e.preventDefault(); if (mine) moveGesture(); return; }
    const fingers = [...e.touches].filter((t) => finger(t) && !above(t.target)).length;
    if (fingers >= 2 || D.cur || [...e.changedTouches].some((t) => !finger(t) && !above(t.target)) || [...e.changedTouches].some((t) => PALM.has(t.identifier))) e.preventDefault();   // 双指不让整页缩放；笔不让下面滚动；掌根不滚
  }, { capture: true, passive: false });
  const tend = (e) => {
    if (NI()) return;
    let changed = false;
    if (G && !G.dead) { let mv = false; for (const t of e.changedTouches) { const p = G.t.get(t.identifier); if (p && (p.x !== t.clientX || p.y !== t.clientY)) { p.x = t.clientX; p.y = t.clientY; mv = true; } } if (mv) moveGesture(); }   // 抬手那一下的位置也算上（最后一次 touchmove 可能还没送到）
    for (const t of e.changedTouches) { PALM.delete(t.identifier); if (T2.delete(t.identifier)) changed = true; if (G && G.t.delete(t.identifier)) changed = true; }
    if (!T2.size) claim = false;
    if (!G) return;
    e.preventDefault();
    if (!G.t.size && !T2.size) endGesture(); else if (changed && !G.dead) anchor();
  };
  addEventListener('touchend', tend, { capture: true, passive: false }); addEventListener('touchcancel', tend, { capture: true, passive: false });
  /* Safari 上 Pencil 拖动会滚动下面能滚的地方（讲稿、题干）并打断这一笔：笔落在纸上时把它的 touch 默认动作拦掉；手指照常滚 */
  addEventListener('touchstart', (e) => { if (D.open && !NI() && [...e.changedTouches].some((t) => t.touchType === 'stylus') && !above(e.target)) e.preventDefault(); }, { capture: true, passive: false });
  /* Safari 自己的双指缩放手势（gesture* 事件）：草稿纸开着时整页不许缩放 */
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((n) => addEventListener(n, (e) => { if (D.open && !NI() && !above(e.target)) e.preventDefault(); }, { capture: true, passive: false }));

  /* ---------- 工具条 ---------- */
  let sureT = 0;
  let sureAt = 0;
  const unsure = () => { clearTimeout(sureT); const c = T('clear'); if (c.classList.contains('sure')) { c.classList.remove('sure'); tool.querySelector('.dsure').classList.remove('on'); labels(); sync(); } };
  function closePops() { const had = tool.querySelector('.dpop.on'); tool.querySelectorAll('.dpop.on').forEach((p) => p.classList.remove('on')); unsure(); if (had) sync(); }
  function pop(name, anchorEl) {
    const p = tool.querySelector(`.dpop[data-p="${name}"]`), was = p.classList.contains('on');
    if (name !== 'sure') closePops(); if (was) return;
    p.style.top = Math.max(0, anchorEl.offsetTop + anchorEl.offsetHeight / 2 - 26) + 'px'; p.classList.add('on');
    const r = p.getBoundingClientRect(); if (r.bottom > innerHeight - 8) p.style.top = (parseFloat(p.style.top) - (r.bottom - innerHeight + 8)) + 'px';
    sync();   // 弹层一开就告诉 App 让出这块，不等 400 毫秒的轮询（不然这段时间里点色块会点到纸上）
  }
  /* 按下和抬起在同一个按钮上就算点了一下，抬起时立刻生效。手指 / 笔点的：touchend 上 preventDefault，浏览器就不再补一个 click
     （补来的 click 会晚一两秒，那时小弹层可能已经收了，click 会落到下面的页面上；也会把开关再拨回去）。
     鼠标、键盘这种没有触摸的点击照旧走 click（pointerup 生效过的那一下不再算）。 */
  let downEl = null, downAt = 0, upDone = false;
  /* 诊断（App 里）：这一下在工具条上的各个事件：事件自带的时间戳（换成墙上时间）和处理函数实际执行的时刻，随 tap 消息发给 App */
  let evs = [];
  const wallOf = (e) => Math.round(performance.timeOrigin + e.timeStamp);
  ['touchstart', 'pointerdown', 'touchend', 'pointerup', 'click'].forEach((n) => tool.addEventListener(n, (e) => {
    const lk = evs.length ? evs[evs.length - 1].slice(0, 2) : '';
    if ((n === 'touchstart' || n === 'pointerdown') && lk !== 'ts' && lk !== 'pd') evs = [];   // 一下新的按下：不管 touchstart 和 pointerdown 谁先到
    evs.push((n === 'touchstart' ? 'ts' : n === 'pointerdown' ? 'pd' : n === 'touchend' ? 'te' : n === 'pointerup' ? 'pu' : 'cl') + ':' + wallOf(e) + '/' + Date.now() + '@' + Math.round(e.clientX || (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientX : 0)));
    window.__b2evs = evs;
  }, { capture: true, passive: true }));
  const btnOf = (t) => (t && t.closest ? t.closest('[data-c], [data-a]') : null);
  let touchPending = 0;   // 手指 / 笔在工具条上按下过：浏览器随后在按下点补的那一个 click 不算（实测 touchend 拦不住它）
  tool.addEventListener('pointerdown', (e) => { downEl = btnOf(e.target); downAt = Date.now(); upDone = 0; if (e.pointerType !== 'mouse') touchPending = performance.now(); }, true);
  tool.addEventListener('pointerup', (e) => {
    const el = btnOf(e.target);   // 触摸有隐式捕获：手指滑出去以后 target 还是按下的那颗按钮，所以要看抬起点
    if (!el || el !== downEl || el.dataset.a === 'grip' || el.dataset.a === 'alpha') { downEl = null; return; }
    downEl = null;
    const r = el.getBoundingClientRect(), m = 14;
    if (e.clientX < r.left - m || e.clientX > r.right + m || e.clientY < r.top - m || e.clientY > r.bottom + m) return;   // 滑出按钮再松手：不算
    if (e.pointerType === 'mouse') upDone = performance.now();   // 鼠标：紧跟着来的 click 不再算第二次（触摸的 click 在 touchend 上已经拦掉）
    act(e);
  });
  /* 在工具条上按下的手指 / 笔（包括拖手柄、拖透明度）抬起时都不要浏览器补 click：拖手柄松手时手指往往已经在工具条外面，
     补来的 click 会落到下面的页面上（模拟器里实测打开了原卷浮层） */
  tool.addEventListener('touchend', (e) => { e.preventDefault(); }, { passive: false });
  /* 根上拦：在工具条上按下的触摸，touchstart 就 preventDefault，浏览器从一开始就不会为这一下合成 click
     （实测 touchend 上拦不住：拖手柄后浏览器过了约 1 秒还在按下点补了一个 click，r18 日志 toolClk=1065ms@0px）。按钮照样在 pointerup 时生效。 */
  tool.addEventListener('touchstart', (e) => { e.preventDefault(); }, { passive: false });
  /* 兜底：在工具条上按着、以及抬起后 1.5 秒内，落在工具条外面的 click 一律不算（模拟器里实测：拖手柄后浏览器仍在按下的那一点补了一个 click，
     工具条已经挪走了，click 落到下面的原卷图上把原卷浮层打开了） */
  /* 只拦"在工具条上按下的那一下"补出来的 click：落点在按下点 30px 以内、抬起后 600 毫秒内；工具条外面一有新的按下，立刻不拦 */
  let toolTouch = false, toolUpAt = -1e9, toolDownXY = [0, 0];
  tool.addEventListener('pointerdown', (e) => { toolTouch = true; toolDownXY = [e.clientX, e.clientY]; }, true);
  ['pointerup', 'pointercancel'].forEach((n) => addEventListener(n, () => { if (toolTouch) { toolTouch = false; toolUpAt = performance.now(); } }, true));
  addEventListener('pointerdown', (e) => { if (!(e.target.closest && e.target.closest('#dtool'))) { toolTouch = false; toolUpAt = -1e9; } }, true);
  document.addEventListener('click', (e) => {
    if (NI()) { const L = window.__b2toolclk = window.__b2toolclk || []; L.push(Math.round(performance.now() - toolUpAt) + 'ms@' + Math.round(Math.hypot(e.clientX - toolDownXY[0], e.clientY - toolDownXY[1])) + 'px'); if (L.length > 8) L.shift(); }   // 诊断：这个 click 离工具条抬起多久、离按下点多远
    if (!(toolTouch || performance.now() - toolUpAt < 600)) return;
    if (e.target.closest && e.target.closest('#dtool')) return;
    if (Math.hypot(e.clientX - toolDownXY[0], e.clientY - toolDownXY[1]) > 30) return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  /* 清空确认气泡：触摸落在它上面不传到下面的页面、也不清空 */
  { const su = tool.querySelector('.dsure'); ['pointerdown', 'pointerup', 'click', 'touchstart'].forEach((n) => su.addEventListener(n, (e) => { e.stopPropagation(); if (n !== 'touchstart' && n !== 'pointerdown') e.preventDefault(); })); }
  tool.addEventListener('click', (e) => {
    /* 键盘（回车 / 空格）、读屏点的 click：detail 是 0，一律照常生效，不被下面两条吃掉 */
    if (e.detail === 0) { act(e); return; }
    if (touchPending && performance.now() - touchPending < 2500) { touchPending = 0; return; }   // 触摸补来的：只吃这一个
    touchPending = 0;
    if (upDone && performance.now() - upDone < 600) { upDone = 0; return; }   // 鼠标：pointerup 已经生效过的那一下
    upDone = 0; act(e);
  });
  function act(e) {
    const c = e.target.closest('[data-c]');
    if (c) { if (NI()) tell({ k: 'tap', a: 'c-' + c.dataset.c, t: Date.now(), d: downAt, ev: evs.slice() }); ui.color = c.dataset.c; ui.tool = 'pen'; saveUI(); paintTool(); closePops(); return; }
    const b = e.target.closest('[data-a]'); if (!b || b.disabled) return;
    const a = b.dataset.a, doc = D.doc;
    if (NI()) tell({ k: 'tap', a, t: Date.now(), d: downAt, ev: evs.slice() });   // App 记诊断日志：这一下的事件时间线和 act() 执行时刻
    if (a !== 'clear') unsure();
    if (a === 'pen' || a === 'eraser') { ui.tool = a; saveUI(); paintTool(); closePops(); }
    else if (a === 'color' || a === 'more') pop(a, b);
    else if (a === 'undo') { closePops(); undo(); }
    else if (a === 'zoom') {
      closePops();
      if (NI()) { const v = homeView(true); if (v) tell({ k: 'zoomTo', x: v.x, y: v.y, z: v.z }); else tell({ k: 'zoom100' }); }   // App 里：取景窗由 App 定
      else if (doc) flyTo(homeView());
    }
    else if (a === 'clear') {
      if (!b.classList.contains('sure')) {   // 清空：第一次只变成确认态（红框 + 旁边一句），4 秒内再点才清
        closePops(); b.classList.add('sure'); sureAt = performance.now(); labels(); pop('sure', b); clearTimeout(sureT); sureT = setTimeout(unsure, 4000); return;
      }
      if (performance.now() - sureAt < 300) return;   // 刚进确认态 300 毫秒内的第二下（比如连点撤销点偏了）不算
      unsure(); closePops();
      if (NI()) {   // App 里：App 清它的新笔迹（登记一步撤销）；这里清垫底的旧笔迹并写回电脑。每次清空都记一份（没有旧稿就记空的），和 App 的撤销一一对应
        tell({ k: 'clear' });
        D.clears.push({ id: D.id, s: doc ? doc.s : [], ph: doc && doc.ph ? doc : null });
        if (doc && doc.ph) { doc.cleared = true; doc.s = []; render(); }   // 旧稿还没回来：记下"清空过"，回来时一起清、一起写回
        else if (doc && doc.s.length) { doc.s = []; putV2(); render(); }
      } else if (doc && doc.ph) { D.hist.push({ k: 'clear', s: doc.s, ph: doc }); doc.cleared = true; doc.s = []; render(); }
      else if (doc && doc.s.length) { D.hist.push({ k: 'clear', s: doc.s }); doc.s = []; D.dirty = true; later(); render(); }
    }
    else if (a === 'finger') { ui.finger = !ui.finger; saveUI(); paintTool(); }
    else if (a === 'close') close();
  }
  function undo() {
    if (NI()) { tell({ k: 'undo' }); return; }
    const h = D.hist; if (!h.length || !D.doc) return;
    const x = h.pop(), doc = D.doc;
    if (x.k === 'add') doc.s.pop(); else if (x.k === 'clear') doc.s = x.s.concat(doc.s);
    D.dirty = true; later(); render();
  }
  /* 点工具条以外的地方：收起颜色、更多的小弹层，清空的确认也作废 */
  document.addEventListener('pointerdown', (e) => { if (!(e.target.closest && e.target.closest('#dtool'))) closePops(); }, true);
  /* 透明度：竖条，顶上 = 1（不透明的纸），底下 = 0（只剩笔迹） */
  (function slider() {
    const al = T('alpha'); let on = false;
    const setY = (y) => { const r = al.getBoundingClientRect(); ui.alpha = Math.round(Math.max(0, Math.min(1, 1 - (y - r.top - 8) / (r.height - 16))) * 100) / 100; paintTool(); };
    al.addEventListener('pointerdown', (e) => { on = true; al.setPointerCapture(e.pointerId); setY(e.clientY); e.preventDefault(); });
    al.addEventListener('pointermove', (e) => { if (on) setY(e.clientY); });
    const stop = () => { if (on) { on = false; saveUI(); } };
    al.addEventListener('pointerup', stop); al.addEventListener('pointercancel', stop);
  })();
  /* 把手：拖着走，松手贴最近的一边 */
  (function grip() {
    const g = T('grip'); let d = null;
    g.addEventListener('pointerdown', (e) => { const r = tool.getBoundingClientRect(); d = { dx: e.clientX - r.left, dy: e.clientY - r.top }; g.setPointerCapture(e.pointerId); tool.classList.add('moving'); closePops(); e.preventDefault(); });
    g.addEventListener('pointermove', (e) => { if (!d) return; tool.style.setProperty('--dx', (e.clientX - d.dx) + 'px'); tool.style.setProperty('--dy', (e.clientY - d.dy) + 'px'); });
    const stop = (e) => {
      if (!d) return; d = null; void tool.offsetWidth; tool.classList.remove('moving');   // 松手：从手指放下的地方滑到贴边（draft.css 的过渡）
      const r = tool.getBoundingClientRect(); ui.side = r.left + r.width / 2 < innerWidth / 2 ? 'l' : 'r'; ui.y = Math.max(0, Math.min(1, (r.top + r.height / 2) / innerHeight));
      saveUI(); layout();
    };
    g.addEventListener('pointerup', stop); g.addEventListener('pointercancel', stop);
  })();

  /* App 告诉的取景窗是屏幕坐标；键盘弹着时页面在屏幕上错开 visualViewport.offset，旧稿画在页面里要加回去 */
  let NAT = null;
  function natView() {
    if (!NAT) return; const o = vvOff();
    V.x = NAT.x + o[0]; V.y = NAT.y + o[1]; V.z = NAT.z; paintZoom(); if (D.open) want();
  }
  if (window.visualViewport) { visualViewport.addEventListener('resize', natView); visualViewport.addEventListener('scroll', natView); }

  /* ---------- Apple Pencil 双击（原生套壳派发） ---------- */
  addEventListener('b2-pencil-doubletap', () => {
    if (!D.open) { ui.tool = 'pen'; saveUI(); paintTool(); open().then(() => flash('pen')); return; }
    ui.tool = ui.tool === 'pen' ? 'eraser' : 'pen'; saveUI(); paintTool(); closePops(); flash(ui.tool);
  });
  window.B2PencilDoubleTap = () => window.dispatchEvent(new CustomEvent('b2-pencil-doubletap'));

  window.Kit = window.Kit || {};
  Kit.draft = { D, ui, V, open, close, flush, render, fix, homeView, setView, get doc() { return D.doc; }, get gesture() { return G; },
    /* App 调：at 是 App 画布现在的取景窗 {x, y, z}（屏幕 = 纸面 × z + (x, y)），旧 v2 笔迹跟着它画 */
    native: NI() ? {
      update(o) { NV.undo = !!(o && o.undo); NV.bounds = o && Array.isArray(o.bounds) ? o.bounds : null; paintUndo(); },
      /* App 撤销了一次清空：放回那一次清掉的旧稿（最后一次清空对应最后一次撤销） */
      unclear() {
        const c = D.clears.pop(); if (!c || c.id !== D.id || !D.doc || !c.s.length) return;
        D.doc.s = c.s.concat(D.doc.s); putV2(); render();
      },
      at(v) {
        if (!v || !isFinite(+v.x) || !isFinite(+v.y) || !(+v.z > 0)) return;
        NAT = { x: +v.x, y: +v.y, z: +v.z }; natView();
      },
      /* App：连上电脑了 / 回到前台了，补传待传的旧稿 */
      retryPending,
      /* App：画布上笔落下了（掌根先压在工具条上、笔后落下）：工具条上还没抬起的那一下作废 */
      penDown() { downEl = null; },
    } : null };
})();
