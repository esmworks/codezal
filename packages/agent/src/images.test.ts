import { describe, expect, it } from "vitest";
import { prepareImages } from "./images.js";

// 1x1 şeffaf PNG
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("prepareImages", () => {
  it("küçük görseli olduğu gibi Pi ImageContent'e çevirir", async () => {
    const out = await prepareImages([{ mimeType: "image/png", data: PNG, name: "nokta.png" }]);
    expect(out).toEqual([{ type: "image", mimeType: "image/png", data: PNG }]);
  });

  it("desteklenmeyen türü reddeder", async () => {
    await expect(prepareImages([{ mimeType: "image/bmp", data: PNG }])).rejects.toThrow(
      /Desteklenmeyen/,
    );
  });
});
