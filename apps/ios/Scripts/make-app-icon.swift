#!/usr/bin/env swift
// Draws the Psyche app icon: the flat ink moth (the same paths as `MothShape` in PsycheDesign, a 32 x 32 viewBox)
// on paper. No gradient, no glow. Writes the three iOS 26 variants as 1024 pt PNGs:
//   AppIcon.png (light), AppIcon-Dark.png, AppIcon-Tinted.png (grayscale; the system tints it).
//
// Run once on macOS after changing the moth or the palette, then commit the PNGs:
//   swift Scripts/make-app-icon.swift App/Assets.xcassets/AppIcon.appiconset
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Palette {
    var background: CGColor
    var upper: CGColor
    var lower: CGColor
    var body: CGColor
}

func rgb(_ hex: UInt32) -> CGColor {
    CGColor(
        srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
        blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
}

// Colors.xcassets: paper, inkText, inkSoft, text (light and dark).
let light = Palette(background: rgb(0xFAF9F8), upper: rgb(0x2C5AA0), lower: rgb(0x4D72AB), body: rgb(0x21201F))
let dark = Palette(background: rgb(0x111110), upper: rgb(0x9AB9E9), lower: rgb(0x6F93CC), body: rgb(0xEFEEEC))
// Tinted icons are grayscale on black; iOS maps the luminance to the user's tint.
let tinted = Palette(background: rgb(0x000000), upper: rgb(0xFFFFFF), lower: rgb(0xA6A6A6), body: rgb(0xD9D9D9))

let canvas = 1024
// The moth spans x 5...27 and y 7...26 of the 32-unit viewBox; this scale gives it about 64% of the icon's width.
let unit: CGFloat = 30
let center = CGPoint(x: 16, y: 16.5)

func mothPaths() -> (upper: CGPath, lower: CGPath, body: CGPath, antennae: CGPath) {
    let upper = CGMutablePath()
    upper.move(to: CGPoint(x: 16, y: 14))
    upper.addCurve(to: CGPoint(x: 6, y: 13), control1: CGPoint(x: 12, y: 7), control2: CGPoint(x: 5, y: 7.5))
    upper.addCurve(to: CGPoint(x: 16, y: 15.5), control1: CGPoint(x: 6.8, y: 17), control2: CGPoint(x: 12, y: 17.5))
    upper.closeSubpath()
    upper.move(to: CGPoint(x: 16, y: 14))
    upper.addCurve(to: CGPoint(x: 26, y: 13), control1: CGPoint(x: 20, y: 7), control2: CGPoint(x: 27, y: 7.5))
    upper.addCurve(to: CGPoint(x: 16, y: 15.5), control1: CGPoint(x: 25.2, y: 17), control2: CGPoint(x: 20, y: 17.5))
    upper.closeSubpath()

    let lower = CGMutablePath()
    lower.move(to: CGPoint(x: 16, y: 17))
    lower.addCurve(to: CGPoint(x: 10.5, y: 24), control1: CGPoint(x: 12.5, y: 18.5), control2: CGPoint(x: 9, y: 21.5))
    lower.addCurve(to: CGPoint(x: 16, y: 19), control1: CGPoint(x: 11.9, y: 26), control2: CGPoint(x: 15, y: 22))
    lower.closeSubpath()
    lower.move(to: CGPoint(x: 16, y: 17))
    lower.addCurve(to: CGPoint(x: 21.5, y: 24), control1: CGPoint(x: 19.5, y: 18.5), control2: CGPoint(x: 23, y: 21.5))
    lower.addCurve(to: CGPoint(x: 16, y: 19), control1: CGPoint(x: 20.1, y: 26), control2: CGPoint(x: 17, y: 22))
    lower.closeSubpath()

    let body = CGPath(
        roundedRect: CGRect(x: 15, y: 11, width: 2, height: 12), cornerWidth: 1, cornerHeight: 1, transform: nil)

    let antennae = CGMutablePath()
    antennae.move(to: CGPoint(x: 15.6, y: 11.5))
    antennae.addCurve(to: CGPoint(x: 11.5, y: 7.2), control1: CGPoint(x: 14.5, y: 8.5), control2: CGPoint(x: 13, y: 7.5))
    antennae.move(to: CGPoint(x: 16.4, y: 11.5))
    antennae.addCurve(to: CGPoint(x: 20.5, y: 7.2), control1: CGPoint(x: 17.5, y: 8.5), control2: CGPoint(x: 19, y: 7.5))
    return (upper, lower, body, antennae)
}

func render(_ palette: Palette, to url: URL) {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    // No alpha: App Store icons must be opaque.
    let ctx = CGContext(
        data: nil, width: canvas, height: canvas, bitsPerComponent: 8, bytesPerRow: 0, space: space,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.setFillColor(palette.background)
    ctx.fill(CGRect(x: 0, y: 0, width: canvas, height: canvas))

    // SVG space has y down; Core Graphics has y up. Flip once, then place the moth's center at the canvas center.
    ctx.translateBy(x: CGFloat(canvas) / 2, y: CGFloat(canvas) / 2)
    ctx.scaleBy(x: unit, y: -unit)
    ctx.translateBy(x: -center.x, y: -center.y)

    let moth = mothPaths()
    ctx.setFillColor(palette.lower)
    ctx.addPath(moth.lower)
    ctx.fillPath()
    ctx.setFillColor(palette.upper)
    ctx.addPath(moth.upper)
    ctx.fillPath()
    ctx.setFillColor(palette.body)
    ctx.addPath(moth.body)
    ctx.fillPath()
    ctx.setStrokeColor(palette.body)
    ctx.setLineWidth(1.1)
    ctx.setLineCap(.round)
    ctx.addPath(moth.antennae)
    ctx.strokePath()

    let image = ctx.makeImage()!
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("could not write \(url.path)") }
    print("wrote \(url.path)")
}

guard CommandLine.arguments.count == 2 else {
    print("usage: swift Scripts/make-app-icon.swift <AppIcon.appiconset directory>")
    exit(2)
}
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
render(light, to: directory.appendingPathComponent("AppIcon.png"))
render(dark, to: directory.appendingPathComponent("AppIcon-Dark.png"))
render(tinted, to: directory.appendingPathComponent("AppIcon-Tinted.png"))
