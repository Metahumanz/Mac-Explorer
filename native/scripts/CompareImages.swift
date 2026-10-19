import AppKit

let arguments = CommandLine.arguments
if arguments.count != 4 { fatalError("Usage: CompareImages.swift <reference.png> <native.png> <output.png>") }
guard let reference = NSImage(contentsOfFile: arguments[1]), let native = NSImage(contentsOfFile: arguments[2]) else { fatalError("Cannot read comparison screenshots") }
let width = 1180, height = 780, gutter = 16, heading = 32
let total = NSSize(width: width * 2 + gutter, height: height + heading)
guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(total.width), pixelsHigh: Int(total.height), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0), let context = NSGraphicsContext(bitmapImageRep: bitmap) else { fatalError("Cannot create comparison image") }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
NSColor.white.setFill(); NSRect(origin: .zero, size: total).fill()
let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.black]
("Electron · reference" as NSString).draw(at: NSPoint(x: 16, y: height + 8), withAttributes: attributes)
("Swift + AppKit · native" as NSString).draw(at: NSPoint(x: width + gutter + 16, y: height + 8), withAttributes: attributes)
reference.draw(in: NSRect(x: 0, y: 0, width: width, height: height), from: .zero, operation: .sourceOver, fraction: 1)
native.draw(in: NSRect(x: width + gutter, y: 0, width: width, height: height), from: .zero, operation: .sourceOver, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
guard let data = bitmap.representation(using: .png, properties: [:]) else { fatalError("Cannot encode comparison") }
try data.write(to: URL(fileURLWithPath: arguments[3]))
