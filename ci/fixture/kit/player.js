/* kit/player.js：讲解版的播放内核。
   一页讲解 = 一条 GSAP 主时间线，切成若干“步”。画面上的一切只由时间线的位置决定，
   所以可以：演一步、跳到任意一步、手指拖着走（scrub）、拖进度条、往回倒。
   一页讲解由外壳拼起来：题目 questions/<id>/q.json + 它用的知识块 units/<unit>/unit.js + kit/sections.js 里的通用段落。
   知识块调 Kit.unit(id, {...build(K, U)}) 登记；各段在 build 里用 K.step(id, meta, (t) => {...}) 一步一步往时间线上加动画，
   用 K.hot(el, {...}) 声明“能点的地方”。 */
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const W = 1000, H = 720, EPS = 1e-3;   // 画布 1000 × 720：平板横屏去掉左栏后，画面区大约是这个比例

  function E(tag, attrs, parent, text) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  /* ---------- 音效：一种声音只表示一种事件 ---------- */
  const SFX = ['hit', 'drop', 'deny', 'right', 'wrong', 'done', 'blip', 'extend'];
  let actx = null, gain = null; const bufs = {};
  const audio = {
    muted: /[?&]mute=1/.test(location.search),   // 只给调试用；平时要静音按平板的音量键
    setMuted(v) { audio.muted = !!v; },
    unlock() {
      if (!actx) {
        const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
        actx = new AC(); gain = actx.createGain(); gain.gain.value = 0.5; gain.connect(actx.destination);
        SFX.forEach((n) => fetch('sfx/' + n + '_a.mp3').then((r) => r.arrayBuffer())
          .then((b) => actx.decodeAudioData(b, (buf) => { bufs[n] = buf; }, () => {})).catch(() => {}));
      }
      if (actx.state === 'suspended') actx.resume();
    },
    play(n) {
      if (audio.muted || !actx || !bufs[n]) return;
      const s = actx.createBufferSource(); s.buffer = bufs[n]; s.connect(gain); s.start();
    },
  };
  document.addEventListener('pointerdown', audio.unlock, { passive: true });
  document.addEventListener('keydown', audio.unlock);

  /* 知识块：同一块知识的画面只做一次，多道题共用 */
  const units = {};
  function unit(id, def) { units[id] = def; }

  /* text：这一页的文字，可以是几层叠在一起（题目的字 → 知识块的字 → 外壳的字），前面的先查。
     找不到的键显示成 ‹键名›，一眼能看出哪句还没写。 */
  function lookup(text, key) {
    for (const o of [].concat(text)) { const v = key.split('.').reduce((a, p) => (a == null ? a : a[p]), o); if (v != null) return v; }
    return '‹' + key + '›';
  }

  function createPlayer(host, def, text) {
    host.innerHTML = '';
    const svg = E('svg', { viewBox: `0 0 ${W} ${H}`, class: 'scene' }, host);
    const M = gsap.timeline({ paused: true });
    const steps = [], hots = [], subs = {};
    let idx = -1, tw = null, live = false, poke = null, scrub = null, speed = 1, lastT = -1, dead = false;
    const on = (n, f) => { (subs[n] = subs[n] || []).push(f); };
    const emit = (n, ...a) => (subs[n] || []).forEach((f) => f(...a));
    const sfx = (n) => { if (live) audio.play(n); };

    const K = {
      svg, E, gsap, W, H,
      T: (k) => lookup(text, k),
      cur: null,   // 正在往时间线上加的那一步（对比表靠它记住每个记号是哪一步得出的）
      step(id, meta, fn) {
        K.cur = id;
        const t = gsap.timeline(); fn(t);
        const start = M.duration(); M.add(t);
        steps.push(Object.assign({ id, start, end: M.duration() }, meta));
      },
      sfx(t, n, pos) { t.call(sfx, [n], pos); },
      /* 能点的地方。when(step) 说明哪些步骤停下来时它能点；run(t, step) 往临时时间线 t 上加动画，
         可以返回一个收尾函数（把临时画的东西清掉）。 */
      hot(el, o) { el.classList.add('hot'); hots.push(Object.assign({ el }, o)); },
    };
    K.indexOf = (id) => steps.findIndex((s) => s.id === id);
    K.at = () => (steps[idx] ? steps[idx].id : null);
    /* 重讲（kit/redo.js）：先把原讲解演到某一步摆好画面，再接自己的步骤。K.cut() 记下到这儿为止的步骤和能点的地方，
       建完以后把它们拿掉：进度条上只剩重讲的步骤，时间线一开始就停在原讲解那一步的末尾（T0） */
    K.cut = () => { K.skip = steps.length; K.hotSkip = hots.length; };
    def.build(K);
    if (K.skip) { steps.splice(0, K.skip); hots.splice(0, K.hotSkip); }
    const N = steps.length, T0 = K.skip && N ? steps[0].start : 0;
    const bounds = [T0].concat(steps.map((s) => s.end));
    const hintLayer = E('g', { class: 'hints' }, svg);

    const stepAt = (t) => { for (let i = 0; i < N; i++) if (t <= steps[i].end + EPS) return i; return N - 1; };
    const endIdx = (t) => steps.findIndex((s) => Math.abs(s.end - t) < EPS);   // 停在哪一步的末尾；0 秒处是 -1
    const posOf = (t) => { const i = stepAt(t), s = steps[i]; return i + Math.max(0, Math.min(1, (t - s.start) / (s.end - s.start || 1))); };
    const timeOf = (p) => { const i = Math.max(0, Math.min(N - 1, Math.floor(p))), s = steps[i]; return s.start + (s.end - s.start) * Math.max(0, Math.min(1, p - i)); };

    function kill() { if (tw) { tw.kill(); tw = null; } live = false; }
    function setIdx(i) { if (i !== idx) { idx = i; emit('step', i, steps[i] || null); } refreshHots(); }
    function settled() { emit('done', idx, steps[idx] || null); refreshHots(); }
    /* 播放中不显示“能点的地方”的提示圈：先有 tw 再刷新（这时 idle() 为假，圈全收掉），演完停稳后 settled() 再按这一步的位置画 */
    function playTo(t) {
      kill(); live = true;
      tw = M.tweenTo(t, { ease: 'none', onComplete() { tw = null; live = false; settled(); } });
      tw.timeScale(speed);
      refreshHots();
    }
    function slideTo(t, done) {   // 往回退或弹回去：很快滑过去，不出声
      kill();
      tw = M.tweenTo(t, { duration: Math.min(0.45, 0.15 + Math.abs(M.time() - t) * 0.12), ease: 'power2.out', onComplete() { tw = null; if (done) done(); settled(); } });
    }

    function go(i, o) {
      o = o || {};
      i = Math.max(0, Math.min(N - 1, i));
      clearPoke();
      const s = steps[i], t = M.time();
      if (o.replay) { kill(); M.seek(s.start, true); setIdx(i); playTo(s.end); return; }
      if (!o.instant && t >= s.start - EPS && t < s.end - EPS) { setIdx(i); playTo(s.end); return; }
      kill(); M.seek(s.end, true); setIdx(i); settled();
    }
    /* 画面还在动时再点“下一步”：这一步直接演完，马上开始下一步，不用干等 */
    function next() { if (idx >= N - 1 && !tw) return false; if (tw && idx >= 0) { kill(); M.seek(steps[idx].end, true); } if (idx >= N - 1) { settled(); return false; } go(idx + 1); return true; }
    function prev() { if (idx <= 0) return false; go(idx - 1, { instant: true }); return true; }
    function replay() { if (idx >= 0) go(idx, { replay: true }); }

    /* ---- 手指在画面上横着拖：动画跟着手指走 ---- */
    function scrubStart() {
      clearPoke(); kill();
      const t0 = M.time(); let lo = T0, hi = M.duration();
      for (const b of bounds) { if (b < t0 - EPS) lo = b; if (b > t0 + EPS) { hi = b; break; } }
      scrub = { t0, lo, hi, edge: bounds.some((b) => Math.abs(b - t0) < EPS) };
      refreshHots();
    }
    function scrubMove(f) {   // f>0 往后，f<0 往前，范围 -1..1
      if (!scrub) return;
      f = Math.max(-1, Math.min(1, f));
      const s = scrub, t = f >= 0 ? s.t0 + (s.hi - s.t0) * f : s.t0 + (s.t0 - s.lo) * f;
      M.time(t, true);
      const i = stepAt(Math.max(t, EPS * 2)); if (i !== idx) setIdx(i);
    }
    function scrubEnd(f, flick) {   // flick：松手时甩的方向，+1 往后、-1 往前、0 没甩
      if (!scrub) return;
      const s = scrub; scrub = null;
      let target;
      if (f > 0.3 || (flick > 0 && f > 0.03)) target = s.hi;
      else if (f < -0.3 || (flick < 0 && f < -0.03)) target = s.lo;
      else target = s.edge ? s.t0 : s.hi;
      settleAt(target);
    }
    function settleAt(target) {
      const cur = M.time();
      if (target > cur + EPS) { setIdx(endIdx(target)); playTo(target); }
      else if (target < cur - EPS) { const i = endIdx(target); slideTo(target, () => setIdx(i)); }
      else { setIdx(endIdx(target)); settled(); }
    }
    /* ---- 进度条：p 是“第几步 + 这一步走了多少”，0..N ---- */
    function seekStart() { clearPoke(); kill(); scrub = { bar: true }; refreshHots(); }
    function seekMove(p) { p = Math.max(0, Math.min(N, p)); M.time(timeOf(Math.min(p, N - EPS)), true); const i = Math.min(N - 1, Math.floor(p)); if (i !== idx) setIdx(i); }
    function seekEnd() { if (!scrub) return; scrub = null; const i = stepAt(Math.max(M.time(), EPS * 2)); setIdx(i); if (M.time() < steps[i].end - EPS) playTo(steps[i].end); else settled(); }

    /* ---- 能点的地方 ---- */
    const idle = () => !tw && !scrub && idx >= 0;
    const canHot = (h) => idle() && (!h.when || h.when(steps[idx], idx));
    function refreshHots() {
      hintLayer.textContent = '';
      let n = 0;
      hots.forEach((h) => {
        const ok = canHot(h); h.el.classList.toggle('can', ok);
        if (!ok || poke || h.hint === false || n >= 8) return;
        const b = h.el.getBBox(), m = h.el.getCTM(), r = svg.getCTM(); if (!m || !r) return;
        const p = svg.createSVGPoint(); p.x = b.x + b.width / 2; p.y = b.y + b.height / 2;
        const q = p.matrixTransform(r.inverse().multiply(m));
        E('circle', { cx: q.x, cy: q.y, r: 7, class: 'hint', style: `animation-delay:${(n++ * 0.18).toFixed(2)}s` }, hintLayer);
      });
    }
    function tap(target) {
      const h = hots.find((x) => x.el.contains(target));
      if (!h || !canHot(h)) return false;
      if (h.go) { go(K.indexOf(h.go), { replay: true }); return true; }
      clearPoke();
      const t = gsap.timeline({ onComplete() { live = false; } });
      live = true;
      poke = { t, cleanup: h.run(t, steps[idx]) || null };
      refreshHots();
      return true;
    }
    function clearPoke() { if (!poke) return; poke.t.kill(); if (poke.cleanup) poke.cleanup(); poke = null; live = !!tw; }

    if (T0) M.seek(T0, true);
    const tick = () => { if (dead) return; const t = M.time(); if (t !== lastT) { lastT = t; emit('time', posOf(t), t); } };
    gsap.ticker.add(tick);
    function destroy() { dead = true; kill(); clearPoke(); gsap.ticker.remove(tick); M.kill(); host.innerHTML = ''; }

    /* 到第 i 步为止，哪些选项已经判过了 */
    function marksAt(i) { const m = {}; for (let k = 0; k <= i && k < N; k++) { const s = steps[k]; if (s.opt) m[s.opt] = s.verdict; } return m; }

    return {
      steps, N, on, go, next, prev, replay, tap, marksAt, destroy, refreshHots,
      scrubStart, scrubMove, scrubEnd, seekStart, seekMove, seekEnd,
      setSpeed(v) { speed = v; if (tw && live) tw.timeScale(v); },
      get index() { return idx; }, get busy() { return !!tw; }, get scrubbing() { return !!scrub; },
      get pos() { return posOf(M.time()); }, _tl: M,
    };
  }

  window.Kit = { unit, units, look: lookup, createPlayer, audio, E, W, H };
})();
