export const MAX_LOGO_FILE_BYTES = 5 * 1024 * 1024;
const LOGO_PIXELS = 128;

export class LogoFileError extends Error {
  readonly name = "LogoFileError";
  constructor(readonly reason: "tooLarge" | "unreadable") {
    super(reason);
  }
}

/** Rejects files that are obviously not usable before they are read. */
export function assertLogoFile(file: Pick<File, "size" | "type">): void {
  if (file.size > MAX_LOGO_FILE_BYTES) throw new LogoFileError("tooLarge");
  if (file.size === 0 || (file.type !== "" && !file.type.startsWith("image/"))) {
    throw new LogoFileError("unreadable");
  }
}

/* v8 ignore start -- needs a real canvas and image decoder, which jsdom lacks */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new LogoFileError("unreadable"));
    reader.readAsDataURL(file);
  });
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new LogoFileError("unreadable"));
    image.src = source;
  });
}

/**
 * Turns any image the webview can decode (PNG, JPEG, WebP, GIF, SVG …) into a
 * 128 px PNG and returns its base64 payload. The native side decodes and
 * re-encodes that PNG once more before storing it.
 */
export async function fileToLogoPngBase64(file: File): Promise<string> {
  assertLogoFile(file);
  const image = await loadImage(await readAsDataUrl(file));
  const width = image.naturalWidth || LOGO_PIXELS;
  const height = image.naturalHeight || LOGO_PIXELS;
  const scale = Math.min(LOGO_PIXELS / width, LOGO_PIXELS / height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new LogoFileError("unreadable");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const [, base64] = canvas.toDataURL("image/png").split(",");
  if (!base64) throw new LogoFileError("unreadable");
  return base64;
}
/* v8 ignore stop */
