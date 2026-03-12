import { initializeApp } from "firebase/app"
import { getFirestore } from "firebase/firestore"

const firebaseConfig = {
  apiKey: "AIzaSyCYRO8cuf_18714OG2TK1hkTzhT6Z9qzD8",
  authDomain: "vercel-rtc.firebaseapp.com",
  projectId: "vercel-rtc",
  storageBucket: "vercel-rtc.firebasestorage.app",
  messagingSenderId: "384757452559",
  appId: "1:384757452559:web:2a95c44ffe25c57d0bf87a",
  measurementId: "G-VMBJ1F0XGR"
};

const app = initializeApp(firebaseConfig)

export const db = getFirestore(app)