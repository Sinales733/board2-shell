import Foundation
import WebKit
import CryptoKit

/// 离线可用的核心：网页不再直接从 http://电脑:8409 读，而是从 b2://board2/ 读，由这里转给电脑。
/// - 电脑连得上：照常转发（问答的流式回答也一段一段转），GET 到的东西顺手存进 iPad。
/// - 电脑连不上：GET 从 iPad 上存的取；记录类 POST（答题、看过、标记……）先排队，连上后按顺序补发；
///   问答、报修直接告诉网页发不出去。草稿纸网页自己会在发不出去时存本机，连上后再对时间取新的。
/// - 判断"连不上"：一个请求失败后马上再探测一次（或连着两次失败）才切到离线，不因为一次偶发超时就整体切换。
/// 页面地址固定是 b2://board2/，换了电脑 IP 也不影响网页存在本机的东西（localStorage 跟着地址走）。
final class OfflineProxy: NSObject, WKURLSchemeHandler {

    static let scheme = "b2"
    static let host = "board2"
    static var pageURL: URL { URL(string: "\(scheme)://\(host)/")! }

    enum Text {
        static let pill = "没连电脑，能看讲解、写草稿，问答报修用不了"
        static let blocked = "没连上电脑，没发出去，等连上电脑后再发"
        static let back = "连上电脑了，存的草稿和记录已传过去"
        static let missing = "没连上电脑，这道题还没存，连上才能看"
    }

    /// 连没连上电脑变了（主线程回调）。
    var onOnlineChange: ((Bool) -> Void)?
    /// 重新连上、排队的记录补发完了：参数是这次真补发成功了几条（主线程回调）。
    var onReplayed: ((Int) -> Void)?
    /// 要在屏幕上弹一下的提示（主线程回调）。
    var onToast: ((String) -> Void)?

    /// 当前判断：电脑连得上吗。一开始当连得上。
    private(set) var online = true
    /// 最近一次连不上的原因（连不上页按它说人话）。
    private(set) var lastError: NSError?
    /// 截图 / 自检用：不读也不写 iPad 上存的内容。
    var cacheDisabled = false

    private let store = OfflineStore()
    private var session: URLSession!
    private var streamSession: URLSession!
    /// 正在转发的：URLSession 的任务 → 网页那边的任务。
    private var live: [ObjectIdentifier: Forward] = [:]
    /// 网页那边还在等回话的任务。结束或被取消就拿掉（不能记"已结束"的：对象地址会被新任务重用）。
    private var active = Set<ObjectIdentifier>()
    private var probeTimer: Timer?
    private var replaying = false
    private var failures = 0
    private var confirming = false

    private final class Forward {
        let task: WKURLSchemeTask
        let key: String?
        let isMain: Bool
        let stream: Bool
        var response: HTTPURLResponse?
        var buffer = Data()
        var sentResponse = false
        var dataTask: URLSessionTask?
        init(task: WKURLSchemeTask, key: String?, isMain: Bool, stream: Bool) {
            self.task = task; self.key = key; self.isMain = isMain; self.stream = stream
        }
    }

    override init() {
        super.init()
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 6
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.httpMaximumConnectionsPerHost = 6
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: .main)
        let scfg = URLSessionConfiguration.ephemeral
        scfg.timeoutIntervalForRequest = 600
        scfg.timeoutIntervalForResource = 3600
        scfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        streamSession = URLSession(configuration: scfg, delegate: self, delegateQueue: .main)
        store.trim()
    }

    // MARK: - 路径

    /// 不进 iPad 缓存的 GET：流式问答、监听状态。
    private static func isUncachedGet(_ path: String) -> Bool {
        return path == "/ask/stream" || path == "/status"
    }
    /// 连不上时排队、连上后补发的 POST（都是小的记录）。
    static let queuedPosts: Set<String> = ["/answer", "/seen", "/state", "/missing", "/flag", "/pref", "/feedback/viewed", "/mock"]
    /// 连不上就直接告诉他发不出去的 POST。
    private static func isOnlineOnlyPost(_ path: String) -> Bool {
        return path == "/ask" || path.hasPrefix("/ask/") || path == "/report" || path.hasPrefix("/report/") || path == "/feedback"
    }

    /// 缓存的键：路径 + 去掉 t= 之后的查询（网页用 ?t=时间 防浏览器缓存，每次都不一样）。
    static func cacheKey(for url: URL) -> String {
        guard var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url.path }
        comps.queryItems = comps.queryItems?.filter { $0.name != "t" }.sorted { $0.name < $1.name }
        if comps.queryItems?.isEmpty == true { comps.queryItems = nil }
        let path = comps.percentEncodedPath.isEmpty ? "/" : comps.percentEncodedPath
        if let q = comps.percentEncodedQuery { return path + "?" + q }
        return path
    }

    /// b2://board2/<路径> → http://电脑:端口/<路径>。只换主机，路径和查询原样。
    private func serverURL(for url: URL) -> URL? {
        guard let base = ServerSettings.url,
              var comps = URLComponents(url: base, resolvingAgainstBaseURL: false),
              let src = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        var basePath = comps.percentEncodedPath
        if basePath.hasSuffix("/") { basePath.removeLast() }
        let p = src.percentEncodedPath.isEmpty ? "/" : src.percentEncodedPath
        comps.percentEncodedPath = basePath + p
        comps.percentEncodedQuery = src.percentEncodedQuery
        return comps.url
    }

    /// 网页消息桥传来的"路径 + 查询"：只认以单个 / 开头的站内路径，拼成 b2://board2/…（不许借它请求别的主机）。
    static func pageURL(forPath p: String) -> URL? {
        guard p.hasPrefix("/"), !p.hasPrefix("//"), !p.contains("\\"),
              let u = URL(string: "\(scheme)://\(host)" + p), u.scheme == scheme, u.host == host else { return nil }
        return u
    }

    // MARK: - 连没连上

    /// "连不上电脑"类的错误。neverSent：请求肯定没到电脑（这类 POST 可以排队补发；超时、断线可能已经写进去了，不能重发）。
    private static func isOfflineError(_ error: Error) -> Bool {
        let ns = error as NSError
        guard ns.domain == NSURLErrorDomain else { return false }
        return [NSURLErrorCannotConnectToHost, NSURLErrorTimedOut, NSURLErrorNotConnectedToInternet,
                NSURLErrorNetworkConnectionLost, NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed,
                NSURLErrorInternationalRoamingOff, NSURLErrorDataNotAllowed, NSURLErrorSecureConnectionFailed,
                NSURLErrorAppTransportSecurityRequiresSecureConnection].contains(ns.code)
    }
    private static func neverSent(_ error: Error) -> Bool {
        let ns = error as NSError
        guard ns.domain == NSURLErrorDomain else { return false }
        return [NSURLErrorCannotConnectToHost, NSURLErrorNotConnectedToInternet, NSURLErrorCannotFindHost,
                NSURLErrorDNSLookupFailed, NSURLErrorInternationalRoamingOff, NSURLErrorDataNotAllowed].contains(ns.code)
    }

    private func succeeded() {
        failures = 0
        setOnline(true)
    }

    /// 一个请求连不上：连着两次失败就切离线；第一次失败先马上探测一次，探测也失败才切。
    private func failed(_ error: Error) {
        lastError = error as NSError
        failures += 1
        guard online else { return }
        if failures >= 2 { setOnline(false); return }
        guard !confirming else { return }
        confirming = true
        probe { [weak self] ok in
            guard let self = self else { return }
            self.confirming = false
            if ok { self.failures = 0 } else { self.setOnline(false) }
        }
    }

    private func setOnline(_ value: Bool) {
        guard value != online else { return }
        online = value
        if value {
            failures = 0
            probeTimer?.invalidate(); probeTimer = nil
            replayQueue()
        } else {
            startProbing()
        }
        onOnlineChange?(value)
    }

    /// 连不上时每 8 秒试一下电脑回来了没有。
    private func startProbing() {
        probeTimer?.invalidate()
        probeTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: true) { [weak self] _ in
            self?.probe { ok in if ok { self?.succeeded() } }
        }
    }

    func probe(_ done: ((Bool) -> Void)? = nil) {
        guard let base = ServerSettings.url, let url = URL(string: "data/index.json", relativeTo: base) else { done?(false); return }
        var r = URLRequest(url: url)
        r.timeoutInterval = 4
        r.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: r) { _, resp, err in
            let ok = (resp as? HTTPURLResponse).map { $0.statusCode < 500 } ?? false
            DispatchQueue.main.async {
                if !ok, let err = err { self.lastError = err as NSError }
                done?(ok)
            }
        }.resume()
    }

    // MARK: - WKURLSchemeHandler

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let req = urlSchemeTask.request
        guard let url = req.url else { return }
        active.insert(ObjectIdentifier(urlSchemeTask))
        let method = (req.httpMethod ?? "GET").uppercased()
        let path = url.path.isEmpty ? "/" : url.path
        let isMain = req.mainDocumentURL == url

        if method == "GET" || method == "HEAD" {
            let cacheable = !OfflineProxy.isUncachedGet(path) && !cacheDisabled
            let key = cacheable ? OfflineProxy.cacheKey(for: url) : nil
            if !online {
                // 已知连不上：不等网络，直接用存的。
                serveCached(key, to: urlSchemeTask, isMain: isMain, path: path)
                return
            }
            forward(urlSchemeTask, method: method, body: nil, key: key, isMain: isMain, stream: path == "/ask/stream")
            return
        }

        // 页面里的 POST 基本都走 fetch 消息桥（post(...)）；这里只是兜底（表单之类），请求体可能已被 WebKit 丢掉。
        let body = OfflineProxy.body(of: req)
        if !online {
            let (st, obj) = offlinePost(path: path, body: body)
            respondJSON(urlSchemeTask, status: st, obj)
            return
        }
        forward(urlSchemeTask, method: method, body: body, key: nil, isMain: false, stream: false)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        active.remove(ObjectIdentifier(urlSchemeTask))
        for (id, f) in live where f.task === urlSchemeTask {
            live[id] = nil
            f.dataTask?.cancel()
        }
    }

    private static func body(of req: URLRequest) -> Data? {
        if let b = req.httpBody { return b }
        guard let stream = req.httpBodyStream else { return nil }
        stream.open(); defer { stream.close() }
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 16384)
        while stream.hasBytesAvailable {
            let n = stream.read(&buf, maxLength: buf.count)
            if n <= 0 { break }
            data.append(buf, count: n)
        }
        return data
    }

    // MARK: - 转发

    private func forward(_ task: WKURLSchemeTask, method: String, body: Data?, key: String?, isMain: Bool, stream: Bool) {
        guard let target = serverURL(for: task.request.url!) else {
            fail(task, code: NSURLErrorBadURL)
            return
        }
        var r = URLRequest(url: target)
        r.httpMethod = method
        r.httpBody = body
        for (k, v) in task.request.allHTTPHeaderFields ?? [:] where ["content-type", "accept", "last-event-id"].contains(k.lowercased()) {
            r.setValue(v, forHTTPHeaderField: k)
        }
        if isMain { r.timeoutInterval = 6 }
        let s = stream ? streamSession! : session!
        let dt = s.dataTask(with: r)
        let f = Forward(task: task, key: key, isMain: isMain, stream: stream)
        f.dataTask = dt
        live[ObjectIdentifier(dt)] = f
        dt.resume()
    }

    private func isAlive(_ task: WKURLSchemeTask) -> Bool {
        return active.contains(ObjectIdentifier(task))
    }

    private func respond(_ task: WKURLSchemeTask, status: Int, type: String, data: Data) {
        guard isAlive(task), let url = task.request.url else { return }
        let headers = ["Content-Type": type, "Cache-Control": "no-store", "Content-Length": String(data.count)]
        let resp = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
        active.remove(ObjectIdentifier(task))
    }

    private func respondJSON(_ task: WKURLSchemeTask, status: Int, _ obj: [String: Any]) {
        let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
        respond(task, status: status, type: "application/json; charset=utf-8", data: data)
    }

    private func fail(_ task: WKURLSchemeTask, code: Int) {
        guard isAlive(task) else { return }
        task.didFailWithError(NSError(domain: NSURLErrorDomain, code: code, userInfo: nil))
        active.remove(ObjectIdentifier(task))
    }

    // MARK: - 连不上时

    /// 用 iPad 上存的回话（读文件在后台）。没存：主页面按真实的连不上原因失败（连不上页据此说人话），其余回 504。
    private func serveCached(_ key: String?, to task: WKURLSchemeTask, isMain: Bool, path: String) {
        guard let key = key, !cacheDisabled else { missed(task, isMain: isMain, path: path); return }
        store.read(key) { [weak self] hit in
            guard let self = self else { return }
            if let hit = hit { self.respond(task, status: 200, type: hit.type, data: hit.data) }
            else { self.missed(task, isMain: isMain, path: path) }
        }
    }

    private func missed(_ task: WKURLSchemeTask, isMain: Bool, path: String) {
        if isMain {
            fail(task, code: lastError?.code ?? NSURLErrorCannotConnectToHost)
            return
        }
        if path.hasPrefix("/questions/") && path.hasSuffix("/q.json") { onToast?(Text.missing) }
        respondJSON(task, status: 504, ["error": "offline", "offline": true])
    }

    /// 连不上时的 POST：记录类排队、回"好了"；问答报修说发不出去；/draft 等说发不出去（网页自己存本机）。
    private func offlinePost(path: String, body: Data?, reqId: String? = nil) -> (Int, [String: Any]) {
        if OfflineProxy.queuedPosts.contains(path) {
            store.enqueue(path: path, body: body ?? Data(), reqId: reqId ?? UUID().uuidString)
            return (200, ["ok": true, "queued": true])
        }
        if OfflineProxy.isOnlineOnlyPost(path) {
            onToast?(Text.blocked)
            return (503, ["error": Text.blocked, "offline": true])
        }
        return (503, ["error": "offline", "offline": true])
    }

    /// 网页 fetch 的 GET 走这里（和 b2:// 的 GET 同一套：连得上转给电脑并存一份，连不上用存的）。
    func get(pathAndQuery: String, reply: @escaping (Int, Data, String) -> Void) {
        guard let url = OfflineProxy.pageURL(forPath: pathAndQuery) else { reply(400, Data(), "text/plain"); return }
        let path = url.path.isEmpty ? "/" : url.path
        let cacheable = !OfflineProxy.isUncachedGet(path) && !cacheDisabled
        let key = OfflineProxy.cacheKey(for: url)
        let fromCache: () -> Void = { [weak self] in
            guard let self = self else { return }
            let miss = {
                if path.hasPrefix("/questions/") && path.hasSuffix("/q.json") { self.onToast?(Text.missing) }
                reply(504, Data("{\"error\":\"offline\",\"offline\":true}".utf8), "application/json")
            }
            guard cacheable else { miss(); return }
            self.store.read(key) { hit in if let hit = hit { reply(200, hit.data, hit.type) } else { miss() } }
        }
        if !online { fromCache(); return }
        guard let target = serverURL(for: url) else { reply(0, Data(), ""); return }
        var r = URLRequest(url: target)
        r.timeoutInterval = 6
        r.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: r) { [weak self] data, resp, err in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let err = err {
                    if OfflineProxy.isOfflineError(err) { self.failed(err); fromCache() } else { reply(0, Data(), "") }
                    return
                }
                self.succeeded()
                let http = resp as? HTTPURLResponse
                let type = (http?.allHeaderFields.first { ($0.key as? String)?.lowercased() == "content-type" }?.value as? String)
                    ?? OfflineStore.guessType(path)
                let body = data ?? Data()
                if cacheable, http?.statusCode == 200 { self.store.write(key, type: type, data: body) }
                reply(http?.statusCode ?? 200, body, type)
            }
        }.resume()
    }

    /// 网页的 POST 走这里（WebKit 交给自定义地址的请求会丢掉请求体，所以页面开头把 fetch 改成发消息给 App，
    /// 见 ShellViewController.fetchJS）。reply：(状态码, 内容, 类型)；状态码 0 表示网络错误（网页那边当 fetch 失败）。
    /// 记录类（queuedPosts）每条带一个请求号（X-B2-Req），电脑那边据此去重；补发期间来的新记录排到队尾，保证先后顺序。
    func post(pathAndQuery: String, method: String, headers: [String: String], body: Data,
              reply: @escaping (Int, String, String) -> Void) {
        guard let pageURL = OfflineProxy.pageURL(forPath: pathAndQuery), let target = serverURL(for: pageURL) else {
            reply(400, "{\"error\":\"bad path\"}", "application/json"); return
        }
        let path = pageURL.path.isEmpty ? "/" : pageURL.path
        let queued = OfflineProxy.queuedPosts.contains(path)
        let reqId = UUID().uuidString
        let answer: (Int, [String: Any]) -> Void = { status, obj in
            let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
            reply(status, String(data: data, encoding: .utf8) ?? "{}", "application/json; charset=utf-8")
        }
        if !online {
            let (st, obj) = offlinePost(path: path, body: body, reqId: reqId)
            answer(st, obj)
            return
        }
        if queued && (replaying || store.hasQueued()) {
            // 还有没补发完的旧记录：这条排到它们后面，不然旧值会在新值之后到、把新值盖掉
            store.enqueue(path: path, body: body, reqId: reqId)
            answer(200, ["ok": true, "queued": true])
            replayQueue()
            return
        }
        var r = URLRequest(url: target)
        r.httpMethod = method
        r.httpBody = body
        r.timeoutInterval = 15
        for (k, v) in headers where k.lowercased() == "content-type" { r.setValue(v, forHTTPHeaderField: k) }
        if r.value(forHTTPHeaderField: "Content-Type") == nil { r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if queued { r.setValue(reqId, forHTTPHeaderField: "X-B2-Req") }
        URLSession.shared.dataTask(with: r) { [weak self] data, resp, err in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let err = err {
                    if OfflineProxy.isOfflineError(err) { self.failed(err) }
                    if OfflineProxy.neverSent(err) {
                        // 肯定没到电脑：记录类排队补发，问答报修说发不出去
                        let (st, obj) = self.offlinePost(path: path, body: body, reqId: reqId)
                        answer(st, obj)
                    } else {
                        // 超时、半路断线：电脑可能已经写进去了，不排队重发，直接告诉网页失败
                        reply(0, "", "")
                    }
                    return
                }
                self.succeeded()
                let http = resp as? HTTPURLResponse
                let type = (http?.allHeaderFields.first { ($0.key as? String)?.lowercased() == "content-type" }?.value as? String) ?? "application/json"
                if path == "/draft", http?.statusCode == 200 { self.refreshDraftCache(body) }
                reply(http?.statusCode ?? 200, String(data: data ?? Data(), encoding: .utf8) ?? "", type)
            }
        }.resume()
    }

    /// 草稿写上电脑以后，把离线用的 GET /draft?id=<题号> 那条缓存换成刚写上去的这份（格式和电脑回的一样：{id, doc}）。
    /// 不换的话：清空后写上电脑、网页删了本机那份，下次离线打开同一题会读到缓存里清空前的旧稿。
    private func refreshDraftCache(_ body: Data) {
        guard let o = try? JSONSerialization.jsonObject(with: body) as? [String: Any], let id = o["id"] as? String,
              var comps = URLComponents(string: "b2://x/draft") else { return }
        comps.queryItems = [URLQueryItem(name: "id", value: id)]
        guard let q = comps.percentEncodedQuery, let url = OfflineProxy.pageURL(forPath: "/draft?" + q),
              let data = try? JSONSerialization.data(withJSONObject: ["id": id, "doc": o["doc"] ?? NSNull()]) else { return }
        store.write(OfflineProxy.cacheKey(for: url), type: "application/json; charset=utf-8", data: data)
    }

    // MARK: - 补发

    /// 补发排队的记录，按顺序一条一条来；中途又连不上就停下，下次接着发。发完再看一眼队列（补发期间新排进来的）。
    private func replayQueue() {
        guard !replaying, online else { return }
        replaying = true
        runReplay(sentSoFar: 0)
    }

    private func runReplay(sentSoFar: Int) {
        guard online, let base = ServerSettings.url else { replaying = false; return }
        store.queued { [weak self] items in
            guard let self = self else { return }
            guard !items.isEmpty else {
                self.replaying = false
                self.onReplayed?(sentSoFar)
                return
            }
            var sent = sentSoFar
            func next(_ i: Int) {
                guard i < items.count else { self.runReplay(sentSoFar: sent); return }
                let item = items[i]
                guard let pu = OfflineProxy.pageURL(forPath: item.path), let url = self.serverURL(for: pu) ?? URL(string: String(item.path.dropFirst()), relativeTo: base) else {
                    self.store.dequeue(item.file); next(i + 1); return
                }
                var r = URLRequest(url: url)
                r.httpMethod = "POST"
                r.httpBody = item.body
                r.setValue("application/json", forHTTPHeaderField: "Content-Type")
                r.setValue(item.reqId, forHTTPHeaderField: "X-B2-Req")
                r.timeoutInterval = 8
                URLSession.shared.dataTask(with: r) { _, resp, err in
                    DispatchQueue.main.async {
                        if let err = err, resp == nil {
                            self.replaying = false
                            if OfflineProxy.isOfflineError(err) { self.failed(err) }
                            if sent > 0 { self.onReplayed?(sent) }
                            return
                        }
                        // 电脑回话了（哪怕说格式不对）就不再重发，免得卡住后面的；万一重发了，电脑按请求号去重。
                        self.store.dequeue(item.file)
                        sent += 1
                        next(i + 1)
                    }
                }.resume()
            }
            next(0)
        }
    }

    /// 设置面板用（后台算，主线程回调）。
    func cacheStats(_ done: @escaping (Int, Int64) -> Void) { store.stats(done) }
    func clearCache(_ done: (() -> Void)? = nil) { store.clear(done) }

    /// 改了服务器地址、点了重试：先当连得上，让下一个请求真的去试。
    func assumeOnline() {
        probeTimer?.invalidate(); probeTimer = nil
        failures = 0
        online = true
    }

    /// 页面重新连上以后的一次补发（App 回到前台时也调）。
    func kick() {
        if online { replayQueue() } else { probe { [weak self] ok in if ok { self?.succeeded() } } }
    }

    // MARK: - 自检用

    /// 同一路径换了 v= 以后只留最新那份（第 18 条）；消息桥不许请求别的主机（第 19 条）。
    func selfTest(_ done: @escaping ([String: Any]) -> Void) {
        var out: [String: Any] = [:]
        out["badPathRejected"] = OfflineProxy.pageURL(forPath: "http://evil.example/x") == nil
            && OfflineProxy.pageURL(forPath: "//evil.example/x") == nil
            && OfflineProxy.pageURL(forPath: "/data/index.json") != nil
        let a = "/selftest/cache.js?v=1", b = "/selftest/cache.js?v=2"
        store.write(a, type: "text/plain", data: Data("one".utf8))
        store.write(b, type: "text/plain", data: Data("two".utf8))
        store.read(a) { ha in
            self.store.read(b) { hb in
                out["oldVersionEvicted"] = ha == nil && hb != nil
                done(out)
            }
        }
    }
}

// MARK: - URLSessionDataDelegate

extension OfflineProxy: URLSessionDataDelegate {

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let f = live[ObjectIdentifier(dataTask)], isAlive(f.task), let http = response as? HTTPURLResponse else {
            completionHandler(.cancel); return
        }
        succeeded()
        f.response = http
        var headers: [String: String] = [:]
        for (k, v) in http.allHeaderFields {
            if let k = k as? String, let v = v as? String, ["content-type", "content-length", "cache-control", "last-modified"].contains(k.lowercased()) {
                headers[k] = v
            }
        }
        if headers.keys.first(where: { $0.lowercased() == "content-type" }) == nil {
            headers["Content-Type"] = OfflineStore.guessType(f.task.request.url?.path ?? "")
        }
        let out = HTTPURLResponse(url: f.task.request.url!, statusCode: http.statusCode, httpVersion: "HTTP/1.1", headerFields: headers)!
        f.task.didReceive(out)
        f.sentResponse = true
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let f = live[ObjectIdentifier(dataTask)], isAlive(f.task) else { return }
        f.task.didReceive(data)
        if f.key != nil { f.buffer.append(data) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let f = live.removeValue(forKey: ObjectIdentifier(task)) else { return }
        guard isAlive(f.task) else { return }
        if let error = error {
            if OfflineProxy.isOfflineError(error) { failed(error) }
            if !f.sentResponse && OfflineProxy.isOfflineError(error) {
                let req = f.task.request
                let path = req.url?.path ?? "/"
                let method = (req.httpMethod ?? "GET").uppercased()
                if method == "GET" || method == "HEAD" {
                    serveCached(f.key, to: f.task, isMain: f.isMain, path: path)
                } else if OfflineProxy.neverSent(error) {
                    let (st, obj) = offlinePost(path: path, body: OfflineProxy.body(of: req))
                    respondJSON(f.task, status: st, obj)
                } else {
                    f.task.didFailWithError(error)
                    active.remove(ObjectIdentifier(f.task))
                }
                return
            }
            // 已经开始回话后断了：流式问答当正常结束（网页会自己重连）；其余一律报错，免得网页拿到截断的 JS / JSON
            if f.sentResponse && f.stream { f.task.didFinish() } else { f.task.didFailWithError(error) }
            active.remove(ObjectIdentifier(f.task))
            return
        }
        f.task.didFinish()
        active.remove(ObjectIdentifier(f.task))
        if let key = f.key, let resp = f.response, resp.statusCode == 200 {
            let type = (resp.allHeaderFields.first { ($0.key as? String)?.lowercased() == "content-type" }?.value as? String)
                ?? OfflineStore.guessType(f.task.request.url?.path ?? "")
            store.write(key, type: type, data: f.buffer)
        }
    }
}

// MARK: - iPad 上存的东西

/// 存在 Application Support/offline/ 下（系统清理空间时不会删这里）。
/// cache/<sha256>.bin + .type + .key：每个网址一份；queue/<时间>.json：排队等补发的记录。
/// 所有文件读写都在一个后台串行队列上，回调回主线程。
/// 淘汰：同一路径只留最新的 v=（网页每升一次版本号就会多一份旧的）；总大小超过 1.5 GB 时按最久没用的删到 1.2 GB。
final class OfflineStore {
    private let fm = FileManager.default
    private let root: URL
    private let cacheDir: URL
    private let queueDir: URL
    private let io = DispatchQueue(label: "board2.offline.store")
    /// 路径（不带查询）→ 这个路径下存着的文件名们；第一次用时扫一遍 .key 建起来（只在 io 队列上碰）。
    private var index: [String: Set<String>]?
    private var queuedCount = 0

    private static let maxBytes: Int64 = 1_500_000_000
    private static let trimTo: Int64 = 1_200_000_000

    init() {
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        root = base.appendingPathComponent("offline", isDirectory: true)
        cacheDir = root.appendingPathComponent("cache", isDirectory: true)
        queueDir = root.appendingPathComponent("queue", isDirectory: true)
        try? fm.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        try? fm.createDirectory(at: queueDir, withIntermediateDirectories: true)
        var rv = URLResourceValues(); rv.isExcludedFromBackup = true
        var r = root; try? r.setResourceValues(rv)
        queuedCount = ((try? fm.contentsOfDirectory(atPath: queueDir.path)) ?? []).filter { $0.hasSuffix(".json") }.count
    }

    private func name(_ key: String) -> String {
        return SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private static func pathPart(_ key: String) -> String { String(key.split(separator: "?", maxSplits: 1).first ?? Substring(key)) }
    private func main(_ f: @escaping () -> Void) { DispatchQueue.main.async(execute: f) }

    func read(_ key: String, done: @escaping ((type: String, data: Data)?) -> Void) {
        let n = name(key)
        io.async {
            let bin = self.cacheDir.appendingPathComponent(n + ".bin")
            guard let data = try? Data(contentsOf: bin) else { self.main { done(nil) }; return }
            let type = (try? String(contentsOf: self.cacheDir.appendingPathComponent(n + ".type"), encoding: .utf8)) ?? "application/octet-stream"
            try? self.fm.setAttributes([.modificationDate: Date()], ofItemAtPath: bin.path)   // 记"最近用过"，淘汰时留着
            self.main { done((type, data)) }
        }
    }

    private func buildIndex() -> [String: Set<String>] {
        if let i = index { return i }
        var i: [String: Set<String>] = [:]
        for f in (try? fm.contentsOfDirectory(at: cacheDir, includingPropertiesForKeys: nil)) ?? [] where f.pathExtension == "key" {
            if let k = try? String(contentsOf: f, encoding: .utf8) {
                i[OfflineStore.pathPart(k), default: []].insert(f.deletingPathExtension().lastPathComponent)
            }
        }
        index = i
        return i
    }

    private func remove(_ n: String) {
        for ext in ["bin", "type", "key"] { try? fm.removeItem(at: cacheDir.appendingPathComponent(n + "." + ext)) }
    }

    func write(_ key: String, type: String, data: Data) {
        let n = name(key)
        io.async { [cacheDir] in
            try? data.write(to: cacheDir.appendingPathComponent(n + ".bin"), options: .atomic)
            try? type.write(to: cacheDir.appendingPathComponent(n + ".type"), atomically: true, encoding: .utf8)
            try? key.write(to: cacheDir.appendingPathComponent(n + ".key"), atomically: true, encoding: .utf8)
            var idx = self.buildIndex()
            let p = OfflineStore.pathPart(key)
            // 带 v= 的（kit/*.js?v=12 这种）：同一路径别的 v= 都是旧版本，删掉
            if key.contains("v=") {
                for other in idx[p] ?? [] where other != n {
                    if let ok = try? String(contentsOf: cacheDir.appendingPathComponent(other + ".key"), encoding: .utf8), ok.contains("v=") {
                        self.remove(other); idx[p]?.remove(other)
                    }
                }
            }
            idx[p, default: []].insert(n)
            self.index = idx
        }
    }

    /// 总大小超了就按最久没用的删（App 启动时在后台跑一次）。
    func trim() {
        io.async {
            let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
            let files = ((try? self.fm.contentsOfDirectory(at: self.cacheDir, includingPropertiesForKeys: keys)) ?? []).filter { $0.pathExtension == "bin" }
            var items = files.map { f -> (URL, Int64, Date) in
                let v = try? f.resourceValues(forKeys: Set(keys))
                return (f, Int64(v?.fileSize ?? 0), v?.contentModificationDate ?? .distantPast)
            }
            var total = items.reduce(0) { $0 + $1.1 }
            guard total > OfflineStore.maxBytes else { return }
            items.sort { $0.2 < $1.2 }
            for (f, size, _) in items where total > OfflineStore.trimTo {
                self.remove(f.deletingPathExtension().lastPathComponent)
                total -= size
            }
            self.index = nil
        }
    }

    /// 设置面板用：存了几道题（按存下的 questions/<题号>/q.json 数）、一共占多大。
    func stats(_ done: @escaping (Int, Int64) -> Void) {
        io.async {
            let files = (try? self.fm.contentsOfDirectory(at: self.cacheDir, includingPropertiesForKeys: [.fileSizeKey])) ?? []
            var bytes: Int64 = 0
            var questions = 0
            for f in files {
                if let sz = try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize { bytes += Int64(sz) }
                if f.pathExtension == "key", let k = try? String(contentsOf: f, encoding: .utf8),
                   k.hasPrefix("/questions/"), k.hasSuffix("/q.json") || k.contains("/q.json?") { questions += 1 }
            }
            self.main { done(questions, bytes) }
        }
    }

    /// 清掉 iPad 上存的页面和题（排队等补发的记录不动）。
    func clear(_ done: (() -> Void)? = nil) {
        io.async {
            for f in (try? self.fm.contentsOfDirectory(at: self.cacheDir, includingPropertiesForKeys: nil)) ?? [] { try? self.fm.removeItem(at: f) }
            self.index = [:]
            self.main { done?() }
        }
    }

    struct Item { let file: URL; let path: String; let body: Data; let reqId: String }

    func hasQueued() -> Bool { queuedCount > 0 }

    func enqueue(path: String, body: Data, reqId: String) {
        queuedCount += 1
        let stamp = String(format: "%013.0f", Date().timeIntervalSince1970 * 1000)
        let obj: [String: Any] = ["path": path, "body": body.base64EncodedString(), "req": reqId]
        io.async {
            guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
            let file = self.queueDir.appendingPathComponent("\(stamp)-\(UUID().uuidString.prefix(6)).json")
            try? data.write(to: file, options: .atomic)
        }
    }

    func queued(_ done: @escaping ([Item]) -> Void) {
        io.async {
            let files = ((try? self.fm.contentsOfDirectory(at: self.queueDir, includingPropertiesForKeys: nil)) ?? [])
                .filter { $0.pathExtension == "json" }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
            let items = files.compactMap { f -> Item? in
                guard let d = try? Data(contentsOf: f),
                      let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                      let p = o["path"] as? String,
                      let b = (o["body"] as? String).flatMap({ Data(base64Encoded: $0) }) else { return nil }
                return Item(file: f, path: p, body: b, reqId: o["req"] as? String ?? UUID().uuidString)
            }
            self.main { self.queuedCount = items.count; done(items) }
        }
    }

    func dequeue(_ file: URL) {
        queuedCount = max(0, queuedCount - 1)
        io.async { try? self.fm.removeItem(at: file) }
    }

    static func guessType(_ path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "", "html", "htm": return "text/html; charset=utf-8"
        case "js": return "application/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "svg": return "image/svg+xml"
        case "mp3": return "audio/mpeg"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "txt": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}
