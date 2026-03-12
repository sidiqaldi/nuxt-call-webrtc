import { createBlackVideoTrack } from '@/utils/webrtc'

export function useMediaControls(
  localStream: MediaStream,
  peerConnection: RTCPeerConnection,
  localVideo: Ref<HTMLVideoElement | null>
) {

  const toggleMic = (isMicMuted: Ref<boolean>) => {

    const audioTrack = localStream.getAudioTracks()[0]

    if (!audioTrack) return

    audioTrack.enabled = !audioTrack.enabled

    isMicMuted.value = !audioTrack.enabled

  }

  const toggleCamera = async (
    isCameraOff: Ref<boolean>
  ) => {

    const sender = peerConnection
      .getSenders()
      .find(s => s.track?.kind === "video")

    if (!sender) return

    if (!isCameraOff.value) {

      const blackTrack = createBlackVideoTrack() ?? null

      sender.replaceTrack(blackTrack)

      const oldTrack = localStream.getVideoTracks()[0]

      oldTrack?.stop()

      isCameraOff.value = true

    } else {

      const stream = await navigator.mediaDevices.getUserMedia({
        video: true
      })

      const newTrack = stream.getVideoTracks()[0] ?? null

      sender.replaceTrack(newTrack)

      const oldTrack = localStream.getVideoTracks()[0]

      if (oldTrack) {
        localStream.removeTrack(oldTrack)
      }

      if (newTrack) {
        localStream.addTrack(newTrack)
      }

      if (localVideo.value) {
        localVideo.value.srcObject = localStream
      }

      isCameraOff.value = false

    }

  }

  return {
    toggleMic,
    toggleCamera
  }

}