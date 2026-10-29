import type { CodezalBridge } from "@codezal/contracts";

declare global {
  interface Window {
    codezal: CodezalBridge;
  }
}
