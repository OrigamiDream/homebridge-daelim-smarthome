import * as https from "node:https";
import {LoggerBase} from "../utils";
import {Logging} from "homebridge";
import {OnePassConfig, OnePassCredentials} from "../interfaces/smart-elife-onepass-config";

const COMPLEX_LIST_URL = "https://cloud-api.uasis.com/oapi/v2/entry/complex_list?type=daelim";
const DEFAULT_API_PORT = 25204;

// The One Pass web app runs inside the native shell and every request carries these.
// The API rejects the call outright without a matching Origin.
const HTTP_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://webapp.uasis.com",
    "Referer": "https://webapp.uasis.com/",
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
};

interface ComplexEntry {
    name: string
    projectCode: string
    // The Smart eLife `complexKey` for the same complex.
    projectCode2?: string
    domain: string
    ip: string
    port: number
}

export class OnePassAuthError extends Error {
}

// One Pass is a separate service from Smart eLife: it exposes the SIP identities used by
// the interphone. Credentials are short lived - `sipPw` is reissued on every login - so
// they are fetched on demand rather than configured by hand.
export default class OnePassClient {

    private complexes?: ComplexEntry[];

    constructor(private readonly log: Logging | LoggerBase,
                private readonly config: OnePassConfig,
                // Falls back to the Smart eLife login id, which both services share.
                private readonly defaultUserId: () => string) {
    }

    private request(url: string, body?: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const target = new URL(url);
            const payload = body === undefined ? undefined : JSON.stringify(body);
            const request = https.request({
                host: target.hostname,
                port: target.port || 443,
                path: `${target.pathname}${target.search}`,
                method: payload ? "POST" : "GET",
                // The per-complex hosts serve certificates issued for the shared
                // `uasis.com` wildcard but are reached by IP in some complexes.
                rejectUnauthorized: false,
                headers: {
                    ...HTTP_HEADERS,
                    ...(payload ? {"Content-Length": Buffer.byteLength(payload)} : {}),
                },
            }, (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf-8");
                    try {
                        resolve(JSON.parse(text));
                    } catch {
                        reject(new Error(`One Pass returned a non-JSON body: ${text.slice(0, 200)}`));
                    }
                });
            });
            request.on("error", reject);
            if(payload) {
                request.write(payload);
            }
            request.end();
        });
    }

    private async fetchComplexes(): Promise<ComplexEntry[]> {
        if(this.complexes) {
            return this.complexes;
        }
        const response = await this.request(COMPLEX_LIST_URL);
        const list = response["complexList"];
        if(!Array.isArray(list)) {
            throw new Error("Could not parse the One Pass complex list.");
        }
        this.complexes = list as ComplexEntry[];
        return this.complexes;
    }

    // `host` may be pinned in the config; otherwise the complex is looked up in the One
    // Pass listing. The two services number complexes differently - Smart eLife's `djCd`
    // never equals One Pass's `projectCode` - but Smart eLife's `complexKey` is carried
    // verbatim as One Pass's `projectCode2`, so that is the join. `config.complexCode`,
    // when set, is a One Pass `projectCode` and wins.
    private async resolveHost(complexKey: string): Promise<string> {
        if(this.config.host) {
            return this.config.host;
        }
        const complexes = await this.fetchComplexes();
        const complex = this.config.complexCode
            ? complexes.find((entry) => entry.projectCode === this.config.complexCode)
            : complexes.find((entry) => !!entry.projectCode2 && entry.projectCode2 === complexKey);
        if(!complex) {
            throw new Error(`Complex ${this.config.complexCode || complexKey} is not served by One Pass.`);
        }
        this.log.debug("One Pass complex: %s (%s)", complex.name, complex.domain);
        return complex.domain || complex.ip;
    }

    async signIn(complexKey: string, building: string, unit: string): Promise<OnePassCredentials> {
        const host = await this.resolveHost(complexKey);
        const port = this.config.port || DEFAULT_API_PORT;
        const response = await this.request(`https://${host}:${port}/smart/v1/login`, {
            data: {
                userId: this.config.userId || this.defaultUserId(),
                dong: building,
                ho: unit,
                hoIndex: this.config.hoIndex ?? 0,
                // `pushToken`/`voipToken` are deliberately omitted rather than sent empty.
                // The app supplies them to register for VoIP wake-ups, so blanking them
                // risks clearing the registration the phone app depends on. The server
                // issues SIP credentials either way.
                osType: "ios",
            },
        });
        const status = response?.["result"]?.["status"];
        if(status !== "Ok") {
            const message = response?.["result"]?.["message"] || "unknown error";
            throw new OnePassAuthError(`One Pass sign-in failed (${status}): ${message}`);
        }

        const data = response["data"];
        if(!data?.["sipUsed"] || !data?.["sipId"] || !data?.["sipPw"]) {
            throw new OnePassAuthError("One Pass sign-in succeeded but the household has no SIP line.");
        }
        return {
            sipId: data["sipId"],
            sipPw: data["sipPw"],
            sipDomain: data["sipDomain"],
            sipPort: parseInt(data["sipPort"], 10) || 5061,
            sipProtocol: data["sipProtocol"] || "tls",
            wallpadSipId: data["wallpadSipId"],
        };
    }
}
