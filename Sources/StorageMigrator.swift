import UIKit
import WebKit

/// 1.2 起页面地址从 http://电脑:8409/ 换成 b2://board2/。网页存在本机的东西（localStorage：答题记录、
/// 草稿暂存、昼夜设置……）是按地址分开放的，换了地址就看不到了。这里在第一次启动新版时把旧地址下的
/// localStorage 读出来存成文件，新页面打开时注入进去（只补新地址上没有的键），注入成功后删掉文件。
final class StorageMigrator: NSObject, WKNavigationDelegate {

    private static let doneKey = "lsMigrated"
    private static var file: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("ls-migrate.json")
    }

    private static let triesKey = "lsMigrateTries"
    /// 迁过了（真读到了旧地址的数据，哪怕是空的），或者已经试了 3 次都没读到（不再拖慢启动）。
    static var done: Bool {
        UserDefaults.standard.bool(forKey: doneKey) || UserDefaults.standard.integer(forKey: triesKey) >= 3
    }

    private let origin: URL
    private weak var host: UIView?
    private var web: WKWebView?
    private var completion: (() -> Void)?
    private var finished = false

    init(origin: URL, host: UIView) {
        var c = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        c.path = "/"; c.query = nil
        self.origin = c.url ?? origin
        self.host = host
    }

    func run(_ completion: @escaping () -> Void) {
        self.completion = completion
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        let w = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: cfg)
        w.alpha = 0.01
        w.isUserInteractionEnabled = false
        w.navigationDelegate = self
        host?.addSubview(w)
        web = w
        // 只要一个"属于旧地址"的空页面就能读到它的 localStorage，不用连电脑。
        w.loadHTMLString("<!doctype html><html><body></body></html>", baseURL: origin)
        UserDefaults.standard.set(UserDefaults.standard.integer(forKey: StorageMigrator.triesKey) + 1, forKey: StorageMigrator.triesKey)
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.end(nil) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let js = "(function(){var o={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);o[k]=localStorage.getItem(k);}return JSON.stringify(o);})()"
        webView.evaluateJavaScript(js) { [weak self] result, _ in self?.end(result as? String) }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { end(nil) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { end(nil) }

    private func end(_ json: String?) {
        guard !finished else { return }
        finished = true
        if let json = json, json != "{}", let data = json.data(using: .utf8) {
            try? data.write(to: StorageMigrator.file, options: .atomic)
        }
        // 只有真读到结果（哪怕是 {}）才算迁完；超时、页面没开起来：下次启动再试（最多 3 次）
        if json != nil { UserDefaults.standard.set(true, forKey: StorageMigrator.doneKey) }
        web?.removeFromSuperview()
        web = nil
        completion?()
        completion = nil
    }

    /// 有待注入的旧数据时返回一段在页面最开头跑的脚本：只补新地址上还没有的键，然后告诉 App 注入好了。
    static func injectionScript() -> String? {
        guard let data = try? Data(contentsOf: file), let json = String(data: data, encoding: .utf8) else { return nil }
        return """
        (function () {
          try {
            if (!localStorage.getItem('__b2mig')) {
              var d = \(json);
              for (var k in d) { if (localStorage.getItem(k) === null) localStorage.setItem(k, d[k]); }
              localStorage.setItem('__b2mig', String(Date.now()));
            }
            window.webkit.messageHandlers.b2shell.postMessage({ k: 'migrated' });
          } catch (e) {}
        })();
        """
    }

    /// 页面说注入好了：删掉文件，下次启动不再注入。
    static func finish() {
        try? FileManager.default.removeItem(at: file)
    }
}
