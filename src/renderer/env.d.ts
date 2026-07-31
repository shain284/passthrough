import type { RendererApi } from '../shared/types.ts'

declare global {
  interface Window {
    api: RendererApi
  }
}

export {}
