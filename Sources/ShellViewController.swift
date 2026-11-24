import UIKit
import WebKit
import SafariServices

/// 全屏 WKWebView 外壳：加载讲解版网页，把 Apple Pencil 双击 / 捏一下转给网页。
final class ShellViewController: UIViewController {

    private enum LoadState {
        case idle
        case loading
        case loaded
        case failed
    }

    private var webView: WKWebView!
    private let overlay = SettingsOverlay()
    private var state: LoadState = .idle
    private var lastPencilFire: TimeInterval = 0
    private let proxy = OfflineProxy()
    private let mark = OfflineMark()
    private let toastLabel = PaddedLabel()
    /// 网页第一次摆好以后才淡入（启动不白闪、不跳）。
    private var revealed = false
    private var toastWork: DispatchWorkItem?
    private var migrator: StorageMigrator?
    private var shotStarted = false
    private var ink: InkLayer?
    /// 自检用：点过站外链接（交给应用内浏览器了）。
    private var externalOpened = false
    /// 截图模式：给 UI 测试读的隐形标签（"wait" / "ready"，值里是自检结果），和网页报错。
    private let shotLabel = UILabel()
    private let shotLogLabel = UILabel()
    private var shotLog: [String] = []
    private var inkCmdSeq = 0
    private var shotState = "wait"
    private var shotValue = ""

    /// 网页侧提供的全局函数；不存在时什么都不做。
    private static let pencilJS = "window.B2PencilDoubleTap && window.B2PencilDoubleTap()"

    /// 禁止页面级捏合缩放和双击放大：在网页原有 viewport 后面补 maximum-scale=1, user-scalable=no。
    /// 网页已有 viewport-fit=cover，这里只补缺的项，不改已有的项。
    private static let viewportJS = """
    (function () {
      try {
        var m = document.querySelector('meta[name="viewport"]');
        if (!m) {
          m = document.createElement('meta');
          m.setAttribute('name', 'viewport');
          m.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover');
          (document.head || document.documentElement).appendChild(m);
        }
        var c = m.getAttribute('content') || '';
        if (!/maximum-scale/i.test(c)) { c += ', maximum-scale=1'; }
        if (!/user-scalable/i.test(c)) { c += ', user-scalable=no'; }
        m.setAttribute('content', c);
      } catch (e) {}
    })();
    """

    /// 网页的昼夜套（<html data-theme="day|night">）变了就告诉 App。
    private static let themeJS = """
    (function () {
      try {
        var h = document.documentElement, last = null;
        var tell = function () {
          var t = h.dataset.theme === 'day' ? 'day' : 'night';
          if (t !== last) { last = t; window.webkit.messageHandlers.b2shell.postMessage({ k: 'theme', v: t }); }
        };
        tell();
        new MutationObserver(tell).observe(h, { attributes: true, attributeFilter: ['data-theme'] });
      } catch (e) {}
    })();
    """

    /// WebKit 把发往自定义地址（b2://）的请求交给 App 时会丢掉请求体，而且 fetch 发往自定义地址不一定送得到。
    /// 所以页面开头把发往 b2:// 的 fetch（GET、POST 都算）改成发消息给 App，App 转给电脑（或从 iPad 上存的取）后
    /// 把结果原样还给网页。<script>、<link>、<img>、EventSource 照常走 b2://。
    private static let fetchJS = """
    (function () {
      try {
        var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.b2fetch;
        if (!h || !window.fetch) return;
        var of = window.fetch.bind(window);
        var abortErr = function () {
          try { return new DOMException('The operation was aborted.', 'AbortError'); }
          catch (e) { var x = new Error('aborted'); x.name = 'AbortError'; return x; }
        };
        window.fetch = function (input, init) {
          var req = (typeof Request !== 'undefined' && input instanceof Request) ? input : null, url;
          try { url = new URL(req ? req.url : String(input), location.href); } catch (e) { return of(input, init); }
          if (url.protocol !== 'b2:') return of(input, init);
          var method = String((init && init.method) || (req && req.method) || 'GET').toUpperCase();
          var signal = (init && init.signal) || (req && req.signal) || null;
          if (signal && signal.aborted) return Promise.reject(abortErr());
          var hd = {};
          try { new Headers((init && init.headers) || (req && req.headers) || {}).forEach(function (v, k) { hd[k] = v; }); } catch (e) {}
          var bodyP;
          if (init && init.body != null) bodyP = typeof init.body === 'string' ? Promise.resolve(init.body) : new Response(init.body).text();
          else if (req && method !== 'GET' && method !== 'HEAD') bodyP = req.clone().text();
          else bodyP = Promise.resolve('');
          var p = bodyP.then(function (body) {
            return h.postMessage({ path: url.pathname + url.search, method: method, headers: hd, body: body });
          }).then(function (r) {
            if (!r || !r.status) throw new TypeError('Failed to fetch');
            var none = r.status === 204 || r.status === 205 || r.status === 304 || method === 'HEAD', u = null;
            if (!none) { var bin = atob(r.b64 || ''), n = bin.length; u = new Uint8Array(n); for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i); }
            return new Response(u, { status: r.status, headers: { 'Content-Type': r.type || 'application/octet-stream' } });
          });
          if (!signal) return p;
          return new Promise(function (res, rej) {
            var onAbort = function () { rej(abortErr()); };
            signal.addEventListener('abort', onAbort, { once: true });
            p.then(function (v) { signal.removeEventListener('abort', onAbort); res(v); },
                   function (e) { signal.removeEventListener('abort', onAbort); rej(e); });
          });
        };
      } catch (e) {}
    })();
    """

    /// 网页里的报错（脚本错误、没接住的 Promise、console.error、资源加载失败）转给 App 记进系统日志，查问题用。
    private static let logJS = """
    (function () {
      try {
        var t = function (m) { try { window.webkit.messageHandlers.b2shell.postMessage({ k: 'log', v: String(m).slice(0, 200) }); } catch (e) {} };
        addEventListener('error', function (e) {
          if (e.target && e.target !== window && (e.target.src || e.target.href)) t('load failed: ' + (e.target.src || e.target.href));
          else t('error: ' + e.message + ' @' + (e.filename || '') + ':' + (e.lineno || ''));
        }, true);
        addEventListener('unhandledrejection', function (e) { var r = e.reason; t('rejection: ' + (r && (r.stack || r.message) || r)); });
        var ce = console.error;
        console.error = function () { t('console.error: ' + [].slice.call(arguments).join(' ')); return ce.apply(console, arguments); };
        var cw = console.warn;
        console.warn = function () { t('console.warn: ' + [].slice.call(arguments).join(' ')); return cw.apply(console, arguments); };
      } catch (e) {}
    })();
    """

    /// 讲解页选题抽屉顶上那排小图标里加一个"设置"（在昼夜按钮左边），点了叫出原生设置面板。
    /// 只在 App 里有（Safari 里没有 b2shell 就不加）；样式照网页 .thbtn。
    /// 页面一开就先建好一个 AudioContext（不发声），网页的音效第一次要它时直接给这一个：
    /// 第一下点按时只需要 resume，不用当场建音频上下文。
    /// 诊断：建它用了多久、建好时的状态、前 3 次 resume 同步占了多久、之后的状态，都发给 App 记进笔迹日志（"audio …"），
    /// 真机上看这几行就知道预建有没有生效（WKWebView 设了 mediaTypesRequiringUserActionForPlayback = []，不受自动播放限制）。
    static let audioWarmJS = """
    (function () {
      try {
        var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
        var post = function (s) { try { window.webkit.messageHandlers.b2shell.postMessage({ k: 'audio', v: s }); } catch (e) {} };
        var info = window.__b2ac = { made: -1, state: '', resume: [] };
        var pre = null;
        var make = function () {
          if (!pre) {
            var t0 = performance.now(); pre = new AC(); info.made = Math.round(performance.now() - t0); info.state = pre.state;
            post('audio warm: new AudioContext took ' + info.made + 'ms state=' + pre.state);
            try { pre.addEventListener('statechange', function () { info.state = pre.state; post('audio state=' + pre.state); }); } catch (e) {}
            var r0 = pre.resume;
            pre.resume = function () {
              var t = performance.now(), s0 = pre.state, p = r0.apply(pre, arguments), ms = Math.round(performance.now() - t);
              if (info.resume.length < 3) { info.resume.push(ms); post('audio resume from ' + s0 + ' took ' + ms + 'ms (sync)'); }
              return p;
            };
          }
          return pre;
        };
        var W = function () { return make(); };
        W.prototype = AC.prototype;
        window.AudioContext = W; if (window.webkitAudioContext) window.webkitAudioContext = W;
        var warm = function () { try { make(); } catch (e) {} };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', warm); else warm();
      } catch (e) {}
    })();
    """

    /// 诊断：网页这边收到的 pointercancel / touchcancel（系统或手势把触摸收走时会有），计数、记最近 10 条，发给 App 记日志。
    static let cancelJS = """
    (function () {
      try {
        var c = window.__b2cancel = { pc: 0, tc: 0, last: [] };
        var post = function (s) { try { window.webkit.messageHandlers.b2shell.postMessage({ k: 'cancel', v: s }); } catch (e) {} };
        var desc = function (e) {
          var t = e.target, n = t && t.nodeType === 1 ? (t.tagName.toLowerCase() + (t.id ? '#' + t.id : '') + (t.closest && t.closest('[data-a]') ? '[a=' + t.closest('[data-a]').dataset.a + ']' : '')) : String(t && t.nodeName);
          var p = (e.changedTouches && e.changedTouches[0]) || e;
          return n + ' at ' + Math.round(p.clientX || 0) + ',' + Math.round(p.clientY || 0) + ' t=' + Date.now();
        };
        var rec = function (s) { c.last.push(s); if (c.last.length > 10) c.last.shift(); post(s); };
        addEventListener('pointercancel', function (e) { c.pc++; rec('web pointercancel ' + e.pointerType + ' ' + desc(e)); }, true);
        addEventListener('touchcancel', function (e) { c.tc++; rec('web touchcancel ' + desc(e)); }, true);
      } catch (e) {}
    })();
    """

    private static let gearJS = """
    (function () {
      try {
        if (!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.b2shell)) return;
        var mount = function () {
          var dr = document.getElementById('drawer');
          if (!dr || document.getElementById('btnNativeSet')) return;
          var st = document.createElement('style');
          st.textContent = '.b2set{position:absolute;top:12px;right:102px;width:42px;height:42px}'
            + '.b2set::before{content:"";position:absolute;inset:-2px}.b2set svg{width:21px;height:21px}'
            + '.drawer:has(.mkbtn.on) .b2set{right:148px}'
            + '.drawer:not(:has(.sum.on)) .nvh{margin-right:146px!important}.drawer:not(:has(.sum.on)):has(.mkbtn.on) .nvh{margin-right:192px!important}'
            // 今日三个数那一行和顶上这排小图标在同一行：给图标让位；数字长了（例如 1234/2000）放不下，就整行挪到图标下面，再不够就换行，不压、不截断
            + '#sum span{flex:none}#sum b{white-space:nowrap}#drawer:has(#sum.on) #sum{padding-right:130px}#drawer:has(.mkbtn.on):has(#sum.on) #sum{padding-right:176px}'
            + 'html.b2sumdown #drawer #sum{margin-top:40px!important;padding-right:0!important;flex-wrap:wrap;row-gap:10px}';
          document.head.appendChild(st);
          var b = document.createElement('button');
          b.className = 'ic b2set'; b.id = 'btnNativeSet'; b.setAttribute('aria-label', '\(Copy.Settings.gear)');
          b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7.5h9M18 7.5h2M4 16.5h3M11 16.5h9"/><circle cx="15.5" cy="7.5" r="2.5"/><circle cx="8.5" cy="16.5" r="2.5"/></svg>';
          b.onclick = function () {
            try { if (window.Board2 && Board2.api && Board2.api.closeAll) Board2.api.closeAll(); } catch (e) {}
            window.webkit.messageHandlers.b2shell.postMessage({ k: 'settings' });
          };
          dr.insertBefore(b, dr.firstChild);
          var sum = document.getElementById('sum');
          if (sum) {
            // 量一下三个数要多宽：放得下就和图标同一行，放不下挪到图标下面（类名放在 html 上，不触发下面的监听）
            var fit = function () {
              if (!sum.classList.contains('on')) return;
              var kids = sum.children, need = 0, gap = parseFloat(getComputedStyle(sum).columnGap) || 22;
              for (var i = 0; i < kids.length; i++) need += kids[i].offsetWidth + (i ? gap : 0);
              var mk = dr.querySelector('.mkbtn.on') ? 182 : 136;
              var avail = dr.clientWidth - 32 - 6 - mk;
              var down = need > avail;
              if (document.documentElement.classList.contains('b2sumdown') !== down) document.documentElement.classList.toggle('b2sumdown', down);
            };
            new MutationObserver(fit).observe(sum, { attributes: true, childList: true, subtree: true, characterData: true });
            new MutationObserver(fit).observe(dr, { attributes: true, attributeFilter: ['class'] });
            addEventListener('resize', fit);
            fit();
          }
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
      } catch (e) {}
    })();
    """

    // MARK: - 外观

    override var prefersStatusBarHidden: Bool { return true }
    override var prefersHomeIndicatorAutoHidden: Bool { return true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { return .bottom }
    override var preferredStatusBarStyle: UIStatusBarStyle { return Theme.style == .light ? .darkContent : .lightContent }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { return .all }

    // MARK: - 生命周期

    override func loadView() {
        let root = DiagRootView()
        root.backgroundColor = Theme.background
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        if ShotMode.isOn { ShotMode.clearMarks() }
        proxy.cacheDisabled = ShotMode.noCache

        setUpWebView()
        ink = InkLayer(host: view, webView: webView)
        setUpOverlay()
        setUpBadges()
        setUpPencil()
        setUpHiddenEntry()
        setUpShotLabel()
        applyTheme(Theme.webTheme)

        proxy.onOnlineChange = { [weak self] _ in
            self?.paintOffline()
        }
        // 重新连上：记录补发完、再把笔迹补传，真有东西传过去了才说"传过去了"
        proxy.onReplayed = { [weak self] sent in
            self?.ink?.syncAll { inked in
                if sent + inked > 0 { self?.showToast(OfflineProxy.Text.back) }
            }
        }
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            // 进后台：要一点后台时间把笔迹存完
            var task = UIBackgroundTaskIdentifier.invalid
            task = UIApplication.shared.beginBackgroundTask { UIApplication.shared.endBackgroundTask(task); task = .invalid }
            self?.ink?.saveNow { if task != .invalid { UIApplication.shared.endBackgroundTask(task); task = .invalid } }
        }
        NotificationCenter.default.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            self?.ink?.saveNowAndWait()   // 要被杀掉：存盘队列同步跑完
        }
        proxy.onToast = { [weak self] text in self?.showToast(text) }

        NotificationCenter.default.addObserver(self,
                                               selector: #selector(appWillEnterForeground),
                                               name: UIApplication.willEnterForegroundNotification,
                                               object: nil)
        ServerSettings.recoverIfNeeded { [weak self] in self?.migrateThenLoad() }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        applyTheme(Theme.webTheme)
    }

    /// 网页换了昼夜套：原生界面（设置页、提示条）跟着换。
    /// 网页换套的那一刻（它自己那一帧也不做过渡）原生部分同一帧换：整个窗口的外观一起改，颜色都是跟外观走的动态色。
    private func applyTheme(_ theme: String) {
        Theme.webTheme = theme
        view.window?.overrideUserInterfaceStyle = Theme.style
        overrideUserInterfaceStyle = Theme.style
        view.backgroundColor = Theme.background
        webView?.backgroundColor = Theme.background
        webView?.underPageBackgroundColor = Theme.background
        webView?.scrollView.backgroundColor = Theme.background
        setNeedsStatusBarAppearanceUpdate()
        setNeedsUpdateOfHomeIndicatorAutoHidden()
    }

    /// 第一次装上这一版：把旧地址（http://电脑:8409）下网页存在本机的东西（答题记录、草稿暂存、设置……）
    /// 读出来，交给新地址（b2://board2）的页面。只做一次。
    private func migrateThenLoad() {
        guard !ShotMode.isOn, !StorageMigrator.done, let origin = ServerSettings.url else {
            installMigrationScript()
            loadServer()
            return
        }
        let m = StorageMigrator(origin: origin, host: view)
        migrator = m
        m.run { [weak self] in
            self?.migrator = nil
            self?.installMigrationScript()
            self?.loadServer()
        }
    }

    private func installMigrationScript() {
        guard let js = StorageMigrator.injectionScript() else { return }
        webView.configuration.userContentController.addUserScript(
            WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    private func setUpWebView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.javaScriptCanOpenWindowsAutomatically = true
        config.websiteDataStore = WKWebsiteDataStore.default()
        config.setURLSchemeHandler(proxy, forURLScheme: OfflineProxy.scheme)

        let script = WKUserScript(source: ShellViewController.viewportJS,
                                  injectionTime: .atDocumentEnd,
                                  forMainFrameOnly: true)
        config.userContentController.addUserScript(script)
        config.userContentController.addUserScript(WKUserScript(source: ShellViewController.themeJS,
                                                                injectionTime: .atDocumentEnd,
                                                                forMainFrameOnly: true))
        config.userContentController.add(WeakMessageHandler(self), name: "b2shell")
        config.userContentController.add(WeakMessageHandler(self), name: "b2ink")
        config.userContentController.addScriptMessageHandler(FetchBridge(proxy: proxy), contentWorld: .page, name: "b2fetch")
        config.userContentController.addUserScript(WKUserScript(source: ShellViewController.fetchJS,
                                                                injectionTime: .atDocumentStart,
                                                                forMainFrameOnly: true))
        config.userContentController.addUserScript(WKUserScript(source: ShellViewController.logJS,
                                                                injectionTime: .atDocumentStart,
                                                                forMainFrameOnly: true))
        // 网页的音效第一次被用到时（第一下点按）才建 AudioContext，会把网页主线程卡住几百毫秒到两秒多，
        // 那一下点工具条就要等这么久（1.8 复审时量出来的根因）。App 里改成页面一开就先建好，第一下点按只需 resume。
        config.userContentController.addUserScript(WKUserScript(source: ShellViewController.audioWarmJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.addUserScript(WKUserScript(source: ShellViewController.cancelJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.addUserScript(WKUserScript(source: InkLayer.flagScript,
                                                                injectionTime: .atDocumentStart,
                                                                forMainFrameOnly: true))
        config.userContentController.addUserScript(WKUserScript(source: ShellViewController.gearJS,
                                                                injectionTime: .atDocumentEnd,
                                                                forMainFrameOnly: true))

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsLinkPreview = false
        wv.allowsBackForwardNavigationGestures = false
        wv.isOpaque = false
        wv.backgroundColor = Theme.background
        wv.underPageBackgroundColor = Theme.background
        wv.scrollView.backgroundColor = Theme.background
        wv.scrollView.bounces = false
        wv.scrollView.alwaysBounceVertical = false
        wv.scrollView.alwaysBounceHorizontal = false
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.scrollView.refreshControl = nil
        wv.alpha = 0   // 网页摆好再淡入（reveal）
        #if DEBUG
        if #available(iOS 16.4, *) {
            // 只在调试版（云端模拟器）打开，装到 iPad 上的发布版不开。
            wv.isInspectable = true
        }
        #endif

        wv.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(wv)
        // 铺满整个屏幕（包括安全区之外），安全区由网页的 viewport-fit=cover 自己处理。
        NSLayoutConstraint.activate([
            wv.topAnchor.constraint(equalTo: view.topAnchor),
            wv.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            wv.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        webView = wv
    }

    private func setUpOverlay() {
        overlay.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(overlay)
        NSLayoutConstraint.activate([
            overlay.topAnchor.constraint(equalTo: view.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            overlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        overlay.onConnect = { [weak self] address in
            guard let self = self else { return }
            ServerSettings.address = address
            self.overlay.setBusy(true)
            self.proxy.assumeOnline()
            self.loadServer()
        }
        overlay.onClose = { [weak self] in
            self?.overlay.hide()
            self?.paintOffline()
        }
        overlay.cacheStats = { [weak self] done in self?.proxy.cacheStats(done) }
        overlay.onClearCache = { [weak self] done in self?.proxy.clearCache(done) }
        overlay.onToast = { [weak self] t in self?.showToast(t) }
    }

    /// 只加一个 UIPencilInteraction，加在根 view（webView 的父视图）上。
    /// 不在 webView 上再加第二个：同一层级里两个实例都会收到回调，切换会被执行两次（等于没切）。
    private func setUpPencil() {
        let pencil = UIPencilInteraction()
        pencil.delegate = self
        pencil.isEnabled = true
        view.addInteraction(pencil)
    }

    /// 隐蔽入口：三指按住 2 秒，打开"服务器地址"页。
    private func setUpHiddenEntry() {
        let press = UILongPressGestureRecognizer(target: self, action: #selector(hiddenEntryPressed(_:)))
        press.numberOfTouchesRequired = 3
        press.minimumPressDuration = 2.0
        press.allowableMovement = 40
        press.cancelsTouchesInView = false
        press.delaysTouchesBegan = false
        press.delaysTouchesEnded = false
        press.delegate = self
        view.addGestureRecognizer(press)
    }

    // MARK: - 加载

    private func loadServer() {
        guard ServerSettings.url != nil else {
            state = .failed
            overlay.showFailure(address: ServerSettings.address, reason: "badaddr", detail: ServerSettings.address, canClose: false)
            return
        }
        state = .loading
        var comps = URLComponents(url: OfflineProxy.pageURL, resolvingAgainstBaseURL: false)!
        let q = ShotMode.pageQuery
        if !q.isEmpty { comps.queryItems = q }
        var request = URLRequest(url: comps.url!)
        request.timeoutInterval = 12
        webView.load(request)
    }

    @objc private func appWillEnterForeground() {
        proxy.kick()
        ink?.syncAll()
        DailyReminder.sync { [weak self] in self?.overlay.reminderMayHaveChanged() }
        switch state {
        case .failed, .idle:
            loadServer()
        case .loading:
            break
        case .loaded:
            if webView.url == nil {
                loadServer()
                return
            }
            // 页面内容被系统回收后会变成空白，这时重新加载。
            webView.evaluateJavaScript("document.body ? document.body.innerHTML.length : 0") { [weak self] result, error in
                guard let self = self else { return }
                let length = (result as? NSNumber)?.intValue ?? 0
                if error != nil || length == 0 {
                    self.loadServer()
                }
            }
        }
    }

    // MARK: - 站外链接

    /// http/https 用 SFSafariViewController（自带"完成"关闭），别的协议不管。
    fileprivate func openExternal(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return }
        externalOpened = true
        guard presentedViewController == nil else { return }
        let sf = SFSafariViewController(url: url)
        sf.preferredControlTintColor = Theme.accent
        sf.dismissButtonStyle = .close
        sf.modalPresentationStyle = .pageSheet
        present(sf, animated: true)
    }

    // MARK: - 原生设置面板、连不上页

    /// 打开设置面板（齿轮、三指长按 2 秒）。
    fileprivate func openSettings(animated: Bool = true) {
        guard !overlay.isShown else { return }
        mark.hide()
        overlay.showSettings(address: ServerSettings.address, animated: animated)
    }

    @objc private func hiddenEntryPressed(_ gr: UILongPressGestureRecognizer) {
        guard gr.state == .began else { return }
        openSettings()
    }

    /// 连不上的原因归成几类（对应 Copy.Fail 的人话），技术码另给，收在"详细信息"里。
    private static func reasonKey(_ error: Error) -> String {
        let ns = error as NSError
        guard ns.domain == NSURLErrorDomain else { return "other" }
        switch ns.code {
        case NSURLErrorTimedOut: return "timeout"
        case NSURLErrorCannotConnectToHost: return "refused"
        case NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost, NSURLErrorDataNotAllowed: return "nowifi"
        case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: return "notfound"
        case NSURLErrorAppTransportSecurityRequiresSecureConnection, NSURLErrorSecureConnectionFailed: return "blocked"
        case NSURLErrorBadURL, NSURLErrorUnsupportedURL: return "badaddr"
        default: return "other"
        }
    }

    private static func detail(_ error: Error) -> String {
        let ns = error as NSError
        // 系统的说明（localizedDescription）里又带一遍错误码，不要它；只留一行码和地址
        return "\(ns.domain) \(ns.code)\n\(ServerSettings.address)"
    }

    private func handleProvisionalFailure(_ error: Error) {
        let ns = error as NSError
        // 被新加载顶掉的、被策略打断的，不算失败。
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain" && ns.code == 102 { return }
        state = .failed
        paintOffline()
        overlay.showFailure(address: ServerSettings.address, reason: ShellViewController.reasonKey(error),
                            detail: ShellViewController.detail(error), canClose: false, animated: revealed || !ShotMode.isOn)
        if ShotMode.isOn && !shotStarted {
            shotStarted = true
            let reason = ShellViewController.reasonKey(error)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { self.shotReady("{\"panel\":true,\"reason\":\"\(reason)\",\"code\":\((error as NSError).code)}") }
        }
    }

    // MARK: - Pencil

    fileprivate func firePencilToggle() {
        // 兜底防抖：万一系统在同一次双击里调了两次回调，只执行一次。
        let now = ProcessInfo.processInfo.systemUptime
        if now - lastPencilFire < 0.25 { return }
        lastPencilFire = now
        guard state == .loaded, !overlay.isShown else { return }
        Haptics.select()
        // 草稿纸开着：网页切笔 / 橡皮并把新工具发给画布（工具条高亮跟着变）；收着：网页打开草稿纸。画布自己不处理双击。
        InkDiag.shared.log("pencil double tap -> web")
        webView.evaluateJavaScript(ShellViewController.pencilJS) { _, error in
            if let error = error {
                NSLog("Board2Shell: pencil JS failed: \(error)")
            }
        }
    }
}

// MARK: - WKNavigationDelegate

extension ShellViewController: WKNavigationDelegate {

    /// 主页面只许在 b2://board2/ 里走；别的地址（计组课这类 http/https 链接）用应用内浏览器打开，带关闭按钮，关掉回到原处。
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else { decisionHandler(.cancel); return }
        if (scheme == OfflineProxy.scheme && url.host == OfflineProxy.host) || ["about", "blob", "data"].contains(scheme) {
            decisionHandler(.allow); return
        }
        decisionHandler(.cancel)
        if navigationAction.targetFrame?.isMainFrame != false { openExternal(url) }
    }

    /// 网页换页了：草稿纸的画布先存盘收起（不等网页说，网页那头已经没了）。
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        ink?.forceClose("navigation committed")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        state = .loaded
        if overlay.mode == .failure || !overlay.isShown { overlay.hide() } else { overlay.setBusy(false) }
        reveal()
        paintOffline()
        proxy.kick()
        if ShotMode.isOn && !shotStarted {
            shotStarted = true
            if ShotMode.scene == "launch" {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { self.shotReady("{\"launch\":true}") }
            } else {
                runShotScene()
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleProvisionalFailure(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        // 页面已经显示出来之后的失败（个别资源没加载上），不挡住页面。
        NSLog("Board2Shell: navigation failed after commit: \(error)")
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled { return }
        if state == .loading { state = .loaded }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        NSLog("Board2Shell: web content process terminated, reloading")
        ink?.forceClose("web content process terminated")
        loadServer()
    }
}

// MARK: - WKUIDelegate

extension ShellViewController: WKUIDelegate {

    /// window.open 和 target=_blank：站内的在同一个 webView 里打开；站外的用应用内浏览器打开，主页面不动。
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if url.scheme?.lowercased() == OfflineProxy.scheme && url.host == OfflineProxy.host {
            webView.load(navigationAction.request)
        } else {
            openExternal(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
        if !presentSafely(alert) { completionHandler() }
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler(true) })
        if !presentSafely(alert) { completionHandler(false) }
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { field in field.text = defaultText }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "好", style: .default) { [weak alert] _ in
            completionHandler(alert?.textFields?.first?.text ?? "")
        })
        if !presentSafely(alert) { completionHandler(nil) }
    }

    /// 已经有弹窗在显示时不能再弹，返回 false 让调用方立刻回调，避免网页卡死。
    private func presentSafely(_ alert: UIAlertController) -> Bool {
        guard presentedViewController == nil, view.window != nil else { return false }
        present(alert, animated: true, completion: nil)
        return true
    }
}

// MARK: - UIPencilInteractionDelegate

extension ShellViewController: UIPencilInteractionDelegate {

    /// iPadOS 17.5 之前的旧回调。17.5 起实现了新回调后系统不再调用它；这里再判断一次，保证不会触发两次。
    func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        if #available(iOS 17.5, *) { return }
        firePencilToggle()
    }

    /// iPadOS 17.5+ 的双击回调。不看系统设置里"轻点两下"选的是什么，固定执行切换。
    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        firePencilToggle()
    }

    /// Apple Pencil Pro 的"捏一下"，只在松开（.ended）时执行一次。
    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        if squeeze.phase == .ended {
            firePencilToggle()
        }
    }
}

// MARK: - UIGestureRecognizerDelegate

extension ShellViewController: UIGestureRecognizerDelegate {
    /// 三指长按不抢网页自己的手势。
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        return true
    }
}

// MARK: - 离线提示条、弹一下的提示

extension ShellViewController {

    /// 弹一下的提示：样子照网页 .toast（顶部正中、强调色胶囊、从上面滑下来）。
    fileprivate func setUpBadges() {
        toastLabel.font = Theme.font(15, bold: true)
        toastLabel.textColor = Theme.onAccent
        toastLabel.backgroundColor = Theme.accent
        toastLabel.layer.cornerRadius = 21
        toastLabel.layer.cornerCurve = .continuous
        toastLabel.clipsToBounds = true
        toastLabel.textAlignment = .center
        toastLabel.numberOfLines = 1
        toastLabel.alpha = 0
        toastLabel.isUserInteractionEnabled = false
        toastLabel.insets = UIEdgeInsets(top: 10, left: 20, bottom: 10, right: 20)
        toastLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(toastLabel)
        NSLayoutConstraint.activate([
            toastLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            toastLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 18),
            toastLabel.heightAnchor.constraint(equalToConstant: 42),
            toastLabel.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -32)
        ])
        if let p = UserDefaults.standard.string(forKey: "b2mark"), ShotMode.isOn { mark.pinned = (p == "expanded") }
    }

    /// 网页摆好（<html data-ready="1">，最多等 4 秒）后淡入；之前是和启动画面同色的底。
    fileprivate func reveal() {
        guard !revealed else { return }
        if ShotMode.scene == "launch" { return }
        var tries = 0
        func check() {
            webView.evaluateJavaScript("document.documentElement.dataset.ready === '1'") { [weak self] r, _ in
                guard let self = self, !self.revealed else { return }
                tries += 1
                if (r as? Bool) == true || tries > 26 {
                    self.revealed = true
                    Motion.animate(Motion.big) { self.webView.alpha = 1 }
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { check() }
                }
            }
        }
        check()
    }

    /// 离线小标记：页面是从 iPad 上存的内容打开的、电脑又连不上时出现，放在画面区左上角。
    fileprivate func paintOffline() {
        let show = !proxy.online && state == .loaded && !overlay.isShown
        guard show else { mark.hide(); return }
        placeMark { self.mark.show() }
    }

    private func placeMark(_ then: (() -> Void)? = nil) {
        let js = "(function(){var e=document.querySelector('.stagewrap')||document.querySelector('#stage');if(!e)return null;var r=e.getBoundingClientRect();return [r.left,r.top];})()"
        webView.evaluateJavaScript(js) { [weak self] r, _ in
            guard let self = self else { return }
            let a = (r as? [NSNumber])?.map { CGFloat(truncating: $0) } ?? [0, 0]
            self.mark.place(in: self.view, at: CGPoint(x: a.first ?? 0, y: a.count > 1 ? a[1] : 0))
            then?()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        ink?.hostDidLayout()
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        let old = view.bounds.size
        super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: { _ in self.ink?.keepCenter(from: old, to: size) }) { _ in
            if self.mark.isOn { DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { self.placeMark() } }
        }
    }

    fileprivate func showToast(_ text: String) {
        toastWork?.cancel()
        toastLabel.text = text
        view.bringSubviewToFront(toastLabel)
        toastLabel.transform = toastLabel.alpha > 0 ? .identity : Motion.offset(-60)
        Motion.animate(Motion.big) {
            self.toastLabel.alpha = 1
            self.toastLabel.transform = .identity
        }
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            Motion.animate(Motion.big) {
                self.toastLabel.alpha = 0
                self.toastLabel.transform = Motion.offset(-60)
            }
        }
        toastWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2, execute: work)
    }
}

// MARK: - 网页发来的消息

extension ShellViewController: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard FetchBridge.trusted(message), let body = message.body as? [String: Any], let k = body["k"] as? String else { return }
        if message.name == "b2ink" {
            ink?.handle(body)
            return
        }
        switch k {
        case "theme":
            if let v = body["v"] as? String, ShotMode.theme == nil || v == ShotMode.theme { applyTheme(v) }
        case "migrated":
            StorageMigrator.finish()
        case "settings":
            openSettings()
        case "log":
            let v = body["v"] as? String ?? ""
            NSLog("Board2Shell JS: %@", String(v.prefix(200)))
            if ShotMode.isOn { shotLog.append(v); if shotLog.count > 40 { shotLog.removeFirst() }; ShotMode.hostWrite(".log", v, append: true) }
        case "audio":
            InkDiag.shared.log(String((body["v"] as? String ?? "").prefix(200)))
        case "cancel":
            let v = String((body["v"] as? String ?? "").prefix(300))
            InkDiag.shared.log(v)
            if ShotMode.isOn { ShotMode.hostWrite(".cancel.log", v, append: true) }
        default:
            break
        }
    }
}

// MARK: - 云端模拟器截图、自检

extension ShellViewController {

    /// 等网页把题摆好（<html data-ready="1">），按启动参数摆出要拍的画面，再写 Documents/ready.json 告诉 CI 可以拍了。
    fileprivate func runShotScene() {
        waitForReady(tries: 0) { [weak self] ready in
            guard let self = self else { return }
            let scene = ShotMode.scene ?? "main"
            var delay = 1.2
            switch scene {
            case "settings":
                self.openSettings(animated: false)
                let d = UserDefaults.standard
                if d.bool(forKey: "b2wheel") { self.overlay.shotOpenWheel() }
                if d.bool(forKey: "b2clear") { self.overlay.shotArmClear() }
            case "drawer":
                // 选题抽屉打开（点左上角题号），看抽屉顶上那排小图标里的"设置"入口
                // 今日题单是 2000 道（ci/fixture/data/today.json）；截图参数下网页不读记录，这里在内存里补上真实量级的"做了 1234、对 888、旗 99"（不存盘）
                let big = "try{var S=Board2,d=S.api.today(),L=S.today.list.slice(2);S.ans={};for(var i=0;i<1234;i++)S.ans[L[i]]={date:d,correct:i<888,fin:true};for(var j=0;j<33;j++)S.flags[L[j]]=['a','b','c'];}catch(e){}"
                self.webView.evaluateJavaScript(big + ";(document.getElementById('tag')||{click:function(){}}).click()", completionHandler: nil)
                // 顶上那排小图标和今日三个数、面包屑有没有压在一起、数字有没有被截断（check_selftest.py 检查）
                let probe = """
                (function(){var R=function(e){var b=e.getBoundingClientRect();return [b.left,b.top,b.right,b.bottom];};
                var hit=function(a,b){return a[0]<b[2]-0.5&&b[0]<a[2]-0.5&&a[1]<b[3]-0.5&&b[1]<a[3]-0.5;};
                var icons=[].slice.call(document.querySelectorAll('#drawer .b2set,#drawer .mkbtn.on,#drawer .wkbtn,#drawer .thbtn')).filter(function(e){return e.offsetWidth>0;});
                var texts=[].slice.call(document.querySelectorAll('#sum.on span,#nvh h2'));
                var overlap=[];icons.forEach(function(i){texts.forEach(function(t){if(t.offsetWidth>0&&hit(R(i),R(t)))overlap.push((i.id||i.className)+'/'+(t.id||t.parentNode.id));});});
                var cut=[].slice.call(document.querySelectorAll('#sum.on b')).filter(function(b){return b.scrollWidth>b.clientWidth+1;}).length;
                var small=icons.filter(function(i){return i.offsetWidth<42||i.offsetHeight<42;}).length;
                return JSON.stringify({ready:true,overlap:overlap,cut:cut,smallIcons:small,icons:icons.length,
                  sum:(document.getElementById('sum')||{}).textContent||'',down:document.documentElement.classList.contains('b2sumdown')});})()
                """
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
                    self.webView.evaluateJavaScript(probe) { r, _ in self.shotReady((r as? String) ?? "{\"ready\":false}") }
                }
                return
            case "draft":
                // 透明度：-b2alpha 0.5（网页草稿纸的 ui.alpha；改了以后让它按昼夜变化那条路重画一次工具条）
                let a = UserDefaults.standard.double(forKey: "b2alpha")
                let js = "Kit.draft && Kit.draft.open().then(function(){" + (a > 0 ? "Kit.draft.ui.alpha=\(a);var h=document.documentElement;h.setAttribute('data-theme',h.dataset.theme);" : "") + "})"
                self.webView.evaluateJavaScript(js, completionHandler: nil)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { self.ink?.drawSample() }
                delay = 2.2
            case "offline":
                delay = (self.mark.pinned == nil) ? 4.5 : 1.6
            case "motion":
                // 动效录像：页面淡入 → 打开设置面板 → 展开滚轮 → 收起 → 再打开 → 收起
                let seq: [(TimeInterval, () -> Void)] = [
                    (1.5, { self.openSettings() }),
                    (2.5, { self.overlay.hide() }),
                    (1.5, { self.openSettings() }),
                    (2.5, { self.overlay.hide() })
                ]
                var t: TimeInterval = 0
                for (d, f) in seq { t += d; DispatchQueue.main.asyncAfter(deadline: .now() + t, execute: f) }
                delay = t + 1.5
            case "motion-offline":
                // 离线标记：出现（展开）→ 3 秒后自己收起 → 点一下展开 → 4 秒后收起
                DispatchQueue.main.asyncAfter(deadline: .now() + 6.5) { self.mark.setExpanded(true, animated: true) }
                DispatchQueue.main.asyncAfter(deadline: .now() + 9.5) { self.mark.setExpanded(false, animated: true) }
                delay = 11.5
            case "selftest":
                self.runSelfTest(ready: ready)
                return
            case "inktest":
                // 真实触摸测试（UITests 的 testInk）：草稿纸收着开始（测试自己点按钮打开）；之后每 0.25 秒把状态写到 Mac 上，
                // 测试按状态里的位置去点、按命令文件让 App 换题 / 强制手指也写（模拟器没有笔）。
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.inkProbe() }
                delay = 2.0
            default:
                break
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                self.shotReady("{\"ready\":\(ready),\"online\":\(self.proxy.online)}")
            }
        }
    }

    /// testInk 用：每 0.25 秒写一次 <名字>.state.json（原生笔画、网页取景窗、工具条按钮的位置），读 <名字>.cmd 执行命令。
    fileprivate func inkProbe() {
        let js = """
        (function(){var r=function(el){if(!el)return null;var b=el.getBoundingClientRect();return [b.left,b.top,b.width,b.height];};
        if(window.__b2clicks===undefined){window.__b2clicks=0;window.__b2clk=0;document.addEventListener('pointerdown',function(){window.__b2clicks++;},true);document.addEventListener('click',function(e){if(e.isTrusted&&!(e.target.closest&&e.target.closest('#dtool')))window.__b2clk++;},false);}if(!window.__b2lc){window.__b2lc=[];document.addEventListener('click',function(e){var t=e.target,n=(t.id||t.className||t.tagName)+'';window.__b2lc.push(Math.round(performance.now())+':'+n.slice(0,30)+'@'+Math.round(e.clientX)+','+Math.round(e.clientY)+(e.isTrusted?'':'(synthetic)'));if(window.__b2lc.length>8)window.__b2lc.shift();},true);}
        var d=window.Kit&&Kit.draft,o=document.querySelector('.opt'),t=document.getElementById('dtool'),q=function(a){return t&&t.querySelector(a);};
        var cl=q('[data-a="clear"]'),su=q('.dsure');
        return JSON.stringify({id:d&&d.D.id,open:d&&d.D.open,tool:d&&d.ui.tool,color:d&&d.ui.color,finger:d&&!!d.ui.finger,side:d&&d.ui.side,
        V:d&&[d.V.x,d.V.y,d.V.z],W:innerWidth,H:innerHeight,q:window.Board2&&Board2.id,opt:r(o),clicks:window.__b2clicks,
        v2:d&&d.doc?d.doc.s.length:-1,clk:window.__b2clk,tag:r(document.getElementById('tag')),cells:{a:r(document.querySelector('#nv .pane:not(.out) .cell[data-id="2009-01"]')),b:r(document.querySelector('#nv .pane:not(.out) .cell[data-id="2009-02"]'))},drawer:!!(document.getElementById('drawer')&&document.getElementById('drawer').classList.contains('on')),lastClicks:window.__b2lc,toolEvs:window.__b2evs,toolClk:window.__b2toolclk,perf:window.__b2perf?{gaps:__b2perf.gaps,slow:__b2perf.slow}:null,aboveOn:['#fbp','#drawer','#sheet','#weak','#akPg','#akHere','.toast'].filter(function(k){var e=document.querySelector(k);return e&&e.classList.contains('on');}),stem:r(document.getElementById('stem')),dtoolShown:!!(t&&t.offsetWidth),dtool:r(t),draftBtn:r(document.getElementById('draftBtn')),
        clearSure:!!(cl&&cl.classList.contains('sure')),sureShown:!!(su&&su.classList.contains('on')),undoDisabled:!!(q('[data-a="undo"]')||{}).disabled,
        btn:{grip:r(q('[data-a="grip"]')),pen:r(q('[data-a="pen"]')),eraser:r(q('[data-a="eraser"]')),color:r(q('[data-a="color"]')),undo:r(q('[data-a="undo"]')),
        clear:r(cl),sure:r(su),zoom:r(q('[data-a="zoom"]')),more:r(q('[data-a="more"]')),close:r(q('[data-a="close"]')),red:r(q('.dpal [data-c="red"]')),blue:r(q('.dpal [data-c="blue"]')),finger:r(q('[data-a="finger"]'))},
        pal:!!(q('.dpal')&&q('.dpal').classList.contains('on')),moreOpen:!!(q('.dmore')&&q('.dmore').classList.contains('on'))});})()
        """
        webView.evaluateJavaScript(js) { [weak self] res, _ in
            guard let self = self else { return }
            var o: [String: Any] = ["native": self.ink?.debugInfo() ?? [:], "seq": self.inkCmdSeq, "ts": Int64((Date().timeIntervalSince1970 * 1000).rounded())]
            if let s = res as? String, let d = s.data(using: .utf8), let w = try? JSONSerialization.jsonObject(with: d) { o["web"] = w }
            MainBeat.time("probe-write") {
                if let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]), let s = String(data: d, encoding: .utf8) {
                    ShotMode.hostWrite(".state.json", s)
                }
            }
            if let dir = ShotMode.hostOut {
                let url = dir.appendingPathComponent(ShotMode.shotName + ".cmd")
                if let c = try? String(contentsOf: url, encoding: .utf8) {
                    try? FileManager.default.removeItem(at: url)
                    self.inkCommand(c.trimmingCharacters(in: .whitespacesAndNewlines))
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.inkProbe() }
        }
    }

    private func inkCommand(_ c: String) {
        inkCmdSeq += 1
        InkDiag.shared.log("test cmd \(c)")
        let parts = c.split(separator: " ").map(String.init)
        guard let k = parts.first else { return }
        switch k {
        case "goto":
            let id = parts.count > 1 ? parts[1] : "2009-01"
            webView.evaluateJavaScript("Board2.api.open('\(id)',{at:3})", completionHandler: nil)
        case "open":
            webView.evaluateJavaScript("Kit.draft.open()", completionHandler: nil)
        case "close":
            webView.evaluateJavaScript("Kit.draft.close()", completionHandler: nil)
        case "reset":
            ink?.testReset()
        case "resetall":
            // 每一轮从干净状态开始：App 的新笔迹全删、取景窗回原点；网页工具条回默认（墨、笔、贴右、手指书写关），本机暂存的旧稿删掉
            ink?.testWipeAll()
            webView.evaluateJavaScript("try{Object.keys(localStorage).filter(function(k){return k.indexOf('b2draft:')===0;}).forEach(function(k){localStorage.removeItem(k);});var u=Kit.draft.ui;u.color='ink';u.tool='pen';u.finger=false;u.side='r';u.y=0.5;localStorage.setItem('b2draftUI',JSON.stringify(u));}catch(e){};0", completionHandler: nil)
        case "pencil2":
            // 模拟器造不出 Pencil 双击：直接调 App 收到双击时的那个处理函数（不等于真机验证）
            firePencilToggle()
        case "closeall":
            webView.evaluateJavaScript("try{Board2.api.closeAll()}catch(e){};0", completionHandler: nil)
        case "finger":
            // on = 强制手指也写（模拟器没有笔）；auto = 跟工具条的手指书写开关走
            ink?.testFinger(parts.count > 1 && parts[1] == "on" ? true : nil)
        default:
            break
        }
    }

    /// 截图模式的隐形标签：UI 测试按 accessibilityIdentifier 找到它，label 变成 ready 就拍。
    fileprivate func setUpShotLabel() {
        guard ShotMode.isOn else { return }
        for (l, id) in [(shotLabel, "b2shot"), (shotLogLabel, "b2log")] {
            l.accessibilityIdentifier = id
            l.isAccessibilityElement = true
            l.alpha = 0.02
            l.font = .systemFont(ofSize: 2)
            l.frame = CGRect(x: 0, y: id == "b2shot" ? 0 : 3, width: 3, height: 3)
            view.addSubview(l)
        }
        paintShotLabel()
    }

    fileprivate func paintShotLabel() {
        guard ShotMode.isOn else { return }
        shotLabel.text = shotState
        shotLabel.accessibilityLabel = shotState
        shotLabel.accessibilityValue = shotValue
        shotLogLabel.text = "log"
        shotLogLabel.accessibilityLabel = "log"
        shotLogLabel.accessibilityValue = shotLog.joined(separator: "\n")
        view.bringSubviewToFront(shotLabel)
        view.bringSubviewToFront(shotLogLabel)
    }

    fileprivate func shotReady(_ value: String) {
        shotState = "ready"
        shotValue = value
        paintShotLabel()
        ShotMode.mark("ready.json", ["scene": ShotMode.scene ?? ""])
        ShotMode.hostWrite(".value.json", value)
        ShotMode.hostWrite(".ready", "ready")
    }

    private func waitForReady(tries: Int, done: @escaping (Bool) -> Void) {
        webView.evaluateJavaScript("document.documentElement.dataset.ready === '1'") { [weak self] result, _ in
            if (result as? Bool) == true { done(true); return }
            if tries >= 40 { done(false); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self?.waitForReady(tries: tries + 1, done: done) }
        }
    }

    /// 自检：这一页有几步、能不能一步一步走到最后、问答的流式接口经过 b2:// 能不能收到、POST 能不能带上内容。
    /// 结果写 Documents/selftest.json。
    private func runSelfTest(ready: Bool) {
        let js = """
        var out = { ready: \(ready ? "true" : "false") };
        try {
          out.appNone = document.querySelector('#app') ? document.querySelector('#app').classList.contains('none') : null;
          out.kit = Object.keys(window.Kit || {}).join(',');
          out.units = Object.keys((window.Kit && Kit.units) || {}).join(',');
          var ix = await fetch('data/index.json?t=' + Date.now()); out.indexStatus = ix.status;
          var qj = await fetch('questions/2009-01/q.json?t=' + Date.now()); out.qStatus = qj.status;
          if (!(window.Board2 && Board2.P)) {
            try { await Board2.api.open('2009-01', { at: 3 }); out.openOk = true; }
            catch (e) { out.openError = String(e && (e.stack || e.message || e)).slice(0, 800); }
          }
        } catch (e) { out.diagError = String(e && (e.stack || e)).slice(0, 400); }
        try {
          var S = window.Board2, P = S && S.P;
          out.id = S && S.id;
          out.steps = P ? P.N : -1;
          out.reached = -1;
          if (P) {
            for (var i = 0; i < P.N; i++) { P.go(i, { instant: true }); }
            await new Promise(function (r) { setTimeout(r, 300); });
            out.reached = P.index;
          }
          out.svgNodes = document.querySelectorAll('#stage svg *').length;
          var st = document.querySelector('#stem');
          out.stem = st && st.textContent ? st.textContent.length : 0;
        } catch (e) { out.error = String(e); }
        try {
          out.sse = await new Promise(function (res) {
            var got = [], es = new EventSource('ask/stream?selftest=1');
            var t = setTimeout(function () { try { es.close(); } catch (e) {} res(got); }, 4000);
            es.onmessage = function (ev) { got.push(ev.data); if (got.length >= 2) { clearTimeout(t); es.close(); res(got); } };
            es.onerror = function () { if (got.length) { clearTimeout(t); es.close(); res(got); } };
          });
        } catch (e) { out.sseError = String(e); }
        try {
          var r = await fetch('draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'selftest', doc: { v: 2, s: [], pages: [] } }) });
          out.postStatus = r.status;
          var g = await fetch('draft?id=selftest&t=' + Date.now());
          out.getStatus = g.status;
          var j = await g.json().catch(function () { return null; });
          out.postRoundTrip = !!(j && j.doc && Array.isArray(j.doc.pages));
        } catch (e) { out.postError = String(e); }
        try {
          var a = await fetch('answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'selftest', fin: true }) });
          out.answerStatus = a.status;
          var aj = await a.json().catch(function () { return null; });
          out.answerQueued = !!(aj && aj.queued);
        } catch (e) { out.answerError = String(e); }
        try {
          var rq = await fetch(new Request('draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'selftest-req', doc: { v: 2, s: [], pages: [] } }) }));
          out.reqPost = rq.status;
          var rg = await fetch('draft?id=selftest-req&t=' + Date.now()); var rj = await rg.json().catch(function () { return null; });
          out.reqRoundTrip = !!(rj && rj.doc && Array.isArray(rj.doc.pages));
        } catch (e) { out.reqError = String(e); }
        try {
          var ac = new AbortController(), pr = fetch('data/index.json?t=' + Date.now(), { signal: ac.signal }); ac.abort();
          try { await pr; out.abort = 'resolved'; } catch (e) { out.abort = e && e.name; }
        } catch (e) { out.abortError = String(e); }
        try {
          var ev = await window.webkit.messageHandlers.b2fetch.postMessage({ path: 'http://evil.example/x', method: 'POST', headers: {}, body: '' });
          out.evilStatus = ev && ev.status;
        } catch (e) { out.evilStatus = 'err'; }
        try {
          window.open('https://example.com/', '_blank');
          await new Promise(function (r) { setTimeout(r, 1200); });
          out.stillB2 = location.protocol === 'b2:' && !!document.querySelector('#app');
        } catch (e) { out.openError = String(e); }
        out.native = !!(window.B2Native);
        out.inkBridge = !!(window.Kit && Kit.draft && Kit.draft.native);
        return JSON.stringify(out);
        """
        webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { [weak self] result in
            var obj: [String: Any] = ["online": self?.proxy.online ?? false]
            obj["offlineReason"] = (self?.proxy.lastError).map { ShellViewController.reasonKey($0) } ?? NSNull()
            switch result {
            case .success(let v):
                if let s = v as? String, let d = s.data(using: .utf8),
                   let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                    obj.merge(o) { a, _ in a }
                } else {
                    obj["raw"] = String(describing: v)
                }
            case .failure(let e):
                obj["jsError"] = String(describing: e)
            }
            guard let self = self else { return }
            obj["idleTimerDisabled"] = UIApplication.shared.isIdleTimerDisabled
            obj["externalOpened"] = self.externalOpened
            self.presentedViewController?.dismiss(animated: false)
            // 原生这边的自检：缓存换版本、消息桥路径、笔迹存盘和上传（只在连得上时测上传）
            self.proxy.selfTest { p in
                obj.merge(p) { a, _ in a }
                let finish = {
                    ShotMode.mark("selftest.json", obj)
                    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data()
                    self.shotReady(String(data: data, encoding: .utf8) ?? "{}")
                }
                guard self.proxy.online, let ink = self.ink else { finish(); return }
                ink.selfTest { i in obj.merge(i) { a, _ in a }; finish() }
            }
        }
    }
}

// MARK: - 小工具

/// 带内边距的标签（提示条用）。
final class PaddedLabel: UILabel {
    var insets = UIEdgeInsets.zero
    override func drawText(in rect: CGRect) { super.drawText(in: rect.inset(by: insets)) }
    override var intrinsicContentSize: CGSize {
        let s = super.intrinsicContentSize
        return CGSize(width: s.width + insets.left + insets.right, height: s.height + insets.top + insets.bottom)
    }
}

/// WKUserContentController 会强引用消息处理者，中间隔一层免得 ShellViewController 释放不掉。
final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}

/// 接网页 fetch POST 的消息（带回复），交给 OfflineProxy.post。
final class FetchBridge: NSObject, WKScriptMessageHandlerWithReply {
    /// 只接主框架、b2://board2 页面发来的消息（iframe、别的地址发来的不理）。
    static func trusted(_ m: WKScriptMessage) -> Bool {
        let o = m.frameInfo.securityOrigin
        return m.frameInfo.isMainFrame && o.protocol == OfflineProxy.scheme && o.host == OfflineProxy.host
    }

    private weak var proxy: OfflineProxy?
    init(proxy: OfflineProxy) { self.proxy = proxy }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard FetchBridge.trusted(message), let b = message.body as? [String: Any], let path = b["path"] as? String,
              path.hasPrefix("/"), !path.hasPrefix("//"), let proxy = proxy else {
            replyHandler(["status": 400, "b64": "", "type": "text/plain"], nil); return
        }
        let method = (b["method"] as? String ?? "GET").uppercased()
        // 诊断：草稿相关的请求记一行（网页发起→App 收到→电脑回来各用了多久），查"打开草稿纸后旧稿晚到"用
        let isDraft = path.hasPrefix("/draft")
        let t0 = ProcessInfo.processInfo.systemUptime
        let tag = isDraft ? "\(method) \(String(path.prefix(60)))" : ""
        if isDraft { InkDiag.shared.log("fetch \(tag) received from web") }
        let done: (Int) -> Void = { status in
            if isDraft { InkDiag.shared.log("fetch \(tag) status=\(status) took \(Int((ProcessInfo.processInfo.systemUptime - t0) * 1000))ms, replying to web") }
        }
        if method == "GET" || method == "HEAD" {
            proxy.get(pathAndQuery: path) { status, data, type in
                done(status)
                replyHandler(["status": status, "b64": data.base64EncodedString(), "type": type], nil)
            }
            return
        }
        let body = Data((b["body"] as? String ?? "").utf8)
        let headers = b["headers"] as? [String: String] ?? [:]
        proxy.post(pathAndQuery: path, method: method, headers: headers, body: body) { status, text, type in
            done(status)
            replyHandler(["status": status, "b64": Data(text.utf8).base64EncodedString(), "type": type], nil)
        }
    }
}

/// 根视图：草稿纸开着（或云端截图模式）时，把每一下触摸落到了哪个视图上记进笔迹诊断日志——真机上"点不动"时能看出触摸被谁收走了。
/// 系统找"这一下落在谁身上"时会问好几遍，同一个事件只记一次。
final class DiagRootView: UIView {
    private var lastStamp: TimeInterval = -1
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let v = super.hitTest(point, with: event)
        if let e = event, e.type == .touches, e.timestamp != lastStamp, InkDiag.shared.touchLogging || ShotMode.isOn {
            lastStamp = e.timestamp
            var chain: [String] = [], cur = v
            while let c = cur, chain.count < 5 { chain.append(String(describing: type(of: c))); cur = c.superview }
            InkDiag.shared.log("hit \(InkDiag.pt(point)) -> \(chain.isEmpty ? "nil" : chain.joined(separator: "<"))")
        }
        return v
    }
}
