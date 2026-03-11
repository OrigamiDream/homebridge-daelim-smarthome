export function findJsStringProp(src: string, prop: string): string | undefined {
    const re = new RegExp(
        String.raw`(?:^|[{\s,])["']?${escapeRe(prop)}["']?\s*:\s*(["'])(?<val>(?:\\.|(?!\1)[\s\S])*)\1`,
        "m",
    );

    const m = src.match(re);
    if (!m) return undefined;

    const raw = (m.groups?.val ?? "").trim();
    return unescapeJsString(raw);
}

export function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function tryParseAssignmentAt(s: string, startIdx: number) {
    let i = startIdx;

    // Skip identifier tail (in case we matched in a longer token)
    while (i < s.length && /[A-Za-z0-9_$]/.test(s[i])) i++;

    // Skip whitespace/comments then look for '='
    i = skipWsAndComments(s, i);
    if (s[i] !== "=") {
        // It might be in a comparison or something else; give up for this occurrence.
        return null;
    }
    i++;
    i = skipWsAndComments(s, i);

    const ch = s[i];
    if (ch === "'" || ch === '"' || ch === "`") {
        const q = parseQuotedJsStringLiteral(s, i);
        if (!q) return null;
        return { jsonText: unescapeJsString(q.raw) };
    }

    if (ch === "[" || ch === "{") {
        const j = parseBalancedJsonLike(s, i);
        if (!j) return null;
        return { jsonText: j.raw };
    }

    return null;
}

export function skipWsAndComments(s: string, i: number) {
    while (i < s.length) {
        // whitespace
        while (i < s.length && /\s/.test(s[i])) i++;
        if (i >= s.length) break;

        // line comment
        if (s[i] === "/" && s[i + 1] === "/") {
            i += 2;
            while (i < s.length && s[i] !== "\n") i++;
            continue;
        }

        // block comment
        if (s[i] === "/" && s[i + 1] === "*") {
            i += 2;
            while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
            i = Math.min(s.length, i + 2);
            continue;
        }

        break;
    }
    return i;
}

export function parseQuotedJsStringLiteral(s: string, i: number) {
    const quote = s[i];
    i++; // after opening quote
    let raw = "";
    for (; i < s.length; i++) {
        const c = s[i];
        if (c === "\\") {
            // keep escape + next char in raw; unescape later
            raw += c;
            if (i + 1 < s.length) raw += s[++i];
            continue;
        }
        if (c === quote) {
            return { raw, end: i + 1 };
        }
        raw += c;
    }
    return null; // unterminated
}

// Handles JSON text assigned directly: _deviceListByType = [ ... ] or { ... }
export function parseBalancedJsonLike(s: string, i: number) {
    const open = s[i];
    const close = open === "[" ? "]" : "}";
    let depth = 0;

    let inStr = false;
    let strQuote = null;
    let escaped = false;

    const start = i;
    for (; i < s.length; i++) {
        const c = s[i];

        if (inStr) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (c === "\\") {
                escaped = true;
                continue;
            }
            if (c === strQuote) {
                inStr = false;
                strQuote = null;
            }
            continue;
        }

        if (c === '"' || c === "'") {
            inStr = true;
            strQuote = c;
            continue;
        }

        if (c === open) depth++;
        else if (c === close) {
            depth--;
            if (depth === 0) {
                return { raw: s.slice(start, i + 1), end: i + 1 };
            }
        }
    }
    return null; // unbalanced
}

/**
 * Minimal JS string-literal unescaper for content inside quotes.
 * Supports: \\ \n \r \t \' \" \` \/ \xNN \uNNNN \u{...}
 */
export function unescapeJsString(s: string) {
    let out = "";
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c !== "\\") {
            out += c;
            continue;
        }

        const n = s[++i];
        if (n === undefined) break;

        switch (n) {
            case "\\": out += "\\"; break;
            case "n": out += "\n"; break;
            case "r": out += "\r"; break;
            case "t": out += "\t"; break;
            case "'": out += "'"; break;
            case '"': out += '"'; break;
            case "`": out += "`"; break;
            case "/": out += "/"; break;
            case "x": {
                const hex = s.slice(i + 1, i + 3);
                if (/^[0-9a-fA-F]{2}$/.test(hex)) {
                    out += String.fromCharCode(parseInt(hex, 16));
                    i += 2;
                } else out += "x";
                break;
            }
            case "u": {
                if (s[i + 1] === "{") {
                    const end = s.indexOf("}", i + 2);
                    const hex = end === -1 ? "" : s.slice(i + 2, end);
                    if (hex && /^[0-9a-fA-F]+$/.test(hex)) {
                        out += String.fromCodePoint(parseInt(hex, 16));
                        i = end;
                    } else out += "u";
                } else {
                    const hex = s.slice(i + 1, i + 5);
                    if (/^[0-9a-fA-F]{4}$/.test(hex)) {
                        out += String.fromCharCode(parseInt(hex, 16));
                        i += 4;
                    } else out += "u";
                }
                break;
            }
            default:
                out += n;
        }
    }
    return out;
}
