<script setup lang="ts">
import { useMediaControls } from '@/composables/useMediaControls'
import { useScreenShare } from '@/composables/useScreenShare'
import { useCallSignaling } from '@/composables/useCallSignaling'
import {
  updateDoc,
  getDoc,
  doc
} from 'firebase/firestore'
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'

const localVideo = ref<HTMLVideoElement | null>(null)
const remoteVideo = ref<HTMLVideoElement | null>(null)
const callId = ref("")
const route = useRoute()
const isMicMuted = ref(false)
const isCameraOff = ref(false)
const role = ref<"host" | "guest" | null>(null)
const peerStatus = ref({
  micMuted: false,
  cameraOff: false
})

// Track call state
const inCall = ref(false)
const callEnded = ref(false)
const router = useRouter()
const configuration: RTCConfiguration = rtcConfig

let localStream: MediaStream
let peerConnection: RTCPeerConnection | null = null
let mediaControls: ReturnType<typeof useMediaControls> | null = null

const screenShare = ref<ReturnType<typeof useScreenShare> | null>(null)
const signaling = ref<ReturnType<typeof useCallSignaling> | null>(null)

const isScreenSharing = computed(() => {
  return screenShare.value?.isScreenSharing ?? false
})

const displayLayout = computed(() => {
  if (isScreenSharing.value) {
    return 'screen-share'
  }
  return 'normal'
})

const isClient = import.meta.client

if (isClient && route.query.call) {
  callId.value = route.query.call as string
}

const initializePeerConnection = async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    })

    if (localVideo.value) {
      localVideo.value.srcObject = localStream
    }

    peerConnection = new RTCPeerConnection(configuration)
    setupAutoReconnect()

    signaling.value = useCallSignaling(
      peerConnection,
      router,
      callId,
      peerStatus,
      role
    )

    mediaControls = useMediaControls(
      localStream,
      peerConnection,
      localVideo
    )

    screenShare.value = useScreenShare(
      peerConnection,
      localStream,
      localVideo
    )

    localStream.getTracks().forEach(track => {
      if (!peerConnection) return
      console.log("[Page] Adding local track to peer connection:", track.kind)
      peerConnection.addTrack(track, localStream)
    })

    peerConnection.ontrack = (event) => {
      console.log("[Page] Received remote track:", event.track.kind)
      console.log("[Page] Remote streams count:", event.streams.length)
      console.log("[Page] remoteVideo element exists:", !!remoteVideo.value)
      const [remoteStream] = event.streams
      console.log("[Page] Got remoteStream:", !!remoteStream)
      if (remoteStream) {
        console.log("[Page] Remote stream video tracks:", remoteStream.getVideoTracks().length)
        console.log("[Page] Remote stream audio tracks:", remoteStream.getAudioTracks().length)
      }
      if (remoteVideo.value && remoteStream) {
        console.log("[Page] Setting remote video srcObject")
        remoteVideo.value.srcObject = remoteStream
      } else {
        console.warn("[Page] Cannot set video - remoteVideo.value:", !!remoteVideo.value, "remoteStream:", !!remoteStream)
      }
    }

    peerConnection.addEventListener("connectionstatechange", () => {
      const state = peerConnection?.connectionState
      console.log("Peer state:", state)
      if (state === "closed" || state === "failed") {
        console.log("Connection " + state + ", clearing remote video")
        if (remoteVideo.value) {
          remoteVideo.value.srcObject = null
        }
      }
    })

  } catch (err) {
    console.error('Failed to initialize peer connection', err)
    throw err
  }
}

const createCall = async () => {
  try {
    await initializePeerConnection()
    await signaling.value?.createCall()
    inCall.value = true
  } catch (err) {
    console.error('create call failed', err)
  }
}

const joinCall = async () => {
  if (!callId.value) {
    alert('Please enter a call ID before joining')
    return
  }

  try {
    // Check if room exists before attempting to join
    const roomDoc = await getDoc(doc(db, "calls", callId.value))
    if (!roomDoc.exists()) {
      callEnded.value = true
      alert('Room does not exist')
      return
    }

    await initializePeerConnection()
    role.value = "guest"

    await signaling.value?.joinCall()
    inCall.value = true

    const callDoc = signaling.value?.getCallDoc()
    if (callDoc) {
      await updateDoc(callDoc, { guestLeft: false })
    }

    if (isClient && !route.query.call) {
      await router.replace({ query: { call: callId.value } })
    }
  } catch (err) {
    console.error('failed to join call', err)
    callEnded.value = true
    alert('Unable to join call, check console for details')
  }
}

const hangUp = async () => {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop())
  }

  peerConnection?.close()

  try {
    await signaling.value?.hangUp()
  } catch (e) {
    console.warn('hangUp failed', e)
  }

  inCall.value = false
  callId.value = ""
  role.value = null
  peerStatus.value = { micMuted: false, cameraOff: false }

  peerConnection = null
  mediaControls = null
}

const toggleMic = async () => {
  if (!mediaControls) return

  mediaControls.toggleMic(isMicMuted)

  await updateMediaStatus()
}

watch(
  () => signaling.value?.peerLeft,
  (peerLeft) => {
    if (peerLeft) {
      console.log("Remote peer disconnected, clearing video")

      if (remoteVideo.value) {
        remoteVideo.value.srcObject = null
      }
      if (remoteVideo.value?.srcObject instanceof MediaStream) {
        remoteVideo.value.srcObject.getTracks().forEach(track => track.stop())
      }
      callEnded.value = true
      inCall.value = false
    }
  }
)

const toggleCamera = async () => {
  if (!mediaControls) return

  await mediaControls.toggleCamera(isCameraOff)

  await updateMediaStatus()
}

const updateMediaStatus = async () => {
  const callDoc = signaling.value?.getCallDoc()

  if (!callDoc || !role.value) return

  const status = {
    micMuted: isMicMuted.value,
    cameraOff: isCameraOff.value
  }

  if (role.value === "host") {
    await updateDoc(callDoc, { hostStatus: status })
  }

  if (role.value === "guest") {
    await updateDoc(callDoc, { guestStatus: status })
  }
}

const toggleScreenShare = () => {
  if (!screenShare.value) return
  screenShare.value.toggleScreenShare()
}

const setupAutoReconnect = () => {
  if (!peerConnection) return

  peerConnection.addEventListener("iceconnectionstatechange", async () => {
    const state = peerConnection?.iceConnectionState
    console.log("ICE state:", state)

    if (state === "failed" || state === "disconnected") {
      console.warn("ICE reconnect triggered")
      try {
        const offer = await peerConnection!.createOffer({
          iceRestart: true
        })

        await peerConnection!.setLocalDescription(offer)
        const callDoc = signaling.value?.getCallDoc()

        if (!callDoc) return

        await updateDoc(callDoc, {
          offer: {
            type: offer.type,
            sdp: offer.sdp
          }
        })
      } catch (err) {
        console.error("ICE restart failed", err)
      }
    }
  })
}

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", cleanupCall)
  if (peerConnection) {
    peerConnection.close()
  }
})

onMounted(async () => {
  try {
    await initializePeerConnection()
  } catch (err) {
    console.error('Failed to initialize on mount', err)
  }
})

const callLink = computed(() => {
  if (!callId.value) return ""
  if (isClient) return `${window.location.origin}?call=${callId.value}`
  return ""
})

const cleanupCall = async () => {
  try {
    await signaling.value?.hangUp()
  } catch (e) {
    console.warn('cleanup failed', e)
  } finally {
    inCall.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex flex-col items-center justify-center gap-6 bg-gray-100">
    <h1 class="text-3xl font-bold">Nuxt WebRTC</h1>

    <!-- Call Ended Message -->
    <div v-if="callEnded" class="w-full max-w-md bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative">
      <strong class="font-bold">Call Ended</strong>
      <span class="block sm:inline">Host has ended the call or room no longer exists</span>
      <button @click="() => { callEnded = false; callId = ''; inCall = false }" class="mt-2 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700">
        Start New Call
      </button>
    </div>

    <div v-if="inCall && callId" class="flex flex-col gap-2 items-center">
      <input :value="callLink" readonly class="border px-3 py-2 rounded w-80" />
      <p class="text-sm text-gray-700">You are the <strong>{{ role === 'host' ? 'Host' : 'Guest' }}</strong> in this call.</p>
    </div>

    <div v-if="!inCall" class="flex flex-col gap-1">
      <div class="flex gap-3">
        <input v-model="callId" placeholder="Enter Call ID" class="border px-3 py-2 rounded" />
        <button @click="joinCall"
          class="px-6 py-2 bg-green-600 text-white rounded">
          Join Call
        </button>
      </div>
      <ClientOnly>
        <p v-if="route.query.call" class="text-sm text-gray-600">
          Call ID loaded from URL; click "Join Call" when you're ready.
        </p>
      </ClientOnly>
    </div>

    <!-- Video Container - Always visible for camera setup -->
    <div>
      <!-- Normal view: side-by-side videos -->
      <div v-if="displayLayout === 'normal'" class="flex gap-6">
        <div class="flex flex-col items-center">
          <p class="font-semibold mb-2">Local</p>
          <div class="w-80 h-60 bg-black rounded border shadow overflow-hidden">
            <video ref="localVideo" autoplay playsinline muted class="w-full h-full object-cover"></video>
          </div>
        </div>

        <div class="flex flex-col items-center">
          <p class="font-semibold mb-2">Remote</p>
          <div class="relative w-80 h-60 bg-black rounded border shadow overflow-hidden">
            <video ref="remoteVideo" autoplay playsinline class="w-full h-full object-cover"></video>
            <div v-if="!inCall" class="absolute inset-0 flex items-center justify-center bg-gray-800 text-gray-400 text-sm">
              Waiting for remote video...
            </div>
            <div v-if="inCall && peerStatus.cameraOff"
              class="absolute inset-0 flex items-center justify-center bg-black text-white">
              Camera Off
            </div>
          </div>
          <div v-if="inCall && peerStatus.micMuted" class="text-red-500 mt-2">
            Peer muted mic
          </div>
        </div>
      </div>

      <!-- Screen share view: large shared screen with small local video overlay -->
      <div v-if="displayLayout === 'screen-share'" class="flex flex-col items-center gap-4">
        <div class="w-full max-w-6xl">
          <div class="relative w-full bg-black rounded border shadow overflow-hidden" style="aspect-ratio: 16 / 9">
            <!-- Shared screen (large) -->
            <video ref="remoteVideo" autoplay playsinline class="w-full h-full object-contain"></video>
            <div v-if="peerStatus.cameraOff"
              class="absolute inset-0 flex items-center justify-center bg-black text-white">
              Screen Share Active
            </div>

            <!-- Local video overlay (small, bottom-right corner) -->
            <div class="absolute bottom-4 right-4 w-48 h-36 bg-black rounded border-2 border-white shadow-lg overflow-hidden">
              <video ref="localVideo" autoplay playsinline muted class="w-full h-full object-cover"></video>
              <p class="absolute bottom-1 left-1 text-white text-xs bg-black bg-opacity-50 px-2 py-1 rounded">You</p>
            </div>
          </div>
        </div>
        <div v-if="peerStatus.micMuted" class="text-red-500">
          Peer muted mic
        </div>
      </div>
    </div>

    <!-- Camera setup controls (before joining) -->
    <div v-if="!inCall" class="flex gap-3">
      <div class="flex flex-col gap-2 ">
        <button @click="toggleCamera" class="px-4 py-2 rounded text-white"
          :class="isCameraOff ? 'bg-red-500' : 'bg-gray-700'">
          {{ isCameraOff ? 'Turn Camera On' : 'Turn Camera Off' }}
        </button>
        <button @click="toggleMic" class="px-4 py-2 rounded text-white"
          :class="isMicMuted ? 'bg-red-500' : 'bg-gray-700'">
          {{ isMicMuted ? 'Unmute Mic' : 'Mute Mic' }}
        </button>
      </div>
      <p class="text-sm text-gray-600 self-center">Setup your camera or mic before joining</p>
    </div>

    <button v-if="!inCall" @click="createCall" class="px-6 py-2 bg-blue-600 text-white rounded">
      Create Call
    </button>

    <!-- Call controls (during active call) -->
    <div v-if="inCall" class="flex gap-3">
      <button @click="toggleMic" class="px-4 py-2 rounded text-white"
        :class="isMicMuted ? 'bg-red-500' : 'bg-gray-700'">
        {{ isMicMuted ? 'Unmute Mic' : 'Mute Mic' }}
      </button>

      <button @click="toggleCamera" :disabled="isScreenSharing" class="px-4 py-2 rounded text-white disabled:opacity-30"
        :class="isCameraOff ? 'bg-red-500' : 'bg-gray-700'">
        {{ isCameraOff ? 'Turn Camera On' : 'Turn Camera Off' }}
      </button>

      <button @click="toggleScreenShare" class="px-4 py-2 rounded text-white"
        :class="isScreenSharing ? 'bg-red-500' : 'bg-blue-600'">
        {{ isScreenSharing ? 'Stop Share' : 'Share Screen' }}
      </button>

      <button @click="hangUp" class="px-6 py-2 bg-red-600 text-white rounded">
        Hang Up
      </button>
    </div>
  </div>
</template>