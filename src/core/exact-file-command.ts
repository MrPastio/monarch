/** Syntax only: no filesystem access, target discovery or execution authority.
 * Shared by routing and Astra so quoted file content stays data in both. */
export function parseExactFileCreate(text: string): { spelling: string; content: string } | null {
  const match = /^(?:пожалуйста\s+|please\s+)?(создай(?:\s+новый)?(?:\s+файл)?|create(?:\s+a)?(?:\s+new)?(?:\s+file)?)\s+(?:"([^"\r\n]+)"|([^\s"\r\n]+))\s+(?:с\s+(?:точным\s+)?текстом|with\s+(?:exact\s+)?text)\s*:\s*"([^"\u0000]*)"[.!]?\s*$/iu.exec(text);
  if (!match) return null;
  const spelling = match[2] ?? match[3]!;
  // Without the word file, require path syntax. "Создай картинку с текстом"
  // is an image request, not a request for a file named "картинку".
  if (!/(?:файл|file)$/iu.test(match[1]!) && !/[\\/]|\.[^.\s]+$/u.test(spelling)) return null;
  return { spelling, content: match[4]! };
}
