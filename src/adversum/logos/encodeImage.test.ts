import { describe, expect, it } from "vitest";
import { assertLogoFile, LogoFileError, MAX_LOGO_FILE_BYTES } from "./encodeImage";

describe("assertLogoFile", () => {
  it("accepts images, including files without a reported type", () => {
    expect(() => assertLogoFile({ size: 10, type: "image/png" })).not.toThrow();
    expect(() => assertLogoFile({ size: 10, type: "image/svg+xml" })).not.toThrow();
    expect(() => assertLogoFile({ size: MAX_LOGO_FILE_BYTES, type: "" })).not.toThrow();
  });

  it("rejects oversized, empty and non-image files with a reason", () => {
    const reasonOf = (file: { size: number; type: string }) => {
      try {
        assertLogoFile(file);
      } catch (error) {
        expect(error).toBeInstanceOf(LogoFileError);
        expect((error as LogoFileError).name).toBe("LogoFileError");
        return (error as LogoFileError).reason;
      }
      return null;
    };
    expect(reasonOf({ size: MAX_LOGO_FILE_BYTES + 1, type: "image/png" })).toBe("tooLarge");
    expect(reasonOf({ size: 0, type: "image/png" })).toBe("unreadable");
    expect(reasonOf({ size: 10, type: "application/pdf" })).toBe("unreadable");
  });
});
