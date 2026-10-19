import AppKit
import ExplorerCore

/// Vector artwork in top-left-origin coordinates; no SF Symbols or bitmap assets.
enum ExplorerIcons {
  static func image(_ name: String, size: CGFloat = 18, color: NSColor? = nil) -> NSImage {
    if let image = ExplorerSVG.image(name, size: size, color: color ?? ExplorerPalette.text) { return image }
    // The sidebar's "folder" is an outlined FolderOpen. Tabs/files use folder(size:).
    let dimension = max(1, size)
    let image = NSImage(size: NSSize(width: dimension, height: dimension), flipped: true) { rect in
      guard let context = NSGraphicsContext.current?.cgContext else { return false }
      context.saveGState()
      defer { context.restoreGState() }
      context.translateBy(x: rect.minX, y: rect.minY)
      context.scaleBy(x: rect.width / 24, y: rect.height / 24)
      context.setStrokeColor((color ?? ExplorerPalette.text).cgColor)
      context.setFillColor((color ?? ExplorerPalette.text).cgColor)
      context.setLineWidth(1.55 * 24 / 18)
      context.setLineCap(.round)
      context.setLineJoin(.round)
      let path = lineArtwork(name)
      context.addPath(path)
      context.strokePath()
      if name == "more" {
        for x: CGFloat in [5, 12, 19] {
          context.fillEllipse(in: CGRect(x: x - 1, y: 11, width: 2, height: 2))
        }
      }
      return true
    }
    image.isTemplate = false
    image.cacheMode = .never
    return image
  }

  /// Exact FolderGlyph geometry/gradient stops from src/App.tsx (48 × 44 viewBox).
  /// A drawing-handler representation rerenders at the destination backing scale.
  static func folder(size: CGFloat = 22) -> NSImage {
    let dimension = max(1, size)
    let image = NSImage(size: NSSize(width: dimension, height: dimension), flipped: true) { rect in
      guard let context = NSGraphicsContext.current?.cgContext else { return false }
      context.saveGState()
      defer { context.restoreGState() }
      let scale = min(rect.width / 48, rect.height / 44)
      context.translateBy(x: rect.midX - 24 * scale, y: rect.midY - 22 * scale)
      context.scaleBy(x: scale, y: scale)

      let back = CGMutablePath()
      back.move(to: CGPoint(x: 3, y: 8))
      arc(back, to: CGPoint(x: 6, y: 5), radius: 3)
      back.addLine(to: CGPoint(x: 15.3, y: 5))
      back.addCurve(to: CGPoint(x: 20.1, y: 7.1), control1: CGPoint(x: 17.4, y: 5), control2: CGPoint(x: 18.7, y: 5.6))
      back.addLine(to: CGPoint(x: 23, y: 10))
      back.addLine(to: CGPoint(x: 42.5, y: 10))
      arc(back, to: CGPoint(x: 45, y: 12.5), radius: 2.5)
      back.addLine(to: CGPoint(x: 45, y: 35))
      back.addLine(to: CGPoint(x: 3, y: 35))
      back.closeSubpath()
      gradient(context, path: back, colors: [0xffc928, 0xefa914], locations: [0, 1], from: CGPoint(x: 12, y: 5), to: CGPoint(x: 12, y: 18))

      let paper = CGMutablePath()
      paper.move(to: CGPoint(x: 6, y: 10.4))
      paper.addLine(to: CGPoint(x: 23, y: 10.4))
      paper.addLine(to: CGPoint(x: 23, y: 15.4))
      paper.addLine(to: CGPoint(x: 3.7, y: 15.4))
      paper.addLine(to: CGPoint(x: 3.7, y: 13.1))
      arc(paper, to: CGPoint(x: 6, y: 10.4), radius: 2.7)
      paper.closeSubpath()
      context.addPath(paper)
      context.setFillColor(rgb(0xfff8df).cgColor)
      context.fillPath()

      let front = CGMutablePath()
      front.move(to: CGPoint(x: 5.4, y: 12.7))
      front.addLine(to: CGPoint(x: 15.7, y: 12.7))
      front.addCurve(to: CGPoint(x: 22.7, y: 10), control1: CGPoint(x: 18.6, y: 12.7), control2: CGPoint(x: 19.8, y: 10))
      front.addLine(to: CGPoint(x: 42.6, y: 10))
      arc(front, to: CGPoint(x: 45, y: 12.4), radius: 2.4)
      front.addLine(to: CGPoint(x: 45, y: 35.6))
      arc(front, to: CGPoint(x: 42.6, y: 38), radius: 2.4)
      front.addLine(to: CGPoint(x: 5.4, y: 38))
      arc(front, to: CGPoint(x: 3, y: 35.6), radius: 2.4)
      front.addLine(to: CGPoint(x: 3, y: 15.1))
      arc(front, to: CGPoint(x: 5.4, y: 12.7), radius: 2.4)
      front.closeSubpath()
      gradient(context, path: front, colors: [0xffe79f, 0xffdf75, 0xffd039], locations: [0, 0.5, 1], from: CGPoint(x: 6, y: 12), to: CGPoint(x: 40, y: 39))
      context.addPath(front)
      context.setStrokeColor(rgb(0xd7a92c, alpha: 0.65).cgColor)
      context.setLineWidth(0.45)
      context.strokePath()

      let highlight = CGMutablePath()
      highlight.move(to: CGPoint(x: 5.6, y: 13.15))
      highlight.addLine(to: CGPoint(x: 15.7, y: 13.15))
      highlight.addCurve(to: CGPoint(x: 22.7, y: 10.45), control1: CGPoint(x: 18.6, y: 13.15), control2: CGPoint(x: 19.9, y: 10.45))
      highlight.addLine(to: CGPoint(x: 42.4, y: 10.45))
      context.addPath(highlight)
      context.setStrokeColor(rgb(0xfff3c3, alpha: 0.8).cgColor)
      context.setLineWidth(0.4)
      context.setLineCap(.round)
      context.strokePath()
      return true
    }
    image.isTemplate = false
    image.cacheMode = .never
    return image
  }

  private static func rgb(_ value: UInt32, alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: alpha)
  }

  // SVG circular A/a with large-arc=0, sweep=1. Increasing angles are clockwise
  // visually in our flipped drawing context, so CGPath's clockwise flag is false.
  private static func arc(_ path: CGMutablePath, to end: CGPoint, radius: CGFloat) {
    let start = path.currentPoint
    let dx = end.x - start.x
    let dy = end.y - start.y
    let factor = sqrt(max(0, radius * radius / (dx * dx + dy * dy) - 0.25))
    let center = CGPoint(x: (start.x + end.x) / 2 - dy * factor, y: (start.y + end.y) / 2 + dx * factor)
    let first = atan2(start.y - center.y, start.x - center.x)
    var last = atan2(end.y - center.y, end.x - center.x)
    if last < first { last += 2 * .pi }
    path.addArc(center: center, radius: radius, startAngle: first, endAngle: last, clockwise: false)
  }

  private static func gradient(_ context: CGContext, path: CGPath, colors: [UInt32], locations: [CGFloat], from start: CGPoint, to end: CGPoint) {
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    let gradient = CGGradient(colorsSpace: colorSpace, colors: colors.map { rgb($0).cgColor } as CFArray, locations: locations)!
    context.saveGState()
    context.addPath(path)
    context.clip()
    context.drawLinearGradient(gradient, start: start, end: end, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    context.restoreGState()
  }

  private static func lineArtwork(_ name: String) -> CGPath {
    let p = CGMutablePath()
    func line(_ points: [(CGFloat, CGFloat)]) {
      guard let first = points.first else { return }
      p.move(to: CGPoint(x: first.0, y: first.1))
      for point in points.dropFirst() { p.addLine(to: CGPoint(x: point.0, y: point.1)) }
    }
    func circle(_ x: CGFloat, _ y: CGFloat, _ radius: CGFloat) {
      p.addEllipse(in: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2))
    }
    func rect(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat, _ radius: CGFloat = 0) {
      p.addRoundedRect(in: CGRect(x: x, y: y, width: width, height: height), cornerWidth: radius, cornerHeight: radius)
    }
    func curve(_ start: (CGFloat, CGFloat), _ a: (CGFloat, CGFloat), _ b: (CGFloat, CGFloat), _ end: (CGFloat, CGFloat)) {
      p.move(to: CGPoint(x: start.0, y: start.1))
      p.addCurve(to: CGPoint(x: end.0, y: end.1), control1: CGPoint(x: a.0, y: a.1), control2: CGPoint(x: b.0, y: b.1))
    }
    switch name {
    case "arrowLeft":
      line([(12, 19), (5, 12), (12, 5)]); line([(5, 12), (19, 12)])
    case "arrowRight":
      line([(12, 5), (19, 12), (12, 19)]); line([(5, 12), (19, 12)])
    case "arrowUp":
      line([(5, 12), (12, 5), (19, 12)]); line([(12, 5), (12, 19)])
    case "refresh":
      curve((20, 10), (18.5, 3), (8, 1), (4, 9))
      curve((4, 14), (5.5, 21), (16, 23), (20, 15))
      line([(20, 4), (20, 10), (14, 10)]); line([(4, 20), (4, 14), (10, 14)])
    case "plus":
      line([(12, 5), (12, 19)]); line([(5, 12), (19, 12)])
    case "scissors":
      circle(6, 6, 3); circle(6, 18, 3)
      line([(8.12, 8.12), (20, 20)]); line([(14, 10), (20, 4)]); line([(8.12, 15.88), (12, 12)])
    case "copy":
      rect(9, 9, 13, 13, 2)
      line([(5, 15), (4, 15)])
      curve((4, 15), (2.9, 15), (2, 14.1), (2, 13))
      line([(2, 13), (2, 4)])
      curve((2, 4), (2, 2.9), (2.9, 2), (4, 2))
      line([(4, 2), (13, 2)])
      curve((13, 2), (14.1, 2), (15, 2.9), (15, 4))
      line([(15, 4), (15, 5)])
    case "paste":
      rect(8, 2, 8, 4, 1)
      line([(8, 4), (5, 4), (5, 21), (19, 21), (19, 4), (16, 4)])
    case "rename":
      line([(10, 3), (14, 3)]); line([(12, 3), (12, 21)]); line([(10, 21), (14, 21)])
      line([(8, 7), (3, 7), (3, 17), (8, 17)]); line([(16, 7), (21, 7), (21, 17), (16, 17)])
    case "share":
      line([(12, 16), (12, 3)]); line([(7, 8), (12, 3), (17, 8)])
      line([(4, 12), (4, 21), (20, 21), (20, 12)])
    case "trash":
      line([(3, 6), (21, 6)]); line([(9, 6), (9, 3), (15, 3), (15, 6)])
      line([(5, 6), (6, 21), (18, 21), (19, 6)])
      line([(10, 10), (10, 17)]); line([(14, 10), (14, 17)])
    case "sort":
      line([(7, 4), (7, 20)]); line([(3, 16), (7, 20), (11, 16)])
      line([(13, 5), (21, 5)]); line([(13, 10), (19, 10)]); line([(13, 15), (17, 15)])
    case "list":
      for y: CGFloat in [5, 12, 19] { line([(8, y), (21, y)]); line([(3, y), (3.1, y)]) }
    case "grid":
      for x: CGFloat in [3, 14] { for y: CGFloat in [3, 14] { rect(x, y, 7, 7, 1) } }
    case "chevronDown": line([(6, 9), (12, 15), (18, 9)])
    case "chevronRight": line([(9, 6), (15, 12), (9, 18)])
    case "more": break
    case "panelRight": rect(3, 3, 18, 18, 2); line([(15, 3), (15, 21)])
    case "panelLeft": rect(3, 3, 18, 18, 2); line([(9, 3), (9, 21)])
    case "search": circle(10.5, 10.5, 7.5); line([(16, 16), (21, 21)])
    case "close": line([(6, 6), (18, 18)]); line([(6, 18), (18, 6)])
    case "pin":
      line([(9, 3), (15, 3), (15, 9), (18, 12), (18, 14), (6, 14), (6, 12), (9, 9), (9, 3)])
      line([(12, 14), (12, 21)])
    case "computer", "desktop":
      rect(2, 3, 20, 14, 2); line([(12, 17), (12, 21)]); line([(8, 21), (16, 21)])
    case "drive":
      rect(2, 12, 20, 8, 2); line([(2, 14), (5.5, 4), (18.5, 4), (22, 14)])
      line([(6, 16), (6.1, 16)]); line([(10, 16), (10.1, 16)])
    case "network":
      circle(12, 12, 10); line([(2, 12), (22, 12)])
      curve((12, 2), (6.7, 7.5), (6.7, 16.5), (12, 22))
      curve((12, 2), (17.3, 7.5), (17.3, 16.5), (12, 22))
    case "airdrop":
      circle(12, 12, 2); line([(13.4, 10.6), (22, 2)])
      curve((16.24, 7.76), (13.9, 5.41), (10.1, 5.41), (7.76, 7.76))
      curve((7.76, 7.76), (5.41, 10.1), (5.41, 13.9), (7.76, 16.24))
      curve((7.76, 16.24), (11.8, 20.3), (18.8, 16.7), (17.66, 10))
      curve((19.07, 4.93), (15.17, 1.02), (8.83, 1.02), (4.93, 4.93))
      curve((4.93, 4.93), (1.02, 8.83), (1.02, 15.17), (4.93, 19.07))
      curve((4.93, 19.07), (12, 26.1), (24.2, 19.4), (21.8, 10))
    case "folder":
      line([(3, 20), (3, 5), (9, 5), (11, 8), (20, 8), (20, 11)])
      line([(3, 20), (7, 11), (23, 11), (19, 20), (3, 20)])
    case "applications":
      line([(9, 3), (19, 20)]); line([(15, 3), (5, 20)])
      line([(3, 15), (14, 15)]); line([(18, 15), (21, 15)])
    case "download":
      line([(12, 3), (12, 15)]); line([(7, 10), (12, 15), (17, 10)])
      line([(3, 15), (3, 21), (21, 21), (21, 15)])
    case "document":
      line([(14, 2), (6, 2), (4, 4), (4, 20), (6, 22), (18, 22), (20, 20), (20, 8), (14, 2), (14, 8), (20, 8)])
      line([(8, 13), (16, 13)]); line([(8, 17), (14, 17)])
    case "image":
      rect(3, 3, 18, 18, 2); circle(8.5, 8.5, 1.5)
      line([(21, 15), (16, 10), (5, 21)])
    case "music":
      line([(9, 18), (9, 5), (21, 3), (21, 16)])
      p.addEllipse(in: CGRect(x: 3, y: 15, width: 6, height: 6))
      p.addEllipse(in: CGRect(x: 15, y: 13, width: 6, height: 6))
    case "video":
      rect(2, 3, 20, 18, 2); line([(7, 3), (7, 21)]); line([(17, 3), (17, 21)])
      for y: CGFloat in [7, 12, 17] { line([(2, y), (7, y)]); line([(17, y), (22, y)]) }
      line([(7, 12), (17, 12)])
    case "terminal":
      line([(4, 5), (10, 11), (4, 17)]); line([(12, 19), (20, 19)])
    case "undo":
      line([(3, 4), (3, 10), (9, 10)])
      curve((3, 10), (9, 0), (22, 6), (21, 14))
      curve((21, 14), (20, 21), (12, 23), (7, 19))
    case "settings":
      let teeth: [CGFloat] = [9, 9, 7, 7]
      for i in 0..<32 {
        let angle = CGFloat(i) * .pi / 16 - .pi / 2
        let radius = teeth[i % teeth.count]
        let point = CGPoint(x: 12 + cos(angle) * radius, y: 12 + sin(angle) * radius)
        if i == 0 { p.move(to: point) } else { p.addLine(to: point) }
      }
      p.closeSubpath(); circle(12, 12, 3)
    case "check": line([(4, 12), (9, 17), (20, 6)])
    case "eye":
      curve((2, 12), (7, 1.5), (17, 1.5), (22, 12))
      curve((22, 12), (17, 22.5), (7, 22.5), (2, 12))
      circle(12, 12, 3)
    default:
      rect(5, 3, 14, 18, 2)
    }
    return p
  }
}
