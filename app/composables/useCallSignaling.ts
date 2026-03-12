import { db } from '@/composables/firebase'
import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  setDoc,
  updateDoc
} from 'firebase/firestore'
import { ref } from 'vue'
import type {
  DocumentReference,
  DocumentSnapshot,
  DocumentData
} from 'firebase/firestore'

export function useCallSignaling(
  peerConnection: RTCPeerConnection,
  router: ReturnType<typeof useRouter>,
  callId: Ref<string>,
  peerStatus: Ref<{ micMuted: boolean; cameraOff: boolean }>,
  role: Ref<"host" | "guest" | null>
) {

  let callDocRef: DocumentReference<DocumentData> | null = null
  const unsubscribers: (() => void)[] = []
  let lastAnswerSdp: string | null = null
  let lastOfferSdp: string | null = null
  const peerLeft = ref(false)

  const createCall = async () => {
    cleanup() // clear any previous listeners
    role.value = "host"
    console.log("[Host] Creating call...")
    const callDoc = doc(collection(db, "calls")) as DocumentReference<DocumentData>
    const offerCandidates = collection(callDoc, "offerCandidates")
    const answerCandidates = collection(callDoc, "answerCandidates")

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("[Host] Got ICE candidate, adding to Firestore")
        addDoc(offerCandidates, event.candidate.toJSON())
      }
    }

    const offerDescription = await peerConnection.createOffer()
    console.log("[Host] Created offer")
    await peerConnection.setLocalDescription(offerDescription)
    console.log("[Host] Set local description")

    await setDoc(callDoc, {
      offer: {
        type: offerDescription.type,
        sdp: offerDescription.sdp
      }
    })
    console.log("[Host] Sent offer to Firestore, call ID:", callDoc.id)

    callId.value = callDoc.id

    unsubscribers.push(onSnapshot(callDoc, (snapshot) => {
      const data = snapshot.data()

      if (data?.answer) {
        const newAnswerSdp = data.answer.sdp
        // Apply the answer if we haven't set one yet, or if a NEW answer arrived (guest reconnected)
        if (!lastAnswerSdp || lastAnswerSdp !== newAnswerSdp) {
          console.log("[Host] Got answer from guest, setting remote description")
          lastAnswerSdp = newAnswerSdp
          const answerDescription = new RTCSessionDescription(data.answer)
          peerConnection.setRemoteDescription(answerDescription).catch(err => {
            console.error("Failed to set remote description for answer", err)
          })
        }
      }
    }))

    unsubscribers.push(onSnapshot(answerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added") {
          const candidate = new RTCIceCandidate(change.doc.data())

          peerConnection.addIceCandidate(candidate)
        }
      })
    }))

    unsubscribers.push(onSnapshot(callDoc, (snapshot: DocumentSnapshot<DocumentData>) => {
      const data = snapshot.data()
      if (!data) return
      if (role.value === "host" && data.guestStatus) {
        peerStatus.value = data.guestStatus
      }
      if (role.value === "guest" && data.hostStatus) {
        peerStatus.value = data.hostStatus
      }
      if (data.hostLeft || data.guestLeft) {
        peerLeft.value = true
        console.warn("Peer left the call")
      }
    }))

    await router.replace({
      query: { call: callDoc.id }
    })

    callDocRef = callDoc
  }

  const joinCall = async () => {
    cleanup() // clear any previous listeners
    role.value = "guest"
    console.log("[Guest] Starting to join call:", callId.value)

    const callDoc = doc(db, "calls", callId.value) as DocumentReference<DocumentData>
    callDocRef = callDoc

    const answerCandidates = collection(callDoc, "answerCandidates")
    const offerCandidates = collection(callDoc, "offerCandidates")

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("[Guest] Got ICE candidate, adding to Firestore")
        addDoc(answerCandidates, event.candidate.toJSON())
      }
    }

    const callData = (await getDoc(callDoc)).data()
    const offerDescription = callData?.offer
    console.log("[Guest] Got offer from host:", offerDescription?.type)

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(offerDescription)
    )
    console.log("[Guest] Set remote description")

    lastOfferSdp = offerDescription.sdp

    const answerDescription = await peerConnection.createAnswer()
    console.log("[Guest] Created answer")
    await peerConnection.setLocalDescription(answerDescription)
    console.log("[Guest] Set local description")
    await updateDoc(callDoc, {
      answer: {
        type: answerDescription.type,
        sdp: answerDescription.sdp
      }
    })
    console.log("[Guest] Sent answer to Firestore")

    // Watch for offer changes (in case host reconnected)
    unsubscribers.push(onSnapshot(callDoc, (snapshot) => {
      const data = snapshot.data()
      if (data?.offer) {
        const newOfferSdp = data.offer.sdp
        // If we get a new offer (different from what we've seen), apply it
        // This handles the case where the host reconnected with a new offer
        if (lastOfferSdp && lastOfferSdp !== newOfferSdp) {
          console.log("New offer detected from host reconnection, updating remote description")
          lastOfferSdp = newOfferSdp
          peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer))
            .then(async () => {
              // Create and send a new answer for the new offer
              const newAnswerDescription = await peerConnection.createAnswer()
              await peerConnection.setLocalDescription(newAnswerDescription)
              await updateDoc(callDoc, {
                answer: {
                  type: newAnswerDescription.type,
                  sdp: newAnswerDescription.sdp
                }
              })
            })
            .catch(err => {
              console.error("Failed to handle new offer", err)
            })
        }
      }
    }))

    unsubscribers.push(onSnapshot(offerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added") {
          const candidate = new RTCIceCandidate(change.doc.data())
          peerConnection.addIceCandidate(candidate)
        }
      })
    }))

    // Listen for host status updates and peer left events
    unsubscribers.push(onSnapshot(callDoc, (snapshot: DocumentSnapshot<DocumentData>) => {
      const data = snapshot.data()
      if (!data) return
      if (role.value === "guest" && data.hostStatus) {
        peerStatus.value = data.hostStatus
      }
      if (data.hostLeft || data.guestLeft) {
        peerLeft.value = true
        console.warn("Peer left the call")
      }
    }))
  }

  const cleanup = () => {
    unsubscribers.forEach(unsub => unsub())
    unsubscribers.length = 0
    // Reset SDP tracking so new offers/answers are applied on reconnect
    lastAnswerSdp = null
    lastOfferSdp = null
    peerLeft.value = false
  }

  const hangUp = async () => {
    cleanup()

    if (!callDocRef) return

    if (role.value === "host") {
      await updateDoc(callDocRef, {
        hostLeft: true
      })
    }

    if (role.value === "guest") {
      await updateDoc(callDocRef, {
        guestLeft: true
      })
    }
  }

  return {
    createCall,
    joinCall,
    hangUp,
    getCallDoc: () => callDocRef,
    peerLeft
  }
}