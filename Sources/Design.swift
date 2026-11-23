import UIKit

/// 原生界面的样子，全部照网页（board2/kit/shell.css 的 :root 是夜间、kit/theme.css 的 html[data-theme=day] 是白天）。
/// 颜色、三档时长、同一条缓动都和网页一一对应，原生部分和网页看起来是同一个产品。
enum Theme {
    private static func pair(_ night: UInt32, _ day: UInt32, _ a: CGFloat = 1) -> UIColor {
        return UIColor { $0.userInterfaceStyle == .light ? hex(day, a) : hex(night, a) }
    }
    static func hex(_ v: UInt32, _ a: CGFloat = 1) -> UIColor {
        return UIColor(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: a)
    }

    // --bg --surface --surface2 --ink --ink2 --muted --faint --line --line2 --acc --on-acc --no
    static let background = pair(0x151515, 0xf4f1ea)
    static let surface = pair(0x1d1d1c, 0xebe7de)
    static let surface2 = pair(0x272725, 0xe1dcd0)
    static let text = pair(0xf0efec, 0x1f1d1a)
    static let text2 = pair(0xd9d7d0, 0x3b3833)
    static let secondaryText = pair(0xa7a59b, 0x5c584f)
    static let faint = pair(0x7f7d75, 0x736e63)
    static let line = pair(0x34332f, 0xd6cfc2)
    static let line2 = pair(0x45433f, 0xc3bbac)
    static let accent = pair(0xe08a69, 0xb85a33)
    static let accentSoft = UIColor { $0.userInterfaceStyle == .light ? hex(0xb85a33, 0.12) : hex(0xe08a69, 0.14) }
    static let onAccent = pair(0x20140e, 0xfffaf6)
    static let danger = pair(0xe5766f, 0xbd3d35)
    /// 开关的滑块：昼夜都是浅色（开 = 橙色轨道 + 浅滑块靠右，关 = 灰轨道 + 浅滑块靠左）
    static let thumb = pair(0xf0efec, 0xfffaf6)
    static let dangerSoft = UIColor { $0.userInterfaceStyle == .light ? hex(0xbd3d35, 0.10) : hex(0xe5766f, 0.16) }
    /// 网页的 .scrim（浮层后面的压暗）
    static let scrim = UIColor { $0.userInterfaceStyle == .light ? UIColor(red: 40 / 255, green: 34 / 255, blue: 26 / 255, alpha: 0.28) : UIColor(white: 0, alpha: 0.5) }
    /// 网页 .fbp 的阴影色
    static let shadow = UIColor { $0.userInterfaceStyle == .light ? UIColor(red: 60 / 255, green: 48 / 255, blue: 30 / 255, alpha: 1) : UIColor.black }
    static func shadowOpacity(_ tc: UITraitCollection) -> Float { tc.userInterfaceStyle == .light ? 0.18 : 0.45 }

    // 兼容旧名字
    static var panel: UIColor { surface }

    /// 网页上次用的是哪一套：day / night（默认 night，和网页默认一致）。
    static var webTheme: String {
        get { ShotMode.theme ?? UserDefaults.standard.string(forKey: "webTheme") ?? "night" }
        set { UserDefaults.standard.set(newValue, forKey: "webTheme") }
    }
    static var style: UIUserInterfaceStyle { webTheme == "day" ? .light : .dark }

    // 字：和网页一样只用两种字重（常规、粗 = 网页的 700）；数字、地址用等宽（网页 --mono）
    static func font(_ size: CGFloat, bold: Bool = false) -> UIFont { .systemFont(ofSize: size, weight: bold ? .semibold : .regular) }
    static func mono(_ size: CGFloat, bold: Bool = false) -> UIFont { .monospacedSystemFont(ofSize: size, weight: bold ? .semibold : .regular) }
}

/// 动效：网页的三档 --t-fast 120ms / --t-mid 200ms / --t-big 300ms 和缓动 --ease: cubic-bezier(.3, .8, .3, 1)。
/// 系统开了"减弱动态效果"时位移归零（网页的 --m-* 归零），淡入淡出照旧。
enum Motion {
    static let fast: TimeInterval = 0.12
    static let mid: TimeInterval = 0.20
    static let big: TimeInterval = 0.30
    static var reduce: Bool { UIAccessibility.isReduceMotionEnabled }

    static func animate(_ duration: TimeInterval, delay: TimeInterval = 0, _ animations: @escaping () -> Void, completion: (() -> Void)? = nil) {
        let p = UICubicTimingParameters(controlPoint1: CGPoint(x: 0.3, y: 0.8), controlPoint2: CGPoint(x: 0.3, y: 1))
        let a = UIViewPropertyAnimator(duration: duration, timingParameters: p)
        a.addAnimations(animations)
        if let c = completion { a.addCompletion { _ in c() } }
        a.startAnimation(afterDelay: delay)
    }

    /// 位移：减弱动态效果时不动。
    static func offset(_ y: CGFloat) -> CGAffineTransform { reduce ? .identity : CGAffineTransform(translationX: 0, y: y) }
    static func scale(_ s: CGFloat) -> CGAffineTransform { reduce ? .identity : CGAffineTransform(scaleX: s, y: s) }
}

/// 轻微触感：只给开关、清除、笔和橡皮的切换。
enum Haptics {
    static func select() { UISelectionFeedbackGenerator().selectionChanged() }
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func done() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
}

// MARK: - 小部件

/// 折叠箭头：网页用的同一个 ›（M9 5l7 7-7 7，1.9 粗的圆头描边）。展开时转 90° 朝下。
final class ChevronView: UIView {
    private let shape = CAShapeLayer()
    var color: UIColor = Theme.faint { didSet { setNeedsLayout() } }
    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        shape.fillColor = UIColor.clear.cgColor
        shape.lineWidth = 1.9
        shape.lineCap = .round
        shape.lineJoin = .round
        layer.addSublayer(shape)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func layoutSubviews() {
        super.layoutSubviews()
        let s = min(bounds.width, bounds.height) / 24
        let p = UIBezierPath()
        p.move(to: CGPoint(x: 9, y: 5)); p.addLine(to: CGPoint(x: 16, y: 12)); p.addLine(to: CGPoint(x: 9, y: 19))
        p.apply(CGAffineTransform(scaleX: s, y: s))
        shape.frame = bounds
        shape.path = p.cgPath
        shape.strokeColor = color.resolvedColor(with: traitCollection).cgColor
    }
    override func traitCollectionDidChange(_ previous: UITraitCollection?) { super.traitCollectionDidChange(previous); setNeedsLayout() }
}

/// 按下时轻轻缩一下（网页 .ic:active 的 scale(.94)，快档）。
class PressButton: UIButton {
    override var isHighlighted: Bool {
        didSet {
            guard oldValue != isHighlighted else { return }
            Motion.animate(Motion.fast) { self.transform = self.isHighlighted ? Motion.scale(0.96) : .identity }
        }
    }
    /// 点击区域至少 44×44。
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let dx = max(0, (44 - bounds.width) / 2), dy = max(0, (44 - bounds.height) / 2)
        return bounds.insetBy(dx: -dx, dy: -dy).contains(point)
    }
}

/// 主按钮（实心强调色，网页 .toast / 选中态的配色）和次按钮（描边，网页 .gbtn）。
final class B2Button: PressButton {
    enum Kind { case primary, secondary }
    private let kind: Kind
    var sure = false { didSet { paint() } }   // 清除的"再点一次"确认态：网页 .dclr.sure 的红描边

    init(_ title: String, kind: Kind) {
        self.kind = kind
        super.init(frame: .zero)
        setTitle(title, for: .normal)
        titleLabel?.font = Theme.font(17, bold: kind == .primary)
        layer.cornerRadius = 12
        layer.cornerCurve = .continuous
        contentEdgeInsets = UIEdgeInsets(top: 0, left: 18, bottom: 0, right: 18)
        heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
        paint()
    }
    required init?(coder: NSCoder) { fatalError() }

    override var isEnabled: Bool { didSet { alpha = isEnabled ? 1 : 0.45 } }

    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        paint()
    }

    private func paint() {
        switch kind {
        case .primary:
            backgroundColor = Theme.accent
            setTitleColor(Theme.onAccent, for: .normal)
            layer.borderWidth = 0
        case .secondary:
            backgroundColor = sure ? Theme.dangerSoft : .clear
            setTitleColor(sure ? Theme.text : Theme.text2, for: .normal)
            layer.borderWidth = 1.5
            layer.borderColor = (sure ? Theme.danger : Theme.line2).resolvedColor(with: traitCollection).cgColor
            titleLabel?.font = Theme.font(17, bold: sure)
        }
    }
}

/// 图标按钮（网页 .ic：46×46 圆角 12，图标是 1.9 粗的描边）。
final class IconButton: PressButton {
    enum Glyph { case close }
    private let shape = CAShapeLayer()
    private let glyph: Glyph

    init(_ glyph: Glyph, label: String) {
        self.glyph = glyph
        super.init(frame: .zero)
        accessibilityLabel = label
        layer.cornerRadius = 12
        layer.cornerCurve = .continuous
        shape.fillColor = UIColor.clear.cgColor
        shape.lineWidth = 1.9
        shape.lineCap = .round
        shape.lineJoin = .round
        layer.addSublayer(shape)
        widthAnchor.constraint(equalToConstant: 46).isActive = true
        heightAnchor.constraint(equalToConstant: 46).isActive = true
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let s: CGFloat = 24, o = CGPoint(x: (bounds.width - s) / 2, y: (bounds.height - s) / 2)
        let p = UIBezierPath()
        switch glyph {
        case .close:   // M6 6l12 12M18 6L6 18
            p.move(to: CGPoint(x: 6, y: 6)); p.addLine(to: CGPoint(x: 18, y: 18))
            p.move(to: CGPoint(x: 18, y: 6)); p.addLine(to: CGPoint(x: 6, y: 18))
        }
        p.apply(CGAffineTransform(translationX: o.x, y: o.y))
        shape.frame = bounds
        shape.path = p.cgPath
        shape.strokeColor = (isHighlighted ? Theme.text : Theme.secondaryText).resolvedColor(with: traitCollection).cgColor
    }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? Theme.surface2 : .clear; setNeedsLayout() }
    }
    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        setNeedsLayout()
    }
}

/// 输入框（网页 .fbin textarea 的样子：底色 --bg、描边 --line2、圆角 12；地址用等宽）。
final class B2Field: UITextField {
    init() {
        super.init(frame: .zero)
        font = Theme.mono(17)
        textColor = Theme.text
        tintColor = Theme.accent
        backgroundColor = Theme.background
        layer.cornerRadius = 12
        layer.cornerCurve = .continuous
        layer.borderWidth = 1.5
        keyboardType = .URL
        autocapitalizationType = .none
        autocorrectionType = .no
        spellCheckingType = .no
        clearButtonMode = .whileEditing
        heightAnchor.constraint(equalToConstant: 48).isActive = true
        paint()
    }
    required init?(coder: NSCoder) { fatalError() }
    override func textRect(forBounds b: CGRect) -> CGRect { b.insetBy(dx: 14, dy: 0) }
    override func editingRect(forBounds b: CGRect) -> CGRect { b.insetBy(dx: 14, dy: 0) }
    override func becomeFirstResponder() -> Bool { let r = super.becomeFirstResponder(); paint(); return r }
    override func resignFirstResponder() -> Bool { let r = super.resignFirstResponder(); paint(); return r }
    override func traitCollectionDidChange(_ previous: UITraitCollection?) { super.traitCollectionDidChange(previous); paint() }
    private func paint() {
        layer.borderColor = (isFirstResponder ? Theme.accent : Theme.line2).resolvedColor(with: traitCollection).cgColor
    }
}

/// 小节标题（网页 h3 的样子：小一号、淡色）。
func sectionLabel(_ text: String) -> UILabel {
    let l = UILabel()
    l.text = text
    l.font = Theme.font(14, bold: true)
    l.textColor = Theme.secondaryText
    return l
}

func bodyLabel(_ text: String?, size: CGFloat = 17, color: UIColor = Theme.text) -> UILabel {
    let l = UILabel()
    l.text = text
    l.font = Theme.font(size)
    l.textColor = color
    l.numberOfLines = 0
    return l
}

func hairline() -> UIView {
    let v = UIView()
    v.backgroundColor = Theme.line
    v.heightAnchor.constraint(equalToConstant: 1).isActive = true
    return v
}
