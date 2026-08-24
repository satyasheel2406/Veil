import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

const WASM_CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: ({ browser }) => ({
    name: "Veil — Privacy Vision Agent",
    description:
      "On-device screen understanding with PII redaction. Sensitive values never leave your machine.",
    version: "0.1.6",
    permissions: [
      "storage",
      "tabs",
      "activeTab",
      "scripting",
      // Chrome-only: hidden DOM page hosts MediaPipe (SW can't importScripts).
      ...(browser === "firefox" ? [] : ["offscreen"]),
    ],
    host_permissions: ["<all_urls>"],
    icons: {
      16: "icon/16.png",
      48: "icon/48.png",
      128: "icon/128.png",
    },
    // MV3 takes an object; MV2 (Firefox) takes a flat string.
    ...(browser === "firefox"
      ? {
          content_security_policy: WASM_CSP,
          browser_specific_settings: {
            gecko: {
              // Required for AMO signing / stable add-on identity.
              id: "veil@pv-agent.extension",
              // Mandatory since Nov 2025 for new Firefox add-ons.
              data_collection_permissions: { required: ["none"] as const },
            },
          },
        }
      : { content_security_policy: { extension_pages: WASM_CSP } }),
  }),
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
