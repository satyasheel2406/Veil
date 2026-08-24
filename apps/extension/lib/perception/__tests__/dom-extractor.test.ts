// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collectCandidates, collectFromIframes, SELECTOR } from "../dom-extractor";

describe("collectCandidates — shadow DOM traversal", () => {
  it("finds elements inside open shadow roots (nested)", () => {
    document.body.innerHTML = `
      <button id="top-btn">Top</button>
      <div id="host"></div>
    `;
    const host = document.getElementById("host")!;
    const outer = host.attachShadow({ mode: "open" });
    outer.innerHTML = `<a href="#x" id="outer-link">Outer</a><div id="inner-host"></div>`;
    const innerHost = outer.querySelector("#inner-host")!;
    const inner = innerHost.attachShadow({ mode: "open" });
    inner.innerHTML = `<input id="deep-input" />`;

    const found = collectCandidates(document.body, SELECTOR);
    const ids = new Set(
      found.map((el) => el.id || el.querySelector?.("[id]")?.id).filter(Boolean)
    );
    expect(found.some((el) => el.id === "top-btn")).toBe(true);
    expect(found.some((el) => el.id === "outer-link")).toBe(true);
    expect(found.some((el) => el.id === "deep-input")).toBe(true);
  });

  it("returns no duplicates for flat DOM", () => {
    document.body.innerHTML = `
      <button>a</button><button>b</button>
    `;
    const found = collectCandidates(document.body, SELECTOR);
    expect(found).toHaveLength(2);
  });
});

describe("collectFromIframes — same-origin iframe traversal", () => {
  it("finds elements inside a same-origin iframe", () => {
    document.body.innerHTML = `<iframe id="f"></iframe>`;
    const frame = document.getElementById("f") as HTMLIFrameElement;
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(`<html><body><button id="frame-btn">In frame</button></body></html>`);
    doc.close();

    const found = collectFromIframes(document, SELECTOR);
    expect(found.map((el) => el.id)).toContain("frame-btn");
  });

  it("skips cross-origin frames without throwing", () => {
    document.body.innerHTML = `<iframe id="f"></iframe>`;
    const frame = document.getElementById("f") as HTMLIFrameElement;
    Object.defineProperty(frame, "contentDocument", {
      get() {
        throw new Error("SecurityError: blocked a frame with origin");
      },
    });
    expect(() => collectFromIframes(document, SELECTOR)).not.toThrow();
    expect(collectFromIframes(document, SELECTOR)).toHaveLength(0);
  });
});
