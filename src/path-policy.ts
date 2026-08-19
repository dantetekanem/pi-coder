import { extname } from "node:path";

export interface ReviewPathPolicy {
  includeGenerated?: boolean;
}

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".avi",
  ".avif",
  ".bin",
  ".bmp",
  ".class",
  ".dll",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lockb",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".otf",
  ".pdf",
  ".png",
  ".pyc",
  ".so",
  ".svgz",
  ".tar",
  ".ttf",
  ".wasm",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

const GENERATED_TEXT_EXTENSIONS = new Set([".map", ".rbi"]);

function isGeneratedTextFile(fileName: string, extension: string): boolean {
  return GENERATED_TEXT_EXTENSIONS.has(extension) || fileName.endsWith(".min.js") || fileName.endsWith(".min.css");
}

export function isReviewableFilePath(path: string, policy: ReviewPathPolicy = {}): boolean {
  const lowerPath = path.toLowerCase();
  const fileName = lowerPath.split("/").pop() ?? lowerPath;
  const extension = extname(fileName);

  if (fileName.length === 0 || BINARY_EXTENSIONS.has(extension)) return false;
  if (!policy.includeGenerated && isGeneratedTextFile(fileName, extension)) return false;

  return true;
}
