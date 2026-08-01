import type { TanweiDesktopApi } from "./contracts.js";

declare global {
  interface Window {
    readonly tanwei: TanweiDesktopApi;
  }
}

export {};
