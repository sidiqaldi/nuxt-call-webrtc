export function useScreenShare(
  peerConnection: RTCPeerConnection,
  localStream: MediaStream,
  localVideo: Ref<HTMLVideoElement | null>
) {
  const isScreenSharing = ref(false)
  let screenTrack: MediaStreamTrack | null = null
  let originalVideoTrack: MediaStreamTrack | null = null

  const startScreenShare = async () => {
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true
      })

      screenTrack = displayStream.getVideoTracks()[0] ?? null

      if (!screenTrack) return

      // Save the original video track
      originalVideoTrack = localStream.getVideoTracks()[0] ?? null

      const sender = peerConnection
        .getSenders()
        .find(s => s.track?.kind === "video")

      if (sender) {
        sender.replaceTrack(screenTrack)
      }

      // Update localStream
      if (originalVideoTrack) {
        localStream.removeTrack(originalVideoTrack)
      }
      localStream.addTrack(screenTrack)

      if (localVideo.value) {
        localVideo.value.srcObject = displayStream
      }

      screenTrack.addEventListener("ended", stopScreenShare)

      isScreenSharing.value = true
    } catch (error) {
      console.error("Error starting screen share:", error)
      // Reset state if failed
      isScreenSharing.value = false
    }
  }

  const stopScreenShare = () => {
    if (!screenTrack || !originalVideoTrack) return

    const sender = peerConnection
      .getSenders()
      .find(s => s.track?.kind === "video")

    if (sender) {
      sender.replaceTrack(originalVideoTrack)
    }

    localStream.removeTrack(screenTrack)
    localStream.addTrack(originalVideoTrack)

    if (localVideo.value) {
      localVideo.value.srcObject = localStream
    }

    screenTrack.stop()
    screenTrack = null
    originalVideoTrack = null

    isScreenSharing.value = false
  }

  const toggleScreenShare = () => {
    if (isScreenSharing.value) {
      stopScreenShare()
    } else {
      startScreenShare()
    }
  }

  return {
    isScreenSharing,
    toggleScreenShare,
  }
}