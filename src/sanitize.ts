const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/g;

function toEscapeSequence(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  const width = codePoint <= 0xff ? 2 : 4;
  return `\\x${codePoint.toString(16).padStart(width, "0")}`;
}

export function sanitizeTerminalText(text: string): string {
  return text.replace(CONTROL_CHARACTER_PATTERN, toEscapeSequence);
}
