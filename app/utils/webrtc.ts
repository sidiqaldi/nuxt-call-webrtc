export function createBlackVideoTrack(): MediaStreamTrack | undefined {

  const canvas = document.createElement("canvas")

  canvas.width = 640
  canvas.height = 480

  const ctx = canvas.getContext("2d")

  ctx?.fillRect(0, 0, canvas.width, canvas.height)

  const stream = canvas.captureStream()

  return stream.getVideoTracks()[0]
}