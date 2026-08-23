import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Veil — Privacy Vision Agent",
    description:
      "On-device screen understanding with PII redaction. Sensitive values never leave your machine.",
    version: "0.1.0",
    permissions: ["storage", "tabs", "activeTab"],
    host_permissions: ["<all_urls>"],
    icons: {
      16: "icon/16.png",
      48: "icon/48.png",
      128: "icon/128.png",
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
