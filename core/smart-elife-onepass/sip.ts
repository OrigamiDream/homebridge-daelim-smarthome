import * as crypto from "crypto";

export interface SipMessage {
    start: string
    headers: Record<string, string>
    body: string
    statusCode?: number
    reason?: string
}

export interface SdpMedia {
    port: number
    address?: string
    payloads: string[]
    rtpmap: Record<string, string>
    fmtp: Record<string, string>
}

export interface SdpAnswer {
    address?: string
    media: Record<string, SdpMedia>
}

export interface DigestChallenge {
    realm: string
    nonce: string
    opaque?: string
    qop?: string
    algorithm?: string
}

export function randomToken(length: number): string {
    return crypto.randomBytes(length * 2)
        .toString("base64")
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(0, length);
}

export function randomBranch(): string {
    return `z9hG4bK${randomToken(10)}`;
}

// RFC 8760 added SHA-256 alongside the original MD5.
// The answer has to be hashed with the algorithm the challenge named,
// because a server that asked for one rejects an answer built with the other.
const DIGEST_ALGORITHMS: Record<string, string> = {
    "MD5": "md5",
    "SHA-256": "sha256",
    "SHA256": "sha256",
};

// Everything outside that table is refused rather than approximated.
// The `-sess` variants fold the nonces into ha1,
// and `SHA-512-256` is a different hash altogether,
// so answering any of them with MD5 produces a response the server rejects -
// and a rejection reads as bad credentials,
// which sends the caller round the sign-in-and-retry loop
// instead of saying what is actually unsupported.
function digestOf(algorithm?: string): {name: string, hash: (value: string) => string} {
    const requested = (algorithm || "MD5").trim();
    const hash = DIGEST_ALGORITHMS[requested.toUpperCase()];
    if(!hash) {
        throw new Error(`The One Pass PBX asked for a digest algorithm we do not implement: ${requested}`);
    }
    return {
        name: requested,
        hash: (value: string) => crypto.createHash(hash).update(value).digest("hex"),
    };
}

export function parseMessage(raw: string): SipMessage {
    const separator = raw.indexOf("\r\n\r\n");
    const head = separator < 0 ? raw : raw.slice(0, separator);
    const body = separator < 0 ? "" : raw.slice(separator + 4);
    const lines = head.split("\r\n");
    const start = lines.shift() || "";
    const headers: Record<string, string> = {};
    for(const line of lines) {
        const colon = line.indexOf(":");
        if(colon < 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        // Repeated headers (Supported, Via, ...) are folded the way RFC 3261 allows.
        headers[name] = headers[name] === undefined ? value : `${headers[name]},${value}`;
    }
    const status = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/.exec(start);
    return {
        start, headers, body,
        statusCode: status ? parseInt(status[1], 10) : undefined,
        reason: status ? status[2] : undefined,
    };
}

export function parseChallenge(header?: string): DigestChallenge | undefined {
    if(!header) {
        return undefined;
    }
    const values: Record<string, string> = {};
    const body = header.replace(/^\s*Digest\s+/i, "");
    const pattern = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
    let match;
    while((match = pattern.exec(body)) !== null) {
        values[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3];
    }
    if(!values["realm"] || !values["nonce"]) {
        return undefined;
    }
    return {
        realm: values["realm"],
        nonce: values["nonce"],
        opaque: values["opaque"],
        qop: values["qop"],
        algorithm: values["algorithm"],
    };
}

export function buildAuthorization(challenge: DigestChallenge,
                                   username: string,
                                   password: string,
                                   method: string,
                                   uri: string): string {
    // Asterisk always offers qop="auth"; the qop-less branch is kept for older PBXs.
    // A challenge that names qop values expects one of them back,
    // and `auth-int` additionally hashes the request body, which this does not do,
    // so an offer without `auth` in it cannot be answered here.
    // Falling through to the qop-less form would look like a wrong password.
    const offered = challenge.qop?.split(",").map((value) => value.trim()).filter(Boolean);
    if(offered?.length && !offered.includes("auth")) {
        throw new Error(`The One Pass PBX asked for a digest qop we do not implement: ${challenge.qop}`);
    }
    const qop = offered?.includes("auth") ? "auth" : undefined;
    const cnonce = randomToken(16);
    const nc = "00000001";
    const digest = digestOf(challenge.algorithm);
    const ha1 = digest.hash(`${username}:${challenge.realm}:${password}`);
    const ha2 = digest.hash(`${method}:${uri}`);
    const response = qop
        ? digest.hash(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
        : digest.hash(`${ha1}:${challenge.nonce}:${ha2}`);

    const parts = [
        `username="${username}"`,
        `realm="${challenge.realm}"`,
        `nonce="${challenge.nonce}"`,
        ...(challenge.opaque ? [`opaque="${challenge.opaque}"`] : []),
        `algorithm=${digest.name}`,
        ...(qop ? [`qop="${qop}"`] : []),
        `uri="${uri}"`,
        `response="${response}"`,
        ...(qop ? [`cnonce="${cnonce}"`, `nc=${nc}`] : []),
    ];
    return `Digest ${parts.join(", ")}`;
}

export function parseTag(header?: string): string | undefined {
    return /;tag=([^;\s]+)/.exec(header || "")?.[1];
}

export function parseContactUri(header?: string): string | undefined {
    return /<([^>]+)>/.exec(header || "")?.[1];
}

export function parseSdp(body: string): SdpAnswer {
    const answer: SdpAnswer = {media: {}};
    let current: string | undefined;
    for(const line of body.split(/\r?\n/)) {
        if(line.startsWith("c=IN IP4 ")) {
            const address = line.slice("c=IN IP4 ".length).trim();
            if(current) {
                answer.media[current].address = address;
            } else {
                answer.address = address;
            }
        } else if(line.startsWith("m=")) {
            const fields = line.slice(2).trim().split(/\s+/);
            current = fields[0];
            answer.media[current] = {
                port: parseInt(fields[1], 10),
                payloads: fields.slice(3),
                rtpmap: {},
                fmtp: {},
            };
        } else if(current && line.startsWith("a=rtpmap:")) {
            const match = /^a=rtpmap:(\d+)\s+([^/]+)\//.exec(line);
            if(match) {
                answer.media[current].rtpmap[match[1]] = match[2];
            }
        } else if(current && line.startsWith("a=fmtp:")) {
            const match = /^a=fmtp:(\d+)\s+(.+)$/.exec(line);
            if(match) {
                answer.media[current].fmtp[match[1]] = match[2].trim();
            }
        }
    }
    for(const media of Object.values(answer.media)) {
        media.address = media.address || answer.address;
    }
    return answer;
}

// Mirrors the offer the One Pass app makes.
// Narrowing it (audio=inactive, video=recvonly) makes the PBX answer 488,
// so the full sendrecv offer has to go out,
// even though we only ever consume the video stream.
export function buildOffer(localAddress: string, audioPort: number, videoPort: number): string {
    const origin = Date.now();
    return [
        "v=0",
        `o=cvent-sip ${origin} ${origin} IN IP4 ${localAddress}`,
        "s=-",
        `c=IN IP4 ${localAddress}`,
        "t=0 0",
        `m=audio ${audioPort} RTP/AVP 0 8 101`,
        "a=ptime:20",
        "a=minptime:20",
        "a=maxptime:20",
        "a=silenceSupp:off - - - -",
        "a=rtpmap:0 PCMU/8000/1",
        "a=rtpmap:8 PCMA/8000/1",
        "a=rtpmap:101 telephone-event/8000/1",
        "a=fmtp:101 0-16",
        "a=sendrecv",
        `m=video ${videoPort} RTP/AVP 105`,
        "a=framerate:25.0",
        "a=rtpmap:105 H264/90000",
        "a=sendrecv",
        "",
    ].join("\r\n");
}

export function buildRequest(startLine: string, headers: string[], body: string = ""): string {
    return [
        startLine,
        ...headers,
        `Content-Length: ${Buffer.byteLength(body)}`,
        "",
        body,
    ].join("\r\n");
}
