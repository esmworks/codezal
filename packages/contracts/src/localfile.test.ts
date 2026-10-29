import { describe, expect, it } from "vitest";
import { localFilePath, localFileUrl, previewKindFor, previewMimeFor } from "./localfile.js";

describe("localfile", () => {
  it("Türkçe karakter, boşluk ve # içeren yolu kodlayıp geri çözer", () => {
    const path = "/Users/e/Documents/Codezal Asistan/Elektrik Projesi/Çıktılar/rev #2.pdf";
    const url = localFileUrl(path);
    expect(url.startsWith("codezal-file://local/Users/")).toBe(true);
    expect(url).not.toContain(" ");
    expect(url).not.toContain("#");
    expect(localFilePath(url)).toBe(path);
  });

  it("Windows yolunu gidiş dönüş korur", () => {
    const path = "C:\\Users\\e\\Documents\\rapor.pdf";
    expect(localFilePath(localFileUrl(path))).toBe(path);
  });

  it("UNC (ağ paylaşımı) yolunu gidiş dönüş korur", () => {
    const path = "\\\\sunucu\\paylasim\\rapor.pdf";
    expect(localFileUrl(path)).toBe("codezal-file://local//sunucu/paylasim/rapor.pdf");
    expect(localFilePath(localFileUrl(path))).toBe(path);
  });

  it("başka şema ya da sunucu adını reddeder", () => {
    expect(localFilePath("file:///etc/passwd")).toBeUndefined();
    expect(localFilePath("codezal-file://other/etc/passwd")).toBeUndefined();
    expect(localFilePath("bozuk")).toBeUndefined();
  });

  it("önizleme türünü uzantıdan bulur; metin ve bilinmeyenler önizlenmez", () => {
    expect(previewKindFor("/a/b.PDF")).toBe("pdf");
    expect(previewKindFor("/a/b.jpeg")).toBe("image");
    expect(previewMimeFor("/a/b.svg")).toBe("image/svg+xml");
    expect(previewKindFor("/a/b.HTM")).toBe("html");
    expect(previewKindFor("/a/b.md")).toBeUndefined();
    expect(previewKindFor("/a/b.xlsx")).toBeUndefined();
    expect(previewKindFor("/a/.pdf")).toBeUndefined();
  });
});
