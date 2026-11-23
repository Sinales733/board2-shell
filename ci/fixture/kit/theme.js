/* kit/theme.js：昼夜切换。放在 <head> 里最先跑，免得打开时先闪一下深色。
   三种：night 夜间（原来的暖黑，默认）/ day 白天（暖白纸色）/ auto 跟随平板系统（prefers-color-scheme）。记在本机 localStorage b2theme。
   <html data-theme="day|night"> 是实际生效的那一套，shell.css 的变量在 kit/theme.css 里按它换；data-theme-pref 是他选的那一档。
   画面（#stage 的 svg）的颜色是建时间线时从 Kit.C 取的：换套时把 Kit.C 原地换成白天那一套，再把当前这道题按当前这一步重建一遍。
   按钮在选题抽屉顶上那排小图标里（薄弱点、补练的左边），点一下 跟随系统 → 白天 → 夜间 → 跟随系统，顶上提示一下现在是哪种。
   地址带 theme=day|night|auto 时临时用那一种、不记（截图用）。 */
(function () {
  'use strict';
  const KEY = 'b2theme', html = document.documentElement, ORDER = ['auto', 'day', 'night'];
  const mq = window.matchMedia ? matchMedia('(prefers-color-scheme: light)') : { matches: false, addEventListener() {} };
  let pref = 'night';
  try { pref = localStorage.getItem(KEY) || 'night'; } catch (e) {}
  const fixed = new URLSearchParams(location.search).get('theme');
  if (/^(auto|day|night)$/.test(fixed || '')) pref = fixed;
  if (!ORDER.includes(pref)) pref = 'night';
  const eff = () => (pref === 'auto' ? (mq.matches ? 'day' : 'night') : pref);
  /* 换套的那一帧所有过渡先停掉（html.noanim，shell.css）：不然带 color / background 过渡的按钮、选项慢慢变色，别的地方一下就变了，换套时花一下；两帧以后恢复 */
  const still = () => { html.classList.add('noanim'); requestAnimationFrame(() => requestAnimationFrame(() => html.classList.remove('noanim'))); };
  const paint = (swap) => { if (swap && html.dataset.theme !== eff()) still(); html.dataset.theme = eff(); html.dataset.themePref = pref; };
  paint();

  /* 白天这一套画面颜色（Kit.C 的键一一对应；对比度按暖白纸 #f4f1ea 算过：正文 ≥ 10，淡字 ≥ 4.5，橙蓝绿红 ≥ 4） */
  const DAY = {
    slot: '#fbfaf6', slotLine: '#cbc4b6', other: '#e3ddd1', otherInk: '#5d584e', ink: '#1f1d1a', ink2: '#3b3833', muted: '#5c584f', faint: '#736e63',
    acc: '#b85a33', accSoft: '#f5dccd', onAcc: '#fffaf6', blue: '#2b64a3', blueSoft: '#d7e4f2', ok: '#2a7f4a', okSoft: 'rgba(42,127,74,.14)', no: '#bd3d35',
    surface: '#ebe7de', surface2: '#e1dcd0', line: '#d6cfc2', bg: '#f4f1ea',
  };
  let NIGHT = null;
  function applyC() {
    if (!window.Kit || !Kit.C) return;
    if (!NIGHT) NIGHT = Object.assign({}, Kit.C);
    Object.assign(Kit.C, eff() === 'day' ? DAY : NIGHT);
  }
  /* 当前这道题按当前这一步重建（画面颜色是建的时候定的）；补练里先记下，退出补练再建 */
  let pend = false;
  function rebuild() {
    const S = window.Board2; if (!S || !S.api || !S.id || !S.P) return;
    if (S.mock) { pend = true; return; }
    pend = false;
    const i = S.P.index, id = S.id, A = S.api;
    const o = S.redo ? { redo: S.redo } : S.read ? { read: true } : S.gate ? {} : { at: Math.max(0, i) };
    A.open(id, o).then(() => { if ((o.redo || o.read) && i > 0 && S.P && S.id === id) S.P.go(Math.min(i, S.P.N - 1), { instant: true }); }).catch(() => {});
  }
  setInterval(() => { if (pend && window.Board2 && !Board2.mock) rebuild(); }, 1000);
  function set(p, quiet) {
    const was = eff(); pref = p;
    if (!fixed) { try { localStorage.setItem(KEY, p); } catch (e) {} }
    paint(true); applyC(); paintBtn();
    if (eff() !== was) rebuild();
    if (!quiet && window.Board2 && Board2.api) Board2.api.toast(Board2.api.U('ui.theme.' + p));
  }
  mq.addEventListener && mq.addEventListener('change', () => { if (pref !== 'auto') return; paint(true); applyC(); rebuild(); });

  /* 抽屉顶上的按钮：图标画的是现在这一档（月亮 夜间 / 太阳 白天 / 半边圆 跟随系统） */
  const ICON = {
    night: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
    day: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
    auto: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
  };
  let btn = null;
  function paintBtn() {
    if (!btn) return;
    btn.innerHTML = `<svg viewBox="0 0 24 24">${ICON[pref]}</svg>`;
    const U = window.Board2 && Board2.api ? Board2.api.U : null;
    if (U) btn.setAttribute('aria-label', U('ui.theme.btn') + '：' + U('ui.theme.' + pref));
  }
  function mount() {
    applyC();
    const dr = document.getElementById('drawer'); if (!dr || btn) return;
    btn = document.createElement('button'); btn.className = 'ic thbtn'; btn.id = 'btnTheme';
    btn.onclick = () => set(ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length]);
    dr.insertBefore(btn, dr.firstChild); paintBtn();
    let n = 0; const t = setInterval(() => { if ((window.Board2 && Board2.api && Board2.ui && Board2.ui.ui) || ++n > 60) { clearInterval(t); paintBtn(); } }, 250);   // 界面的字（kit/ui.json）到了再写读屏文字
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  window.B2Theme = { get pref() { return pref; }, get theme() { return eff(); }, set, DAY };
})();
