/// <reference types="vite/client" />

import type { LineupAPI } from '../preload/index'

declare global {
  interface Window {
    lineup: LineupAPI
  }
}
