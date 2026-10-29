import { describe, expect, it } from "vitest";
import {
  contextDirFor,
  formatBytes,
  isAbsolutePath,
  joinPath,
  outputsDirFor,
  outputsRootFor,
  projectDirFor,
  safeFolderName,
} from "./assistant.js";

describe("outputsDirFor", () => {
  it("proje adını güvenli klasör adına çevirir, proje yoksa Genel kullanır", () => {
    expect(outputsDirFor("/Users/e/Documents", "Kişisel Finans")).toBe(
      "/Users/e/Documents/Codezal Asistan/Kişisel Finans/Çıktılar",
    );
    expect(outputsDirFor("/Users/e/Documents/", null)).toBe(
      "/Users/e/Documents/Codezal Asistan/Genel/Çıktılar",
    );
    expect(safeFolderName(' a/b: "c" ')).toBe("a b c");
    expect(safeFolderName("///")).toBe("Proje");
  });

  it("çıktı kökü kod deposunun içinde değil, kardeş klasördedir", () => {
    expect(outputsRootFor("/Users/e/Documents")).toBe("/Users/e/Documents/Codezal Asistan");
    expect(outputsRootFor("/Users/e/Documents")).not.toContain("/Documents/Codezal/");
  });

  it("Windows'ta geçersiz klasör adı üretmez", () => {
    // Sondaki nokta/boşluk Windows'ta klasör açılışını bozar.
    expect(safeFolderName("rapor. ")).toBe("rapor");
    // Aygıt adları klasöre değil aygıta çözülür.
    expect(safeFolderName("CON")).toBe("CON_");
    expect(safeFolderName("com1")).toBe("com1_");
    expect(safeFolderName("Lpt9.")).toBe("Lpt9_");
    expect(safeFolderName("console")).toBe("console");
    // Windows uzantılı adda da taban adı aygıta çözer: "CON.txt" açılamaz.
    expect(safeFolderName("CON.local")).toBe("CON.local_");
    expect(safeFolderName("com1.rapor")).toBe("com1.rapor_");
  });

  it("Windows tabanında ters bölü kullanır", () => {
    expect(outputsDirFor("C:\\Users\\e\\Documents", "Kişisel Finans")).toBe(
      "C:\\Users\\e\\Documents\\Codezal Asistan\\Kişisel Finans\\Çıktılar",
    );
    expect(outputsDirFor("\\\\sunucu\\pay\\Belgeler\\", null)).toBe(
      "\\\\sunucu\\pay\\Belgeler\\Codezal Asistan\\Genel\\Çıktılar",
    );
    // Windows'ta Belgeler OneDrive'a yönlenmiş olabilir; ayraç ve ad korunur.
    expect(outputsDirFor("C:\\Users\\e\\OneDrive\\Belgeler", "3E Soğutma")).toBe(
      "C:\\Users\\e\\OneDrive\\Belgeler\\Codezal Asistan\\3E Soğutma\\Çıktılar",
    );
  });
});

describe("projectDirFor / contextDirFor", () => {
  it("proje ve bağlam klasörlerini çıktı kökü altında üretir", () => {
    expect(projectDirFor("/Users/e/Documents", "Kişisel Finans")).toBe(
      "/Users/e/Documents/Codezal Asistan/Kişisel Finans",
    );
    expect(contextDirFor("/Users/e/Documents", "Kişisel Finans")).toBe(
      "/Users/e/Documents/Codezal Asistan/Kişisel Finans/Bağlam",
    );
    // Projesiz bağlam da `Genel` klasörüne düşer; ayraç tabandan gelir.
    expect(contextDirFor("C:\\Users\\e\\Documents", null)).toBe(
      "C:\\Users\\e\\Documents\\Codezal Asistan\\Genel\\Bağlam",
    );
  });
});

describe("formatBytes", () => {
  it("kaba boyut etiketi üretir", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2,0 KB");
    expect(formatBytes(3.4 * 1024 * 1024)).toBe("3,4 MB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2,0 GB");
    // Ondalık ayraç arayüz diline uyar.
    expect(formatBytes(2048, "en")).toBe("2.0 KB");
    expect(formatBytes(3.4 * 1024 * 1024, "en")).toBe("3.4 MB");
  });
});

describe("joinPath", () => {
  it("tabanın ayracını korur ve göreli parçadaki ayracı ona çevirir", () => {
    expect(joinPath("/tmp/cz", "asistan", "p1")).toBe("/tmp/cz/asistan/p1");
    expect(joinPath("C:\\cz\\", "asistan/p1")).toBe("C:\\cz\\asistan\\p1");
    expect(joinPath("C:\\cz", "")).toBe("C:\\cz");
  });
});

describe("isAbsolutePath", () => {
  it("iki platformun mutlak yollarını tanır", () => {
    expect(isAbsolutePath("/Users/e/rapor.md")).toBe(true);
    expect(isAbsolutePath("C:\\Users\\e\\rapor.md")).toBe(true);
    expect(isAbsolutePath("C:/Users/e/rapor.md")).toBe(true);
    expect(isAbsolutePath("\\\\sunucu\\pay\\rapor.md")).toBe(true);
    expect(isAbsolutePath("rapor.md")).toBe(false);
    expect(isAbsolutePath("alt\\rapor.md")).toBe(false);
  });
});
