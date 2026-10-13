// Follows one thing through a video with Apple's Vision framework, starting
// from a box the user drew, and prints one JSON line per frame:
//
//   {"t":1.2,"box":[cx,cy,w,h,confidence]}
//
// Coordinates are fractions of the frame with the origin at the top left.
// Usage: objtrack <video> <start seconds> <cx> <cy> <w> <h> [max seconds]
// Tracking stops when the object has been lost for a while or at the time limit.

import AVFoundation
import Foundation
import Vision

let args = CommandLine.arguments
guard args.count >= 7 else {
  FileHandle.standardError.write("usage: objtrack <video> <start> <cx> <cy> <w> <h> [max seconds]\n".data(using: .utf8)!)
  exit(2)
}
let start = Double(args[2]) ?? 0
let cx = Double(args[3]) ?? 0.5
let cy = Double(args[4]) ?? 0.5
let w = Double(args[5]) ?? 0.2
let h = Double(args[6]) ?? 0.2
let limit = args.count > 7 ? (Double(args[7]) ?? 600) : 600
let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
guard let track = asset.tracks(withMediaType: .video).first else {
  FileHandle.standardError.write("no video track\n".data(using: .utf8)!)
  exit(3)
}
guard let reader = try? AVAssetReader(asset: asset) else { exit(4) }
reader.timeRange = CMTimeRange(start: CMTime(seconds: max(0, start), preferredTimescale: 600), duration: CMTime(seconds: limit, preferredTimescale: 600))
let output = AVAssetReaderTrackOutput(
  track: track,
  outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
)
output.alwaysCopiesSampleData = false
reader.add(output)
guard reader.startReading() else { exit(5) }

// Vision's boxes have their origin at the bottom left.
var observation = VNDetectedObjectObservation(boundingBox: CGRect(x: cx - w / 2, y: 1 - cy - h / 2, width: w, height: h))
let handler = VNSequenceRequestHandler()
let out = FileHandle.standardOutput
var lost = 0
var first = true
while let sample = output.copyNextSampleBuffer() {
  let t = CMSampleBufferGetPresentationTimeStamp(sample).seconds
  guard t.isFinite, let pixels = CMSampleBufferGetImageBuffer(sample) else { continue }
  if first {
    first = false
    out.write(String(format: "{\"t\":%.4f,\"box\":[%.4f,%.4f,%.4f,%.4f,1.0]}\n", t, cx, cy, w, h).data(using: .utf8)!)
    continue
  }
  let request = VNTrackObjectRequest(detectedObjectObservation: observation)
  request.trackingLevel = .accurate
  guard (try? handler.perform([request], on: pixels)) != nil, let result = request.results?.first as? VNDetectedObjectObservation else {
    lost += 1
    if lost > 15 { break }
    continue
  }
  observation = result
  let b = result.boundingBox
  let conf = Double(result.confidence)
  if conf < 0.3 {
    lost += 1
    if lost > 15 { break }
  } else {
    lost = 0
  }
  out.write(String(format: "{\"t\":%.4f,\"box\":[%.4f,%.4f,%.4f,%.4f,%.2f]}\n", t, b.midX, 1 - b.midY, b.width, b.height, conf).data(using: .utf8)!)
}
