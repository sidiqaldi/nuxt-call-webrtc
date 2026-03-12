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
  role: Ref<"caller" | "callee" | null>
) {

  let callDocRef: DocumentReference<DocumentData> | null = null
  const unsubscribers: (() => void)[] = []
  let lastAnswerSdp: string | null = null
  let lastOfferSdp: string | null = null

  const createCall = async () => {
    cleanup() // clear any previous listeners
    role.value = "caller"
    const callDoc = doc(collection(db, "calls")) as DocumentReference<DocumentData>
    const offerCandidates = collection(callDoc, "offerCandidates")
    const answerCandidates = collection(callDoc, "answerCandidates")

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        addDoc(offerCandidates, event.candidate.toJSON())
      }
    }

    const offerDescription = await peerConnection.createOffer()
    await peerConnection.setLocalDescription(offerDescription)

    await setDoc(callDoc, {
      offer: {
        type: offerDescription.type,
        sdp: offerDescription.sdp
      }
    })

    callId.value = callDoc.id

    unsubscribers.push(onSnapshot(callDoc, (snapshot) => {
      const data = snapshot.data()

      if (data?.answer) {
        const newAnswerSdp = data.answer.sdp
        // Apply the answer if we haven't set one yet, or if a NEW answer arrived (callee reconnected)
        if (!lastAnswerSdp || lastAnswerSdp !== newAnswerSdp) {
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
      if (role.value === "caller" && data.calleeStatus) {
        peerStatus.value = data.calleeStatus
      }
      if (role.value === "callee" && data.callerStatus) {
        peerStatus.value = data.callerStatus
      }
      if (data.callerLeft || data.calleeLeft) {
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
    role.value = "callee"

    const callDoc = doc(db, "calls", callId.value) as DocumentReference<DocumentData>
    callDocRef = callDoc

    const answerCandidates = collection(callDoc, "answerCandidates")
    const offerCandidates = collection(callDoc, "offerCandidates")

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        addDoc(answerCandidates, event.candidate.toJSON())
      }
    }

    const callData = (await getDoc(callDoc)).data()
    const offerDescription = callData?.offer

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(offerDescription)
    )

    lastOfferSdp = offerDescription.sdp

    const answerDescription = await peerConnection.createAnswer()
    await peerConnection.setLocalDescription(answerDescription)
    await updateDoc(callDoc, {
      answer: {
        type: answerDescription.type,
        sdp: answerDescription.sdp
      }
    })

    // Watch for offer changes (in case caller reconnected)
    unsubscribers.push(onSnapshot(callDoc, (snapshot) => {
      const data = snapshot.data()
      if (data?.offer) {
        const newOfferSdp = data.offer.sdp
        // If we get a new offer (different from what we've seen), apply it
        // This handles the case where the caller reconnected with a new offer
        if (lastOfferSdp && lastOfferSdp !== newOfferSdp) {
          console.log("New offer detected from caller reconnection, updating remote description")
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
  }

  const cleanup = () => {
    unsubscribers.forEach(unsub => unsub())
    unsubscribers.length = 0
    // Reset SDP tracking so new offers/answers are applied on reconnect
    lastAnswerSdp = null
    lastOfferSdp = null
  }

  const hangUp = async () => {
    cleanup()

    if (!callDocRef) return

    if (role.value === "caller") {
      await updateDoc(callDocRef, {
        callerLeft: true
      })
    }

    if (role.value === "callee") {
      await updateDoc(callDocRef, {
        calleeLeft: true
      })
    }
  }

  return {
    createCall,
    joinCall,
    hangUp,
    getCallDoc: () => callDocRef
  }
}