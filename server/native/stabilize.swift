// Measures how the camera moved between consecutive frames of a video with
// Apple's Vision framework (translational image registration) and prints one
// JSON line per frame:
//
//   {"width":640,"height":360}
//   {"t":0.033,"dx":1.5,"dy":-0.25}      (pixels the picture moved since the previous frame)
//
// Usage: stabilize <video>

import AVFoundation
import Foundation
import Vision

let args = CommandLine.arguments
guard args.count >= 2 else {
  FileHandle.standardError.write("usage: stabilize <video>\n".data(using: .utf8)!)
  exit(2)
}
let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
guard let track = asset.tracks(withMediaType: .video).first else {
  FileHandle.standardError.write("no video track\n".data(using: .utf8)!)
  exit(3)
}
guard let reader = try? AVAssetReader(asset: asset) else { exit(4) }
let output = AVAssetReaderTrackOutput(
  track: track,
  outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
)
output.alwaysCopiesSampleData = false
reader.add(output)
guard reader.startReading() else { exit(5) }

let out = FileHandle.standardOutput
var previous: CVPixelBuffer? = nil
var first = true
while let sample = output.copyNextSampleBuffer() {
  let t = CMSampleBufferGetPresentationTimeStamp(sample).seconds
  guard t.isFinite, let pixels = CMSampleBufferGetImageBuffer(sample) else { continue }
  if first {
    first = false
    out.write("{\"width\":\(CVPixelBufferGetWidth(pixels)),\"height\":\(CVPixelBufferGetHeight(pixels))}\n".data(using: .utf8)!)
  }
  var dx = 0.0
  var dy = 0.0
  if let prev = previous {
    // Where does this frame sit relative to the previous one?
    let request = VNTranslationalImageRegistrationRequest(targetedCVPixelBuffer: pixels)
    let handler = VNImageRequestHandler(cvPixelBuffer: prev, options: [:])
    if (try? handler.perform([request])) != nil, let result = request.results?.first {
      let m = result.alignmentTransform
      dx = Double(m.tx)
      // Vision's y axis points up; ours points down.
      dy = -Double(m.ty)
    }
  }
  previous = pixels
  out.write(String(format: "{\"t\":%.4f,\"dx\":%.3f,\"dy\":%.3f}\n", t, dx, dy).data(using: .utf8)!)
}
