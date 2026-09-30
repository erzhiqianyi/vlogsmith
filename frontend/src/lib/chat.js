import { createContext } from 'react'

// Lets the transcript editor hand its checked rows to the AI chat panel and get the
// AI's corrections back: it registers a bridge { selection, remove, clear, onResult }
// through setBridge while it's mounted.
export const ChatBridgeContext = createContext(null)
