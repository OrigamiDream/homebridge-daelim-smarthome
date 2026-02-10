/**
 * WallPad version parser (heuristic, dependency-free).
 *
 * Goal: infer the current WallPad API/UI version (ex: "3.0", "4.0") from one or more
 * HTML documents produced by the WallPad web UI.
 *
 * Why heuristics:
 * - The server-side templates often inline the current version into JavaScript, sometimes
 *   as a variable assignment (best case), and sometimes by rendering a template expression
 *   into literal-vs-literal comparisons (ex: `'3.0' !== '3.0'`).
 * - Markup/JS can move around over time, so we avoid brittle selectors and rely on
 *   multiple independent signals across multiple pages.
 */

export type WallPadVersion = `${number}.${number}` | `${number}.${number}.${number}` | string;

export const WALLPAD_VERSION_3_0 = "3.0" as const;
export const WALLPAD_VERSION_4_0 = "4.0" as const;

export interface HTMLCandidate {
    /**
     * Human-readable identifier for debugging (usually a URL path or a file name).
     */
    name: string;
    html: string;
}

export interface WallPadVersionEvidence {
    candidateName: string;
    /**
     * What we matched (kept short to avoid leaking large HTML snippets to logs).
     */
    matchedBy: string;
    version: WallPadVersion;
    score: number;
}

export interface WallPadVersionParseResult {
    /**
     * Best guess. `null` if no usable signal was found.
     */
    version: WallPadVersion | null;
    /**
     * 0..1, relative confidence based on accumulated evidence.
     */
    confidence: number;
    /**
     * Evidence entries used to determine the version (sorted by score desc).
     */
    evidence: WallPadVersionEvidence[];
    /**
     * Aggregate scores per version (useful for debugging).
     */
    scoreByVersion: Record<string, number>;
}

export interface WallPadCapabilities {
    wallpadVersion: WallPadVersion | null;

    /**
     * 4.0-only in observed UI (`indoorAir.initData()` guarded by `"4.0" === cmfApiVer` patterns).
     */
    supportsIndoorAirQuality: boolean;

    /**
     * Observed: max user modes is 12 for 3.0, 18 for 4.0 (see `cmfApiVer === "4.0" ? 18 : 12`).
     */
    maxUserModes: number;

    /**
     * Observed: heat reservation UI differs.
     * - 3.0: single hour (`reserve_hour`)
     * - 4.0: start/end hours (`reserve_hour_start`/`reserve_hour_end`)
     *
     * We expose a capability flag rather than encoding request shapes here.
     */
    supportsHeaterReservationRange: boolean;
}

function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
}

function execAll(text: string, re: RegExp): RegExpExecArray[] {
    // Older TS/lib targets may not include String.prototype.matchAll.
    // This is a safe replacement that iterates via RegExp#exec.
    // Avoid RegExp.prototype.flags to support older lib definitions.
    let flags = "";
    if (re.global) flags += "g";
    if (re.ignoreCase) flags += "i";
    if (re.multiline) flags += "m";
    if ((re as unknown as { dotAll?: boolean }).dotAll) flags += "s";
    if (re.unicode) flags += "u";
    if (re.sticky) flags += "y";

    if (!re.global) flags = `g${flags}`; // ensure global matching

    const r = re.global ? re : new RegExp(re.source, flags);
    r.lastIndex = 0;

    const out: RegExpExecArray[] = [];
    while (true) {
        const m = r.exec(text);
        if (!m) break;
        out.push(m);
        // Avoid infinite loops on zero-length matches.
        if (m[0] === "") r.lastIndex++;
    }
    return out;
}

function normalizeVersion(v: string): WallPadVersion {
    // Keep as-is, but trim whitespace and quotes already removed by regex groups.
    return v.trim();
}

function addEvidence(
    out: WallPadVersionEvidence[],
    candidateName: string,
    matchedBy: string,
    versionRaw: string,
    score: number,
) {
    const version = normalizeVersion(versionRaw);
    if (!version) return;
    out.push({ candidateName, matchedBy, version, score });
}

/**
 * Extract evidence for version values from a single HTML document.
 */
export function collectWallpadVersionEvidenceFromHtml(
    candidateName: string,
    html: string,
): WallPadVersionEvidence[] {
    const evidence: WallPadVersionEvidence[] = [];
    if (!html) return evidence;

    // 1) Strongest: explicit assignment to a well-known variable.
    // Observed in multiple pages: `const cmfApiVer = "3.0";`
    {
        const re =
            /\b(?:const|let|var)\s+(cmfApiVer|cmfApiVersion|cmf_api_ver|cmfVer|apiVer|apiVersion)\s*=\s*(['"])(\d+(?:\.\d+)+)\2\s*;?/g;
        for (const m of execAll(html, re)) {
            const varName = m[1];
            const ver = m[3];
            addEvidence(
                evidence,
                candidateName,
                `js-var-assign:${varName}`,
                ver,
                120,
            );
        }
    }

    // 2) NOTE: We intentionally do NOT use comparisons against `cmfApiVer` as positive evidence.
    // `if ("4.0" === cmfApiVer)` only tells us the code has a 4.0 branch, not that the current
    // WallPad is 4.0. Rely on assignments or rendered literal-vs-literal comparisons instead.

    // 3) Medium/strong: rendered template comparisons that turned into literal-vs-literal.
    // Examples observed in fixtures:
    // - `if ('3.0' === '3.0') { ... }`
    // - `if ('3.0' !== '3.0') { ... }`
    // - `"3.0" == '4.0' ? '999' : '10'`
    //
    // In these cases, one side is typically the "current version" rendered by the server.
    // If both sides are equal, that value is very likely the current version.
    // If one side is "4.0" and the other isn't, the other is very likely the current version
    // because most gating checks compare against "4.0".
    {
        const re =
            /(['"])(\d+(?:\.\d+)+)\1\s*(===|==|!==|!=)\s*(['"])(\d+(?:\.\d+)+)\4/g;
        for (const m of execAll(html, re)) {
            const left = m[2];
            const op = m[3];
            const right = m[5];

            if (left === right) {
                addEvidence(
                    evidence,
                    candidateName,
                    `literal-vs-literal:${op}:same`,
                    left,
                    70,
                );
                continue;
            }

            // Special-case "4.0" gating checks (most common in observed pages).
            // If either side is 4.0, treat the opposite side as the likely current version.
            if (left === WALLPAD_VERSION_4_0 && right !== WALLPAD_VERSION_4_0) {
                addEvidence(
                    evidence,
                    candidateName,
                    `literal-vs-literal:${op}:not-4.0`,
                    right,
                    40,
                );
                continue;
            }
            if (right === WALLPAD_VERSION_4_0 && left !== WALLPAD_VERSION_4_0) {
                addEvidence(
                    evidence,
                    candidateName,
                    `literal-vs-literal:${op}:not-4.0`,
                    left,
                    40,
                );
                continue;
            }

            // Generic mismatch: weak evidence. Keep it (sometimes still helpful in aggregate),
            // but don't overweight it.
            addEvidence(
                evidence,
                candidateName,
                `literal-vs-literal:${op}:mismatch`,
                left,
                6,
            );
            addEvidence(
                evidence,
                candidateName,
                `literal-vs-literal:${op}:mismatch`,
                right,
                6,
            );
        }
    }

    // 4) Weak: hints in URLs/asset versioning patterns like `.../wallpad/3.0/...` or `?ver=3.0`.
    // Not currently observed in fixtures, but cheap and safe.
    {
        const re =
            /(?:\bwallpad\b|(?:\bapi\b|\bcmf\b)\s*(?:ver|version)\b|[?&](?:ver|version)=)\D*(\d+(?:\.\d+)+)/gi;
        for (const m of execAll(html, re)) {
            addEvidence(evidence, candidateName, "weak-text-hint", m[1], 4);
        }
    }

    return evidence;
}

export function parseWallPadVersionFromHtmlCandidates(
    candidates: HTMLCandidate[],
): WallPadVersionParseResult {
    const allEvidence: WallPadVersionEvidence[] = [];

    for (const c of candidates) {
        if (!c || typeof c.html !== "string") continue;
        allEvidence.push(...collectWallpadVersionEvidenceFromHtml(c.name, c.html));
    }

    const scoreByVersion: Record<string, number> = {};
    for (const ev of allEvidence) {
        if (ev.score <= 0) continue;
        scoreByVersion[ev.version] = (scoreByVersion[ev.version] ?? 0) + ev.score;
    }

    const versions = Object.keys(scoreByVersion);
    if (versions.length === 0) {
        return {
            version: null,
            confidence: 0,
            evidence: [],
            scoreByVersion: {},
        };
    }

    versions.sort((a, b) => (scoreByVersion[b] ?? 0) - (scoreByVersion[a] ?? 0));
    const best = versions[0]!;
    const bestScore = scoreByVersion[best] ?? 0;
    const sum = versions.reduce((acc, v) => acc + (scoreByVersion[v] ?? 0), 0);

    // Confidence is relative to total evidence, with a small boost if we have a strong assignment signal.
    const hasStrongAssign = allEvidence.some(
        (e) => e.version === best && e.matchedBy.startsWith("js-var-assign:") && e.score >= 100,
    );
    const base = sum > 0 ? bestScore / sum : 0;
    const confidence = clamp01(base + (hasStrongAssign ? 0.15 : 0));

    const evidence = allEvidence
        .slice()
        .sort((a, b) => b.score - a.score)
        .slice(0, 100); // keep it bounded

    return {
        version: best,
        confidence,
        evidence,
        scoreByVersion,
    };
}

export function getWallPadCapabilities(
    version: WallPadVersion | null,
): WallPadCapabilities {
    const v = (version ?? "").trim();
    const is4 = v === WALLPAD_VERSION_4_0;

    // Default to conservative behavior for unknown versions.
    if (!v) {
        return {
            wallpadVersion: null,
            supportsIndoorAirQuality: false,
            maxUserModes: 12,
            supportsHeaterReservationRange: false,
        };
    }

    // Based on observed UI logic across fixtures.
    return {
        wallpadVersion: version,
        supportsIndoorAirQuality: is4,
        maxUserModes: is4 ? 18 : 12,
        supportsHeaterReservationRange: is4,
    };
}
