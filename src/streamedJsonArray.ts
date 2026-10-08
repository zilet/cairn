// Incremental reader for ONE top-level array inside a JSON object that is still being
// streamed — e.g. the `days` of a first week while the composer is writing it — so each
// element can be shown the moment its closing brace arrives.
//
// Deliberately tolerant and deliberately small. It scans character by character with
// a balanced-brace walk that understands strings and escapes (a `}` inside a name never
// closes anything). Text outside the outermost object (narration, a ```json fence) is
// skipped: quotes there are not strings. A root object that closes without the key
// resets the walk, so a stray `{…}` in preamble prose does not swallow the real one.
// Each completed element is JSON.parse'd on its own; one that does not parse is
// dropped, never thrown. It is a PREVIEW reader: the op's final parse of the whole
// reply stays the authority on what the result is.

export interface StreamedArrayReader {
  /** Feed the next chunk; returns the elements completed by it (possibly none). */
  push(chunk: string): unknown[];
  /** Every element completed so far, in arrival order. */
  readonly items: unknown[];
}

/** Read the object elements of the top-level `key` array as the JSON text streams in. */
export function createStreamedArrayReader(key: string, opts: { maxItems?: number } = {}): StreamedArrayReader {
  const maxItems = opts.maxItems ?? 64;
  const items: unknown[] = [];
  let text = "";
  let pos = 0; // next index of `text` to scan
  let depth = 0; // 0 = outside the root object
  let inString = false;
  let escaped = false;
  let keyBuf: string | null = null; // the string being read at depth 1 (a candidate key)
  let lastString: string | null = null; // the last complete string at depth 1
  let currentKey: string | null = null; // the key whose value is being read at depth 1
  let arrayDepth = -1; // depth INSIDE the target array, -1 when not in it
  let elementStart = -1; // index of the current element's opening `{`

  function reset(): void {
    depth = 0;
    inString = false;
    escaped = false;
    keyBuf = null;
    lastString = null;
    currentKey = null;
    arrayDepth = -1;
    elementStart = -1;
  }

  function scan(): unknown[] {
    const out: unknown[] = [];
    for (; pos < text.length; pos++) {
      const ch = text[pos];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') {
          inString = false;
          if (keyBuf != null) {
            lastString = keyBuf;
            keyBuf = null;
          }
          continue;
        }
        // Only depth-1 strings can be the key; their raw text is enough to compare.
        if (keyBuf != null && keyBuf.length < 64) keyBuf += ch;
        continue;
      }
      if (depth === 0) {
        if (ch === "{") {
          depth = 1;
          lastString = null;
          currentKey = null;
        }
        continue; // anything else outside the root is narration
      }
      switch (ch) {
        case '"':
          inString = true;
          escaped = false;
          keyBuf = depth === 1 ? "" : null;
          break;
        case ":":
          if (depth === 1) currentKey = lastString;
          break;
        case ",":
          if (depth === 1) {
            currentKey = null;
            lastString = null;
          }
          break;
        case "{":
        case "[":
          if (ch === "[" && depth === 1 && currentKey === key && arrayDepth === -1) {
            depth += 1;
            arrayDepth = depth;
            break;
          }
          if (ch === "{" && depth === arrayDepth) elementStart = pos;
          depth += 1;
          break;
        case "}":
        case "]":
          depth -= 1;
          if (ch === "}" && depth === arrayDepth && elementStart >= 0) {
            const slice = text.slice(elementStart, pos + 1);
            elementStart = -1;
            try {
              const value = JSON.parse(slice);
              if (value && typeof value === "object" && items.length < maxItems) {
                items.push(value);
                out.push(value);
              }
            } catch {
              // A malformed element is skipped; the final parse decides what it was.
            }
          } else if (ch === "]" && arrayDepth !== -1 && depth === arrayDepth - 1) {
            arrayDepth = -2; // the array closed: read it once, never re-enter
          }
          if (depth <= 0) {
            // The root object closed. Without the array it was not the reply; start over.
            const found = arrayDepth !== -1;
            reset();
            if (found) arrayDepth = -2;
          }
          break;
        default:
          break;
      }
    }
    // Keep memory bounded: nothing before the open element (or the scan point) is needed.
    const keepFrom = elementStart >= 0 ? elementStart : pos;
    if (keepFrom > 4096) {
      text = text.slice(keepFrom);
      pos -= keepFrom;
      if (elementStart >= 0) elementStart -= keepFrom;
    }
    return out;
  }

  return {
    push(chunk: string) {
      if (!chunk || arrayDepth === -2) return [];
      text += chunk;
      return scan();
    },
    get items() {
      return items;
    },
  };
}
