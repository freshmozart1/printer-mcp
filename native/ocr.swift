// Best-effort OCR for scanned documents.
//
// Renders each PDF page with PDFKit (or loads an image directly) and runs Apple's
// Vision text recogniser over it, emitting JSON on stdout.
//
// Uses the modern `RecognizeTextRequest` rather than the deprecated
// `VNRecognizeTextRequest`: measured on an identical page, the legacy API returned a
// single garbled line where this one returned the full text. Vision also downsamples
// very large inputs internally, which destroys small text, so pages are rendered at a
// moderate DPI instead of the scanner's native resolution.
//
// Usage: ocr <file.pdf|file.jpg> [--dpi 200] [--languages de-DE,en-US]

import Foundation
import PDFKit
import Vision
import CoreGraphics
import ImageIO

struct PageResult: Encodable {
    let page: Int
    let text: String
}

struct Output: Encodable {
    let pages: [PageResult]
    let text: String
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

/// Rasterise one PDF page at the requested DPI.
func render(page: PDFPage, dpi: CGFloat) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    let scale = dpi / 72.0
    let width = Int(bounds.width * scale)
    let height = Int(bounds.height * scale)
    guard width > 0, height > 0,
          let ctx = CGContext(data: nil, width: width, height: height,
                              bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { return nil }

    // Scanned pages may carry a rotation; PDFKit applies it via `draw(with:to:)`.
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    ctx.scaleBy(x: scale, y: scale)
    ctx.translateBy(x: -bounds.origin.x, y: -bounds.origin.y)
    page.draw(with: .mediaBox, to: ctx)
    return ctx.makeImage()
}

func images(from path: String, dpi: CGFloat) -> [CGImage] {
    let url = URL(fileURLWithPath: path)
    if path.lowercased().hasSuffix(".pdf") {
        guard let doc = PDFDocument(url: url) else { fail("cannot open PDF: \(path)") }
        return (0..<doc.pageCount).compactMap { doc.page(at: $0).flatMap { render(page: $0, dpi: dpi) } }
    }
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
    else { fail("cannot open image: \(path)") }
    return [img]
}

@main
struct OCRTool {
    static func main() async {
        var args = Array(CommandLine.arguments.dropFirst())
        guard let path = args.first, !path.hasPrefix("--") else {
            fail("usage: ocr <file.pdf|file.jpg> [--dpi N] [--languages a,b]")
        }
        args = Array(args.dropFirst())

        var dpi: CGFloat = 200
        var languages = ["de-DE", "en-US"]
        var i = 0
        while i < args.count {
            switch args[i] {
            case "--dpi":
                if i + 1 < args.count, let v = Double(args[i + 1]) { dpi = CGFloat(v) }
                i += 2
            case "--languages":
                if i + 1 < args.count {
                    languages = args[i + 1].split(separator: ",").map(String.init)
                }
                i += 2
            default:
                i += 1
            }
        }

        var request = RecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.recognitionLanguages = languages.map { Locale.Language(identifier: $0) }

        var pages: [PageResult] = []
        for (index, image) in images(from: path, dpi: dpi).enumerated() {
            var text = ""
            do {
                let observations = try await request.perform(on: image)
                text = observations
                    .compactMap { $0.topCandidates(1).first?.string }
                    .joined(separator: "\n")
            } catch {
                // A page that fails to recognise must not sink the whole document.
                FileHandle.standardError.write(
                    "page \(index + 1): \(error)\n".data(using: .utf8)!)
            }
            pages.append(PageResult(page: index + 1, text: text))
        }

        let combined = pages
            .map { "--- page \($0.page) ---\n\($0.text)" }
            .joined(separator: "\n\n")
        let data = try! JSONEncoder().encode(Output(pages: pages, text: combined))
        FileHandle.standardOutput.write(data)
    }
}
