<script setup lang="ts">
import { useMediaControls } from '@/composables/useMediaControls'
import { useScreenShare } from '@/composables/useScreenShare'
import { useCallSignaling } from '@/composables/useCallSignaling'
import {
  updateDoc,
} from 'firebase/firestore'
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'

const localVideo = ref<HTMLVideoElement | null>(null)
const remoteVideo = ref<HTMLVideoElement | null>(null)
const callId = ref("")
const route = useRoute()
const isMicMuted = ref(false)
const isCameraOff = ref(false)
const role = ref<"caller" | "callee" | null>(null)
const peerStatus = ref({
  micMuted: false,
  cameraOff: false
})

// UI state
const inCall = ref(false)
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

const isClient = import.meta.client

if (isClient && route.query.call) {
  callId.value = route.query.call as string
}

const createCall = async () => {
  try {
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
    role.value = "callee"

    await signaling.value?.joinCall()
    inCall.value = true

    const callDoc = signaling.value?.getCallDoc()
    if (callDoc) {
      await updateDoc(callDoc, { calleeLeft: false })
    }

    if (isClient && !route.query.call) {
      await router.replace({ query: { call: callId.value } })
    }
  } catch (err) {
    console.error('failed to join call', err)
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
}

const toggleMic = async () => {
  if (!mediaControls) return

  mediaControls.toggleMic(isMicMuted)

  await updateMediaStatus()
}

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

  if (role.value === "caller") {
    await updateDoc(callDoc, { callerStatus: status })
  }

  if (role.value === "callee") {
    await updateDoc(callDoc, { calleeStatus: status })
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
      peerConnection.addTrack(track, localStream)
    })

    peerConnection.ontrack = (event) => {
      const [remoteStream] = event.streams
      if (remoteVideo.value && remoteStream) {
        remoteVideo.value.srcObject = remoteStream
      }
    }

    peerConnection.addEventListener("connectionstatechange", () => {
      console.log("Peer state:", peerConnection?.connectionState)
    })
  } catch (err) {
    console.error(err)
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

    <div v-if="inCall && callId" class="flex flex-col gap-2 items-center">
      <input :value="callLink" readonly class="border px-3 py-2 rounded w-80" />
      <p class="text-sm text-gray-700">You are the <strong>{{ role }}</strong> in this call.</p>
    </div>

    <div v-if="!inCall" class="flex flex-col gap-1">
      <div class="flex gap-3">
        <input v-model="callId" placeholder="Enter Call ID" class="border px-3 py-2 rounded" />
        <button @click="joinCall" :disabled="!callId"
          class="px-6 py-2 bg-green-600 text-white rounded disabled:opacity-50">
          Join Call
        </button>
      </div>
      <p v-if="isClient && route.query.call" class="text-sm text-gray-600">
        Call ID loaded from URL; click "Join Call" when you're ready.
      </p>
    </div>

    <div class="flex gap-6">
      <div class="flex flex-col items-center">
        <p class="font-semibold mb-2">Local</p>
        <video ref="localVideo" autoplay playsinline muted class="w-80 rounded border shadow"></video>
      </div>

      <div class="flex flex-col items-center">
        <p class="font-semibold mb-2">Remote</p>
        <div class="relative">
          <video ref="remoteVideo" autoplay playsinline class="w-80 rounded border shadow"></video>
          <div v-if="peerStatus.cameraOff"
            class="absolute inset-0 flex items-center justify-center bg-black text-white">
            Camera Off
          </div>
        </div>
        <div v-if="peerStatus.micMuted" class="text-red-500">
          Peer muted mic
        </div>
      </div>
    </div>

    <button v-if="!inCall" @click="createCall" class="px-6 py-2 bg-blue-600 text-white rounded">
      Create Call
    </button>

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