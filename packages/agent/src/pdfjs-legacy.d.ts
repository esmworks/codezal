/**
 * pdfjs'in Node yapısı ayrı bir dosyadan gelir ve kendi tipini taşımaz; ana paketin tipleri
 * birebir geçerlidir (aynı API, farklı derleme hedefi).
 */
declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export * from "pdfjs-dist";
}
