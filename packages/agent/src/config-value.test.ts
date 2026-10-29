import { afterEach, describe, expect, it } from "vitest";
import {
  clearConfigValueCache,
  getConfigValueEnvVarNames,
  getMissingConfigValueEnvVarNames,
  isCommandConfigValue,
  isConfigValueConfigured,
  resolveConfigValue,
  resolveConfigValueUncached,
} from "./config-value.js";

afterEach(() => clearConfigValueCache());

describe("resolveConfigValue — sentaks", () => {
  it("literal değeri olduğu gibi döndürür", () => {
    expect(resolveConfigValue("sk-abc-123")).toBe("sk-abc-123");
  });

  it("$VAR ve süslü parantez biçimi env parametresinden çözülür", () => {
    const env = { CODEZAL_TEST_TOKEN: "gizli-değer" };
    expect(resolveConfigValue("$CODEZAL_TEST_TOKEN", env)).toBe("gizli-değer");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${VAR} sentaksı kasıtlı olarak test ediliyor
    expect(resolveConfigValue("${CODEZAL_TEST_TOKEN}", env)).toBe("gizli-değer");
  });

  it("çok parçalı şablonu birleştirir", () => {
    expect(resolveConfigValue("Bearer $CODEZAL_TEST_TOKEN", { CODEZAL_TEST_TOKEN: "abc" })).toBe(
      "Bearer abc",
    );
  });

  it("process.env'e düşer", () => {
    process.env.CODEZAL_TEST_PROCESS_TOKEN = "ortamdan";
    expect(resolveConfigValue("$CODEZAL_TEST_PROCESS_TOKEN")).toBe("ortamdan");
    delete process.env.CODEZAL_TEST_PROCESS_TOKEN;
  });

  it("env parametresi process.env'i geçersiz kılar", () => {
    process.env.CODEZAL_TEST_OVERRIDE = "ortam";
    expect(resolveConfigValue("$CODEZAL_TEST_OVERRIDE", { CODEZAL_TEST_OVERRIDE: "param" })).toBe(
      "param",
    );
    delete process.env.CODEZAL_TEST_OVERRIDE;
  });

  it("$$ ve $! kaçar; bitişik $ ve geçersiz süslü parantez literal kalır", () => {
    expect(resolveConfigValue("a$$b")).toBe("a$b");
    expect(resolveConfigValue("a$!b")).toBe("a!b");
    expect(resolveConfigValue("100$")).toBe("100$");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: geçersiz placeholder literal kalmalı
    expect(resolveConfigValue("${1X}")).toBe("${1X}");
    expect(resolveConfigValue("${kapanmamis")).toBe("${kapanmamis");
  });

  it("tanımsız env değişkeninde undefined döner", () => {
    expect(resolveConfigValue("$CODEZAL_YOK_BOYLE_BIR_SEY", {})).toBeUndefined();
    expect(resolveConfigValue("Bearer $CODEZAL_YOK_BOYLE_BIR_SEY", {})).toBeUndefined();
  });
});

describe("resolveConfigValue — komut referansı", () => {
  it("echo çıktısını döndürür ve kırpar", () => {
    expect(resolveConfigValue("!echo merhaba")).toBe("merhaba");
    expect(resolveConfigValueUncached("!echo merhaba")).toBe("merhaba");
  });

  it("başarısız komut ve boş çıktı undefined döner", () => {
    expect(resolveConfigValue("!exit 1")).toBeUndefined();
    expect(resolveConfigValue("!exit 0")).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("komut sonucu önbelleklenir", () => {
    // $RANDOM her koşuda değişir; önbellek devredeyse iki çağrı aynı kalır.
    const first = resolveConfigValue('!echo "rastgele-$RANDOM"');
    const second = resolveConfigValue('!echo "rastgele-$RANDOM"');
    expect(first).toBeDefined();
    expect(second).toBe(first);
    clearConfigValueCache();
    const third = resolveConfigValueUncached('!echo "rastgele-$RANDOM"');
    expect(third).toMatch(/^rastgele-\d+$/);
  });
});

describe("yardımcılar", () => {
  it("komut referansını tanır", () => {
    expect(isCommandConfigValue("!security find-generic-password -ws 'anthropic'")).toBe(true);
    expect(isCommandConfigValue("$ENV_VAR")).toBe(false);
    expect(isCommandConfigValue("düz-anahtar")).toBe(false);
  });

  it("env adlarını ve eksikleri listeler", () => {
    expect(getConfigValueEnvVarNames("Bearer $TOKEN/x")).toEqual(["TOKEN"]);
    expect(getConfigValueEnvVarNames("$A-$B-$A")).toEqual(["A", "B"]);
    expect(getConfigValueEnvVarNames("!echo hi")).toEqual([]);
    expect(getMissingConfigValueEnvVarNames("$A-$B", { A: "1" })).toEqual(["B"]);
    expect(isConfigValueConfigured("$A", { A: "1" })).toBe(true);
    expect(isConfigValueConfigured("$A", {})).toBe(false);
    expect(isConfigValueConfigured("düz-anahtar")).toBe(true);
  });
});
