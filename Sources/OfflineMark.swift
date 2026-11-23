import UIKit

/// 离线小标记：没连上电脑、正在用 iPad 上存的题时，画面区左上角先展开成一条说明（几秒后自己收起），
/// 收起后只剩一个小圆点；点圆点再展开说明。连上电脑就整个淡出。
/// 放在画面区（网页 .stagewrap）的左上角：那里没有按钮（右上角是问答气泡和草稿纸按钮，左栏 / 顶栏在画面区外面）。
final class OfflineMark: UIView {

    private let pill = UIView()
    private let dot = UIView()
    private let label = UILabel()
    private var expanded = false
    private var collapseWork: DispatchWorkItem?
    private var widthC: NSLayoutConstraint!
    private var leadC: NSLayoutConstraint!
    private var topC: NSLayoutConstraint!
    private(set) var isOn = false
    /// 截图用：一直展开 / 一直收起。
    var pinned: Bool? = nil

    private static let collapsed: CGFloat = 28

    override init(frame: CGRect) {
        super.init(frame: frame)
        isHidden = true
        alpha = 0
        accessibilityLabel = Copy.offMark
        isAccessibilityElement = true
        accessibilityTraits = .button

        pill.backgroundColor = Theme.surface
        pill.layer.cornerRadius = OfflineMark.collapsed / 2
        pill.layer.cornerCurve = .continuous
        pill.layer.borderWidth = 1
        pill.clipsToBounds = true
        pill.translatesAutoresizingMaskIntoConstraints = false
        pill.isUserInteractionEnabled = false
        addSubview(pill)

        dot.backgroundColor = Theme.accent
        dot.layer.cornerRadius = 4
        dot.translatesAutoresizingMaskIntoConstraints = false
        pill.addSubview(dot)

        label.text = OfflineProxy.Text.pill
        label.font = Theme.font(14)
        label.textColor = Theme.text2
        label.alpha = 0
        label.lineBreakMode = .byClipping
        label.translatesAutoresizingMaskIntoConstraints = false
        pill.addSubview(label)

        widthC = pill.widthAnchor.constraint(equalToConstant: OfflineMark.collapsed)
        NSLayoutConstraint.activate([
            pill.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            pill.centerYAnchor.constraint(equalTo: centerYAnchor),
            pill.heightAnchor.constraint(equalToConstant: OfflineMark.collapsed),
            widthC,
            dot.widthAnchor.constraint(equalToConstant: 8),
            dot.heightAnchor.constraint(equalToConstant: 8),
            dot.centerYAnchor.constraint(equalTo: pill.centerYAnchor),
            dot.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: 10),
            label.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 8),
            label.centerYAnchor.constraint(equalTo: pill.centerYAnchor)
        ])
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
        paint()
    }
    required init?(coder: NSCoder) { fatalError() }

    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        paint()
    }
    private func paint() {
        pill.layer.borderColor = Theme.line2.resolvedColor(with: traitCollection).cgColor
    }

    /// 放到哪：画面区左上角（屏幕坐标）。点击区域是 44 高，从胶囊左边起算。
    func place(in host: UIView, at p: CGPoint) {
        if superview !== host {
            translatesAutoresizingMaskIntoConstraints = false
            host.addSubview(self)
            leadC = leadingAnchor.constraint(equalTo: host.leadingAnchor)
            topC = topAnchor.constraint(equalTo: host.topAnchor)
            NSLayoutConstraint.activate([leadC, topC, heightAnchor.constraint(equalToConstant: 44)])
            widthAnchor.constraint(equalTo: pill.widthAnchor, constant: 16).isActive = true
        }
        leadC.constant = p.x + 4
        topC.constant = p.y + 4
    }

    private var fullWidth: CGFloat {
        return 10 + 8 + 8 + label.intrinsicContentSize.width + 14
    }

    func show() {
        guard !isOn else { return }
        isOn = true
        isHidden = false
        superview?.bringSubviewToFront(self)
        setExpanded(pinned ?? true, animated: false)
        transform = Motion.offset(-8)
        Motion.animate(Motion.big) {
            self.alpha = 1
            self.transform = .identity
        }
        if pinned == nil { scheduleCollapse(after: 3.2) }
    }

    func hide() {
        guard isOn else { return }
        isOn = false
        collapseWork?.cancel()
        Motion.animate(Motion.mid, {
            self.alpha = 0
            self.transform = Motion.offset(-6)
        }, completion: { if !self.isOn { self.isHidden = true; self.transform = .identity } })
    }

    @objc private func tapped() {
        guard pinned == nil else { return }
        setExpanded(!expanded, animated: true)
        if expanded { scheduleCollapse(after: 4) } else { collapseWork?.cancel() }
    }

    private func scheduleCollapse(after s: TimeInterval) {
        collapseWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.setExpanded(false, animated: true) }
        collapseWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + s, execute: w)
    }

    func setExpanded(_ on: Bool, animated: Bool) {
        expanded = on
        widthC.constant = on ? fullWidth : OfflineMark.collapsed
        let change = {
            self.label.alpha = on ? 1 : 0
            self.superview?.layoutIfNeeded()
        }
        if animated {
            // 收起时字先淡出再缩，展开时先撑开再出字：看起来是一条胶囊在伸缩
            if on { Motion.animate(Motion.big, { self.superview?.layoutIfNeeded() }); Motion.animate(Motion.mid, delay: Motion.fast, { self.label.alpha = 1 }) }
            else { Motion.animate(Motion.fast, { self.label.alpha = 0 }); Motion.animate(Motion.big, delay: Motion.fast * 0.5, { self.superview?.layoutIfNeeded() }) }
        } else {
            change()
        }
        accessibilityValue = on ? OfflineProxy.Text.pill : nil
    }
}
