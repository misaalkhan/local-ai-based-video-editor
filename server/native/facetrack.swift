// Finds faces in a video with Apple's Vision framework and prints one JSON
// line per sampled frame:
//
//   {"t":1.2,"faces":[[cx,cy,w,h,confidence], ...]}
//
// Coordinates are fractions of the frame with the origin at the top left.
// Usage: facetrack <video> [samples per second]

import AVFoundation
import Foundation
import Vision

let args = CommandLine.arguments
guard args.count >= 2 else {
  FileHandle.standardError.write("usage: facetrack <video> [samples per second]\n".data(using: .utf8)!)
  exit(2)
}
let rate = args.count > 2 ? (Double(args[2]) ?? 5) : 5
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

let interval = 1.0 / max(0.5, rate)
var next = 0.0
let out = FileHandle.standardOutput
while let sample = output.copyNextSampleBuffer() {
  let t = CMSampleBufferGetPresentationTimeStamp(sample).seconds
  if !t.isFinite || t + 1e-6 < next { continue }
  next = (floor(t / interval + 1e-6) + 1) * interval
  guard let pixels = CMSampleBufferGetImageBuffer(sample) else { continue }
  let request = VNDetectFaceRectanglesRequest()
  try? VNImageRequestHandler(cvPixelBuffer: pixels, orientation: .up, options: [:]).perform([request])
  let faces = (request.results ?? []).map { f -> String in
    let b = f.boundingBox
    return String(format: "[%.4f,%.4f,%.4f,%.4f,%.2f]", b.midX, 1 - b.midY, b.width, b.height, f.confidence)
  }
  out.write(String(format: "{\"t\":%.3f,\"faces\":[%@]}\n", t, faces.joined(separator: ",")).data(using: .utf8)!)
}
