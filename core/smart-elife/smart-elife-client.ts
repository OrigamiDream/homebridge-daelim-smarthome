import fetch, {Response} from "node-fetch";
import {LoggerBase, Utils} from "../utils";
import {
    ControlQueryCategory,
    DATA4_PUSH_TYPES,
    Device,
    DeviceType,
    PushItem,
    PushItemKind,
    PushType,
    SmartELifeConfig,
    TITLE_PUSH_TYPES
} from "../interfaces/smart-elife-config";
import {ClientResponseCode} from "./responses";
import PushReceiver from "@eneris/push-receiver";
import {Logging} from "homebridge";
import {SmartELifeComplex, SmartELifeUserInfo} from "../interfaces/smart-elife-complex";
import WebSocketScheduler from "./ws-scheduler";
import {parseWebSocketCredentials, WebSocketCredentials} from "./parsers/ws-creds-parsers";
import {parseDeviceList} from "./parsers/device-parsers";
import {HTMLCandidate, parseWallPadVersionFromHtmlCandidates, WALLPAD_VERSION_3_0} from "./parsers/version-parsers";
import {EXTERIOR_ELEVATOR_DEVICE} from "../../homebridge/accessories/smart-elife/elevator";
import {createElevatorStatusRequest} from "./elevator-protocol";
import {setInterval} from "timers";
import * as https from "node:https";
import * as dns from "node:dns";
import * as net from "node:net";

export interface ListenerError {
    code: number
    message?: string
}

export interface ListenerMetadata {
    /** WebSocket action name, e.g. `elevate_call`. Absent on a polled report. */
    action?: string

    /**
     * Number drawn from the client's observation counter
     * at the moment this observation was *requested*.
     * Commands draw from the same counter,
     * so a report numbered below a command cannot say anything about that command -
     * the poll it came from was already in the air when the command was sent.
     *
     * Where "requested" is, per path: a polled page draws its number before the HTTP
     * request leaves; the answer to a WebSocket status query wears the number drawn
     * when that query was sent (`sendStatusQuery`); an asynchronous `event_*` push is
     * never requested, so its number is drawn at frame receipt.
     */
    observedSeq: number

    /**
     * Whether this report is the whole of its device type rather than a single device.
     * A polled page and the answer to a query both are;
     * an `event_*` push carries the one device that changed.
     */
    completeSnapshot: boolean

    /** Wall clock at the same instant. For the log, and never compared - see `observedSeq`. */
    observedAt: number
}

export type Listener = (data: any | undefined, error: ListenerError, metadata: ListenerMetadata) => void;
// A listener may run asynchronously - the camera one fetches the visitor snapshot
// over the network - so the return type has to admit a promise
// for the dispatcher to be able to catch its rejection.
export type PushListener = (title: string | undefined, message: string | undefined) => void | Promise<void>;

interface ListenerInfo {
    deviceType: DeviceType
    listener: Listener
}

interface PushListenerInfo {
    pushType: PushType
    listener: PushListener
}

/**
 * Which household a device report belongs to.
 *
 * `OWN` and `FOREIGN` are the two answers; the other two say the question
 * could not be answered. `UNKNOWN` means there was nothing to hold the list
 * against - a first-time setup - and `INVALID` means the markup gave the
 * parser nothing, so the question could not even be posed.
 *
 * String-valued so the wizard can carry it to the frontend as an event reason.
 */
export enum HouseholdAttribution {
    OWN = "own",
    FOREIGN = "foreign",
    UNKNOWN = "unknown",
    INVALID = "invalid",
}

/** What `fetchDevices()` found, and whose household it judged the list to be. */
export interface DeviceFetchResult {
    household: HouseholdAttribution
    /** Empty when the attribution is `FOREIGN` or `INVALID` - failure is not an empty household. */
    devices: Device[]
}

/**
 * A `/main/home.do` that was held against the configuration and kept.
 * The stamp rides with the markup rather than being taken where it is parsed:
 * the polled page is already seconds old by then,
 * and what decides whether a report may be believed
 * is when it was asked for, not when it was read.
 */
interface RenderedPage {
    html: string
    deviceList: any[] | undefined

    /**
     * Whose household the devices this page listed belong to.
     * The session keys it carries are ours either way - measured - so the credentials
     * parser reads the page regardless, while everything about the devices does not.
     */
    household: HouseholdAttribution

    observedSeq: number
    observedAt: number
}

const POLLING_INTERVAL_MILLISECONDS = 30 * 1000;
const DEVICE_CONTROL_ALL_TIMEOUT_MILLISECONDS = 30 * 1000;

export default class SmartELifeClient {

    // Some networks (notably IPv6-only/NAT64) can resolve this host to both IPv4 and IPv6,
    // while only one family is actually reachable. When we see low-level connect errors
    // (EHOSTUNREACH/ENETUNREACH/etc), retry once with the opposite IP family.
    private static readonly HTTPS_AGENT_DEFAULT = new https.Agent({ keepAlive: true });

    private readonly httpBody: {[key: string]: string};
    private readonly httpHeaders: Record<string, string> = {
        "User-Agent": Utils.SMART_ELIFE_USER_AGENT,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Site": "same-origin",
        "Accept-Language": "ko-KR,ko;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Sec-Fetch-Mode": "cors",
        "Content-Type": "application/json;charset=UTF-8",
        "Origin": "https://smartelife.apt.co.kr",
        "Connection": "keep-alive",
        "Sec-Fetch-Dest": "empty",
    }
    private csrfToken?: string;
    private attemptsCsrfIssuing: number = 0;
    private jsessionId?: string;

    private complex?: SmartELifeComplex;
    private userInfo?: SmartELifeUserInfo;
    private accessToken?: string;

    // WallPad authorization temporary keys
    private wsCredentials?: WebSocketCredentials;
    private renderedPage?: RenderedPage;

    /**
     * Draws the numbers that order observations against commands.
     * A wall clock cannot: a Raspberry Pi has no RTC and steps its clock
     * once the network comes up, and two events inside one millisecond
     * are indistinguishable by it either way.
     */
    private observationCounter = 0;

    /**
     * Device types the last accepted page carried.
     * Learned rather than listed, so that a household whose WallPad answers for
     * something this plugin has never seen is asked about it all the same.
     */
    private renderedDeviceTypes: DeviceType[] = [];

    /**
     * Numbers drawn for status queries whose answers have not arrived yet, per type.
     * FIFO: the socket answers queries of one type in the order they were sent,
     * so the head of the queue always belongs to the next answer.
     * Cleared on reconnect - see `onOpen`.
     */
    private readonly pendingStatusQueries = new Map<DeviceType, number[]>();

    /** How many reports were declined as another household's, for the debug log. */
    private declinedForeignReports = 0;

    /** Whether the log has already said that there is nothing to hold a report against. */
    private reportedUncomparableDeviceList = false;

    /** See `lightDetails()`. Refilled by every `fetchDevices()`. */
    private renderedLightDetails: { deviceId: string, name: string, room: string, value: string }[] = [];

    private readonly ws?: WebSocketScheduler;
    private readonly listeners: ListenerInfo[] = [];
    private readonly pushListeners: PushListenerInfo[] = [];

    private readonly baseUrl = Utils.SMART_ELIFE_BASE_URL;
    private readonly key = Utils.SMART_ELIFE_AES_KEY;
    private readonly iv = Utils.SMART_ELIFE_AES_IV;

    constructor(private readonly log: Logging | LoggerBase,
                private readonly config: SmartELifeConfig,
                private readonly push?: PushReceiver,
                useWebSocket: boolean = true) {
        this.httpBody = {
            "input_dv_make_info": "Apple",
            "input_dv_model_info": "iPhone18,4",
            "input_dv_osver_info": "26.2.1",
            "input_acc_os_info": "ios",
            "input_push_token": this.push?.fcmToken ?? "",
            "input_dv_uuid": Utils.generateUUID(this.config.username),
        };
        if(useWebSocket) {
            this.ws = this.createWebSocketScheduler();
        }
    }

    private createWebSocketScheduler() {
        return new WebSocketScheduler(this, this.baseUrl, this.log, {
            getJSessionId(client: SmartELifeClient): string | undefined {
                return client.jsessionId;
            },
            async onRefresh(client: SmartELifeClient): Promise<ClientResponseCode> {
                return await client.signIn();
            },
            async onResilient(client: SmartELifeClient): Promise<ClientResponseCode> {
                if(!client.accessToken) {
                    return await client.signIn();
                }
                return ClientResponseCode.SUCCESS;
            },
            async onOpen(client: SmartELifeClient) {
                // Queries in flight on the previous connection will never be answered here,
                // and their numbers must not attach to this connection's answers.
                client.pendingStatusQueries.clear();
                await client.requestElevatorStatus();
            },
            async onMessage(client: SmartELifeClient, json: any) {
                // Stamped where the frame is received - the fallback for everything
                // that is not the answer to a query this client sent.
                let observedSeq = client.takeObservedSeq();
                const observedAt = Date.now();

                const header = json["header"];
                const action = json["action"];

                let status = "000";
                let deviceTypeString, message;
                // A query answers with every device of the type it was asked about.
                // An `event_*` push carries the one device that changed,
                // and publishing from it would mix what just arrived with what is still stale.
                let completeSnapshot = false;
                if(!!header) {
                    deviceTypeString = header["type"];
                    if(header["command"] === "control_response")
                        return;

                    completeSnapshot = true;
                    if(json["result"]) {
                        status = json["result"]["status"];
                        message = json["result"]["message"];
                    }
                } else if(!!action && action.startsWith("event_")) {
                    deviceTypeString = action.slice("event_".length);
                } else if(!!action && (action.startsWith("elevator_call_") || action === "elevate_call")) {
                    // `elevator_call_request` reports whether a call is progressing, while
                    // `elevate_call` is the arrival event. Preserve the action in listener metadata
                    // so the accessory does not mistake an idle status snapshot for an arrival.
                    deviceTypeString = "elevator";
                } else {
                    client.log.warn("Unexpected message format: %s", JSON.stringify(json));
                    return;
                }
                const deviceType = deviceTypeString as DeviceType || DeviceType.UNKNOWN;
                if(deviceType === DeviceType.UNKNOWN)
                    client.log.warn("Unknown device type: %s", deviceTypeString);

                if(completeSnapshot) {
                    // The answer to a query wears the number drawn when that query left,
                    // not the receive stamp - a command sent while the query was in flight
                    // must rank above the answer, or a stale report slips past the filters
                    // built on this ordering. Consumed even when the frame is declined
                    // below, so the per-type FIFO stays aligned with the answers.
                    const queued = client.pendingStatusQueries.get(deviceType)?.shift();
                    if(queued !== undefined) {
                        observedSeq = queued;
                    }
                }

                // The socket carries the same misattribution the rendered page does.
                // A day of measurement found 91 answers that listed another household's devices.
                if(!client.isOwnHouseholdFrame(json["data"], completeSnapshot, deviceType)) {
                    client.declinedForeignReports += 1;
                    client.log.debug("Ignoring a %s frame that is not this household's " +
                        "(%d report(s) declined so far).", deviceTypeString, client.declinedForeignReports);
                    return;
                }

                for(const info of client.listeners) {
                    if(info.deviceType === deviceType) {
                        info.listener(json["data"], { code: Number(status), message },
                            { action, observedSeq, observedAt, completeSnapshot });
                    }
                }
            }
        });
    }

    public static createForUI(log: Logging | LoggerBase, config: SmartELifeConfig) {
        return new SmartELifeClient(log, config, undefined, false);
    }

    public static create(log: Logging | LoggerBase, config: SmartELifeConfig, push: PushReceiver) {
        return new SmartELifeClient(log, config, push, true);
    }

    private applySessionCookie(options: any) {
        if(!this.jsessionId) {
            return;
        }
        const headers = options["headers"] || {};
        const cookie = headers["Cookie"] || headers["cookie"];
        const jsess = `JSESSIONID=${this.jsessionId}`;
        if(!cookie) {
            headers["Cookie"] = jsess;
        } else if(typeof cookie === "string" && !cookie.includes("JSESSIONID=")) {
            headers["Cookie"] = `${cookie}; ${jsess}`;
        }
        options["headers"] = headers;
    }

    private updateSessionCookieFromResponse(response: Response) {
        // Cookie header access differs by fetch implementation.
        // - node-fetch v2: response.headers.raw()['set-cookie']
        // - undici / Node 18+ fetch: response.headers.getSetCookie()
        // - fallback: response.headers.get('set-cookie')

        const headers: any = response.headers as any;

        let setCookies: string[] = [];

        try {
            if(typeof headers?.raw === "function") {
                const raw = headers.raw();
                const v = raw?.["set-cookie"];
                if(Array.isArray(v)) {
                    setCookies = v;
                }
            } else if(typeof headers?.getSetCookie === "function") {
                const v = headers.getSetCookie();
                if(Array.isArray(v)) {
                    setCookies = v;
                }
            } else if(typeof headers?.get === "function") {
                const v = headers.get("set-cookie");
                if(typeof v === "string" && v.length > 0) {
                    // Some implementations merge cookies into a single header value.
                    // Split on comma only when it looks like cookie delimiters.
                    setCookies = v.split(/,(?=\s*[^=;\s]+=[^;]+)/g).map((s: string) => s.trim());
                }
            }
        } catch {
            // Ignore header parsing errors.
            return;
        }

        if(!Array.isArray(setCookies) || setCookies.length === 0) {
            return;
        }

        for(const cookie of setCookies) {
            const match = /^JSESSIONID=([^;]+)/.exec(cookie);
            if(match && match[1]) {
                this.jsessionId = match[1];
                return;
            }
        }
    }

    private static extractNetworkError(e: any): { code?: string, address?: string, port?: number, message?: string } {
        // node-fetch v2 wraps system errors in FetchError, but copies code/address/port to the top-level.
        // Also attempt to read from common nested locations to be defensive.
        const code = e?.code ?? e?.cause?.code ?? e?.err?.code;
        const address = e?.address ?? e?.cause?.address ?? e?.err?.address;
        const port = e?.port ?? e?.cause?.port ?? e?.err?.port;
        const message = e?.message ?? e?.cause?.message ?? e?.err?.message;
        return { code, address, port, message };
    }

    private static isRetriableConnectError(code?: string): boolean {
        // Keep this list tight; we only want to retry when the first attempt likely picked
        // the wrong address family or DNS is temporarily unavailable.
        return [
            "EHOSTUNREACH",
            "ENETUNREACH",
            "EAI_AGAIN",
            "ETIMEDOUT",
            "ECONNRESET",
        ].includes(code || "");
    }

    private async logResolvedAddressesOnce(hostname: string) {
        try {
            const addresses = await dns.promises.lookup(hostname, { all: true });
            const formatted = addresses
                .map(a => `${a.address} (v${a.family})`)
                .join(", ");
            if(formatted.length > 0) {
                this.log.debug(`[DNS] ${hostname} -> ${formatted}`);
            }
        } catch(e: any) {
            const { code, message } = SmartELifeClient.extractNetworkError(e);
            this.log.debug(`[DNS] lookup failed for ${hostname}: ${code || ""} ${message || ""}`.trim());
        }
    }

    private async fetchWithJSessionId(url: string, options: any = {}): Promise<Response> {
        const doFetch = async (overrideFamily?: 4 | 6): Promise<Response> => {
            // Avoid mutating the caller's options object (especially across retries).
            const opts: any = { ...options };
            opts.headers = { ...(options.headers || {}) };

            if(!opts.agent) {
                opts.agent = SmartELifeClient.HTTPS_AGENT_DEFAULT;
            }

            if(!opts.family && overrideFamily) {
                // Forwarded to https.request() by node-fetch; forces DNS resolution and connect() to that IP family.
                opts.family = overrideFamily;
            }

            this.applySessionCookie(opts);
            const response = await fetch(url, opts);
            this.updateSessionCookieFromResponse(response);

            // Debugging purpose.
            let buf = `${opts.method} ${url}\n`;
            const headers = opts.headers || {};
            for(const headerKey in headers) {
                buf += `${headerKey}: ${headers[headerKey]}\n`;
            }
            if(!!opts.body) {
                try {
                    const body = typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
                    buf += `\n${JSON.stringify(body, null, 2)}`;
                } catch {
                    // Non-JSON or unparsable body; avoid throwing in debug logging.
                }
            }
            this.log.debug(buf);

            return response;
        };

        try {
            return await doFetch();
        } catch(e: any) {
            const { code, address, port, message } = SmartELifeClient.extractNetworkError(e);
            if(!SmartELifeClient.isRetriableConnectError(code)) {
                throw e;
            }

            // If the failure happened while connecting to an IPv4 address, retry forcing IPv6 (and vice-versa).
            // This helps on IPv6-only/NAT64 networks where IPv4 is unroutable, or on broken IPv6 networks.
            const u = new URL(url);
            await this.logResolvedAddressesOnce(u.hostname);

            const ipFamily = net.isIP(address || "");
            const retryFamily: 4 | 6 =
                ipFamily === 4 ? 6 :
                4;

            this.log.warn(
                `Network error while requesting ${u.hostname}:${u.port || "443"} (${code}${address ? ` ${address}:${port || ""}` : ""}). Retrying with alternate IP family.`
            );

            try {
                return await doFetch(retryFamily);
            } catch(e2: any) {
                const e2i = SmartELifeClient.extractNetworkError(e2);
                this.log.error(
                    `Request to ${u.hostname}:${u.port || "443"} failed: ${code || ""} ${message || ""} (retry: ${e2i.code || ""} ${e2i.message || ""})`.trim()
                );
                throw e2;
            }
        }
    }

    private async fetchJson(url: string, options: any = {}) {
        // Do not mutate the caller's options object across retries.
        const baseOptions: any = { ...options };
        const baseHeaders: Record<string, string> = { ...(baseOptions.headers || {}) };
        baseOptions.headers = baseHeaders;

        // If the server indicates auth is required (or HTTP error), refresh token/csrf once and retry.
        let needsRetry = false;
        let numAttempts = 0;
        let text;
        do {
            const opts: any = { ...baseOptions, headers: { ...baseHeaders } };
            if(needsRetry) {
                if(numAttempts === 1) {
                    this.log.debug("Could not perform the request (seems token expiration). Retrying immediately.");
                } else if(numAttempts <= 5) {
                    this.log.debug(`Could not perform the request over ${numAttempts} attempts. Retrying within 5 seconds.`);
                    await Utils.sleep(5000);
                } else {
                    throw new Error(`Could not perform the request over ${numAttempts} attempts. Request dropped.`);
                }

                if("_csrf" in opts.headers) {
                    opts.headers["_csrf"] = await this.getCsrfToken(true);
                }
                if("daelim_elife" in opts.headers || "Authorization" in opts.headers) {
                    const response = await this.signIn();
                    if(response !== ClientResponseCode.SUCCESS) {
                        throw new Error(`Could not re-establish authentication.`);
                    }
                    if("daelim_elife" in opts.headers) {
                        opts.headers["daelim_elife"] = this.accessToken;
                    }
                    if("Authorization" in opts.headers) {
                        opts.headers["Authorization"] = this.getAccessToken();
                    }
                }
            }
            const response = await this.fetchWithJSessionId(url, opts);
            text = await response.text();

            needsRetry = !response.ok || response.status !== 200 || text === "requireLoginForAjax" || text === "accountError2";
            if(needsRetry) {
                this.log.debug(`[Error response] ${text}`);
            }
            numAttempts += 1;
        } while(needsRetry);

        const json = Utils.parseJsonSafe(text);

        // Debug purpose.
        this.log.debug(`[Response from ${options.method} ${url}]\n${JSON.stringify(json)}`);

        return json;
    }

    private async fetchCSRFInplace() {
        const url = `${this.baseUrl}/common/nativeToken.ajax`;
        const response = await this.fetchWithJSessionId(url, {
            method: "POST",
            headers: this.httpHeaders,
        });
        if(!response.ok) {
            this.log.error(`Could not fetch CSRF token: ${response.statusText}`);
            return false;
        }
        const json = await response.json();
        const csrfToken = json["value"];
        if(!csrfToken) {
            this.log.error(`No CSRF token in response: ${json}`);
            return false;
        }
        this.csrfToken = csrfToken;
        return true;
    }

    private async getCsrfToken(refresh: boolean = false) {
        if(refresh || !this.csrfToken) {
            while(!(await this.fetchCSRFInplace()) && this.attemptsCsrfIssuing <= 10) {
                this.attemptsCsrfIssuing += 1;
            }
            this.attemptsCsrfIssuing = 0; // invalidate
        }
        if(!this.csrfToken) {
            throw new Error("Could not issue CSRF token even over 10 attempts.");
        }
        return this.csrfToken;
    }

    async signIn(): Promise<ClientResponseCode> {
        const response = await this.fetchJson(`${this.baseUrl}/login.ajax`, {
            method: "POST",
            headers: {
                ...this.httpHeaders,
                "_csrf": await this.getCsrfToken(true),
            },
            body: JSON.stringify({
                ...this.httpBody,
                "input_flag": "login",
                "input_hm_cd": "",
                "input_memb_uid": "",
                "input_version": Utils.SMART_ELIFE_APP_VERSION,
                "input_username": Utils.aes256Base64(this.config.username, this.key, this.iv),
                "input_password": Utils.aes256Base64(this.config.password, this.key, this.iv),
                "input_auto_login": "on",
            }),
        });
        const code = ClientResponseCode.parseResponseCode(response["errCode"]);
        switch(code) {
            case ClientResponseCode.SUCCESS: {
                const homeList = response["homeList"] || [];
                if(homeList.length > 0) {
                    this.log.warn(`You may registered multiple homes. Requires to choose a home: ${JSON.stringify(homeList)}`);
                    return ClientResponseCode.INCOMPLETE_USER_INFO;
                }
                const responseCode = this.updateAuthorizationAndUserInfo(response);
                await this.attemptsParsingWebSocketCredentials();
                return responseCode;
            }
            case ClientResponseCode.UNCERTIFIED_WALLPAD: {
                this.wsCredentials = {
                    userKey: response["userkey"],
                    roomKey: response["roomkey"],
                    accessToken: "",
                }
                this.log.info(`Received user-key = ${this.wsCredentials.userKey}, room-key = ${this.wsCredentials.roomKey} prior to wallpad authorization.`);

                // Ask for preparing the Wallpad authorization.
                const success = await this.requestWallpadAuthorization();
                if(!success) {
                    return ClientResponseCode.WALLPAD_AUTHORIZATION_PREPARATION_FAILED;
                }
                return ClientResponseCode.SUCCESS;
            }
        }
        this.log.warn("Unexpected client response code had been returned: %s", code);
        return code;
    }

    private async attemptsParsingWebSocketCredentials() {
        // Reads the page whichever household its device list belonged to.
        // Measured over a day: every page carried this session's own room and user keys,
        // including the ones whose device list was somebody else's - the server misresolves
        // the household for the list, not for the session. Declining here would leave a
        // working session without the credentials it needs.
        const { html } = await this.fetchRenderedPage();
        let { userKey, roomKey, accessToken } = parseWebSocketCredentials(html);

        userKey = userKey || this.config.userKey || "";
        roomKey = roomKey || this.config.roomKey || "";

        if(!this.wsCredentials) {
            this.wsCredentials = { userKey, roomKey, accessToken };
        } else {
            this.wsCredentials.userKey = userKey;
            this.wsCredentials.roomKey = roomKey;
            this.wsCredentials.accessToken = accessToken;
        }
    }

    public getWebSocketCredentials(): WebSocketCredentials {
        // This variables will be initialized after `sign-in` succeeded.
        if(!this.wsCredentials)
            throw new Error("`WebSocketCredentials` not yet init.");
        return this.wsCredentials;
    }

    private async requestWallpadAuthorization() {
        const response = await this.fetchJson(`${this.baseUrl}/login/callWallpadAuth.ajax`, {
            method: "POST",
            headers: {
                ...this.httpHeaders,
                "_csrf": await this.getCsrfToken(),
            },
            body: JSON.stringify({
                ...this.httpBody,
                "flag": "login",
                "input_userkey": this.wsCredentials?.userKey,
                "input_roomkey": this.wsCredentials?.roomKey,
                "input_errtype": "DEFAULT",
                "input_wallpad_key": "", // This field must be empty when I ask for preparing the wallpad authorization.
            }),
        });
        return response["result"];
    }

    async authorizeWallpadPasscode(passcode: string): Promise<ClientResponseCode> {
        const response = await this.fetchJson(`${this.baseUrl}/login/checkWallpadAuth.ajax`, {
            method: "POST",
            headers: {
                ...this.httpHeaders,
                "_csrf": await this.getCsrfToken(),
            },
            body: JSON.stringify({
                ...this.httpBody,
                "flag": "login",
                "input_userkey": this.wsCredentials?.userKey,
                "input_roomkey": this.wsCredentials?.roomKey,
                "input_errtype": "DEFAULT",
                "input_wallpad_key": passcode,
            }),
        });
        if(!response["result"]) {
            this.log.warn("The error message returned: %s", response["errMsg"] || "");
            return ClientResponseCode.parseResponseCode(response["errCode"]);
        }
        this.updateAuthorizationAndUserInfo(response);
        return ClientResponseCode.SUCCESS;
    }

    private updateAuthorizationAndUserInfo(response: any): ClientResponseCode {
        const token = response["daelim_elife"];
        if(!response["userInfo"]) {
            return ClientResponseCode.INCOMPLETE_USER_INFO;
        }

        const info = response["userInfo"];
        this.userInfo = {
            apartment: {
                building: info["dong"],
                unit: info["ho"],
            },
            complexCode: info["djCd"], // danji-code
            guid: info["guid"],
            username: info["alias"],
        };
        this.accessToken = token;
        return ClientResponseCode.SUCCESS;
    }

    private getTimestamp() {
        // Smart eLife tokens embed a yyyyMMddHHmmss timestamp.
        // Use Asia/Seoul time (KST, UTC+9) regardless of the host machine timezone.
        const now = new Date(Date.now() + 9 * 60 * 60 * 1000);

        const year = now.getUTCFullYear();
        const month = String(now.getUTCMonth() + 1).padStart(2, "0");
        const date = String(now.getUTCDate()).padStart(2, "0");
        const hours = String(now.getUTCHours()).padStart(2, "0");
        const minutes = String(now.getUTCMinutes()).padStart(2, "0");
        const seconds = String(now.getUTCSeconds()).padStart(2, "0");
        return `${year}${month}${date}${hours}${minutes}${seconds}`;
    }

    private getAccessToken() {
        if(!this.accessToken) {
            this.log.error("The access token is not yet issued. Do sign-in first.");
            return undefined;
        }
        const payload = `${this.accessToken}::${this.getTimestamp()}`;
        return Utils.aes256Base64(payload, this.key, this.iv);
    }

    private getDevicePrimaryKey(): string {
        return Utils.aes256Base64(this.config.uuid, this.key, this.iv);
    }

    private parsePushType(data: { [key: string]: unknown } | undefined, title?: string, body?: string): PushType {
        const pushType = this.parseRawPushType(data, title);
        // The access (출입) push category covers the household front door,
        // the communal door and the doorbell camera alike;
        // only the notification body tells them apart.
        // Without this an unmapped `data4` falls back to the title,
        // and every one of them would resolve to FRONT_DOOR.
        if(pushType === PushType.FRONT_DOOR && !!body) {
            // A visitor snapshot is not tied to either door -
            // the camera accessory reads `door_type` off the visitor board
            // to decide which one it belongs to.
            if(body.includes("방문자")) {
                return PushType.VISITOR;
            }
            if(body.includes("공동")) {
                return PushType.COMMUNAL_DOOR;
            }
        }
        return pushType;
    }

    private parseRawPushType(data: { [key: string]: unknown } | undefined, title?: string): PushType {
        if(!data) {
            return PushType.UNKNOWN;
        }
        // Legacy payload: `data` holds a JSON string whose data1/data2/data3
        // fields are joined into the PushType key (e.g. "5-46").
        if(data["data"]) {
            let payload: any;
            try {
                payload = JSON.parse(data["data"] as string);
            } catch {
                return PushType.UNKNOWN;
            }
            if(!payload) {
                return PushType.UNKNOWN;
            }
            const pushTypeString = ["data1", "data2", "data3"]
                .map((key) => payload[key])
                .filter((value) => !!value)
                .join("-");
            return pushTypeString as PushType || PushType.UNKNOWN;
        }
        // Current payload (since July 2026): a single `data4` code.
        if(data["data4"]) {
            const pushType = DATA4_PUSH_TYPES[String(data["data4"])];
            if(pushType) {
                return pushType;
            }
        }
        // Unmapped code; fall back to the notification title which carries
        // the push category name.
        if(title && TITLE_PUSH_TYPES[title]) {
            return TITLE_PUSH_TYPES[title];
        }
        return PushType.UNKNOWN;
    }

    // A rejected listener would otherwise reach the process as an unhandled rejection,
    // which terminates the bridge on current Node versions.
    // Nothing upstream can act on the failure anyway,
    // so it is contained here and only reported.
    private dispatchPushListener(info: PushListenerInfo, title?: string, body?: string) {
        try {
            void Promise.resolve(info.listener(title, body)).catch((e) => {
                this.reportPushListenerFailure(info.pushType, e);
            });
        } catch(e) {
            this.reportPushListenerFailure(info.pushType, e);
        }
    }

    private reportPushListenerFailure(pushType: PushType, e: unknown) {
        this.log.error("Push listener for %s failed: %s", pushType.toString(), (e as Error)?.message || e);
        this.log.debug("Push listener failure: %s", (e as Error)?.stack || "no stack available");
    }

    private async configurePushNotification() {
        if(this.push) {
            this.log("Configuring Push");

            this.push.onNotification((notification) => {
                this.log.info(`[Push] onNotify (JSON): ${JSON.stringify(notification.message, null, 2)}`);
                const message = notification.message;
                const title = message.notification?.title;
                const body = message.notification?.body;

                const pushType = this.parsePushType(message.data, title, body);
                if(pushType === PushType.UNKNOWN) {
                    this.log.warn("Unexpected Push message (unknown payload): %s", JSON.stringify(message));
                    return;
                }

                for(const listener of this.pushListeners) {
                    if(listener.pushType !== pushType) continue;
                    this.dispatchPushListener(listener, title, body);
                }
            });
            await this.push.connect();

            // Update Push tokens
            const accessToken = this.getAccessToken();
            if(!!accessToken) {
                await this.fetchJson(`${this.baseUrl}/common/updatePushToken.ajax`, {
                    method: "POST",
                    headers: {
                        ...this.httpHeaders,
                        "_csrf": await this.getCsrfToken(),
                    },
                    body: JSON.stringify({
                        "Authorization": `Bearer ${this.getAccessToken()}`,
                        "push_token": this.push.fcmToken,
                    }),
                });
            } else {
                this.log.error("Could not update Push token.");
            }
        }
    }

    private async checkPushSettings() {
        const response = await this.sendHttpJson("/mypage/pushList.ajax", {
            roomkey: this.wsCredentials?.roomKey,
            userkey: this.wsCredentials?.userKey,
            item: "all",
        });
        if(!response || !response["result"] || response["result"]["status"] !== "000") {
            this.log.warn("Could not check Push notification settings.");
            return [];
        }

        const elements = response["data"]["list"];
        const items: PushItem[] = [];
        for(const element of elements) {
            const kind = element["item"] as PushItemKind || PushItemKind.UNKNOWN;
            if(kind === PushItemKind.UNKNOWN) {
                continue;
            }
            items.push({
                enabled: element["is_use"] === "y",
                hasSmartdoor: element["hasSmartdoor"] === "y",
                kind: kind,
                name: element["name"],
                desc: element["desc"],
            });
        }
        return items;
    }

    async setPushActive(items: PushItem[], kinds: PushItemKind[]) {
        const inactives = [];
        for(const item of items) {
            if(!kinds.includes(item.kind)) continue;
            if(item.enabled) {
                this.log.info("Push for %s is already enabled.", item.kind.toString());
                continue;
            }
            inactives.push(item);
        }
        if(!inactives.length) {
            return true;
        }
        const response = await this.sendHttpJson("/mypage/pushSetting.ajax", {
            type: "daelim",
            list: inactives.map((item) => {
                return {
                    "item": item.kind.toString(),
                    "is_use": "y",
                }
            }),
        });
        if(response["result"]["status"] !== "000") {
            return false;
        }
        for(const item of inactives) {
            this.log.info("Push for %s is enabled.", item.kind.toString());
        }
        return true;
    }

    async serve() {
        this.configurePushNotification().then(async () => {
            this.log("Push notification configured.");

            const items = await this.checkPushSettings();
            // The legacy VISITOR and FAMILY_ENTER kinds are dropped here because the
            // renamed setting list exposes no equivalent items.
            await this.setPushActive(items, [
                PushItemKind.CAR, // vehicle in/out motion (data4 58)
                PushItemKind.DOOR, // communal/front door access motion (data4 64)
                PushItemKind.DOOR_LOCK, // front door open motion (data4 55)
            ]);
        });

        this.complex = await this.fetchComplex();
        if(this.complex) {
            this.log(`Complex: ${this.complex.complexDisplayName}`);
            const { dongs, ...redacted } = this.complex;
            this.log.debug("JSON: %s", JSON.stringify(redacted));
        }

        if(this.userInfo) {
            this.log(`User info: %s (%s-%s)`,
                this.userInfo.username,
                this.userInfo.apartment.building,
                this.userInfo.apartment.unit);
            this.log.debug("JSON: %s", JSON.stringify(this.userInfo));
        }

        this.log.info(`Installed WallPad version is on CVNET ${this.config.wallpadVersion}.`);

        if(this.ws) {
            await this.ws.serve();
            await this.refreshDeviceStatus();
        }

        setInterval(async () => {
            this.log.info("Polling device state");
            await this.refreshDeviceStatus(true);
        }, POLLING_INTERVAL_MILLISECONDS);
    }

    private async createDocumentHeaters(): Promise<Record<string, string>> {
        return {
            "User-Agent": Utils.SMART_ELIFE_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Sec-Fetch-Site": "none",
            "Accept-Language": "ko-KR,ko;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "Sec-Fetch-Mode": "navigate",
            "Host": "smartelife.apt.co.kr",
            "Connection": "keep-alive",
            "Sec-Fetch-Dest": "document",
            "_csrf": await this.getCsrfToken(),
            "Authorization": `Bearer ${this.getAccessToken()}`,
            "dpk": this.getDevicePrimaryKey(),
        };
    }

    async parseWallPadVersion() {
        this.log.debug("Configuring WallPad version");
        const paths = [
            "/controls/vent.do",
            "/controls/heat.do",
            "/controls/visitorCar.do",
            "/mode/home.do",
            "/mode/condition.do",
            "/mode/actionModify.do",
            "/monitoring/charge.do",
            "/monitoring/energy.do",
        ]
        const tasks = paths.map(async (path) => this.fetchWithJSessionId(`${this.baseUrl}${path}`, {
                method: "GET",
                headers: await this.createDocumentHeaters(),
            }).then((response) => response.text()));
        const htmls = await Promise.all(tasks);
        const candidates: HTMLCandidate[] = paths.map((path, i): HTMLCandidate => {
            return {
                name: path,
                html: htmls[i],
            };
        });
        const r = parseWallPadVersionFromHtmlCandidates(candidates);
        if(!r.version) {
            this.log.debug(`Due to low confidence, fallback the WallPad version back to ${WALLPAD_VERSION_3_0}`);
            r.version = WALLPAD_VERSION_3_0;
        }
        this.log.info(`Installed WallPad is on CVNET ${r.version} (conf = ${r.confidence.toFixed(2)}).`);
        return r.version;
    }

    /**
     * Next number from the observation counter.
     * Observations and commands draw from the same one,
     * which is the only thing that establishes their order -
     * see `ListenerMetadata.observedSeq`.
     */
    takeObservedSeq(): number {
        return ++this.observationCounter;
    }

    /**
     * Fetches `/main/home.do` and keeps it only if it is this household's.
     *
     * The single gate. `/main/home.do` answers with another resident's page often enough
     * to matter - measured at 18 to 42 per cent of polls over a day - and it does so with a
     * plain 200 rather than with anything that reads as an error. Everything downstream reads
     * this page: the device list, the room names, the WebSocket credentials. Holding the page
     * itself is the only place where one judgement covers all of them.
     */
    private async fetchRenderedPage(forceFetch: boolean = false): Promise<RenderedPage> {
        if(!!this.renderedPage && !forceFetch) {
            return this.renderedPage;
        }
        // Stamped before the request leaves rather than after the markup is read.
        // A polled page is seconds old by the time it is parsed,
        // and a command sent in that gap must not be judged against it.
        const observedSeq = this.takeObservedSeq();
        const observedAt = Date.now();
        const html = await this.fetchWithJSessionId(`${this.baseUrl}/main/home.do`, {
            method: "GET",
            headers: await this.createDocumentHeaters(),
        }).then((response) => response.text());

        const deviceList = parseDeviceList(html) || undefined;
        const household = !deviceList
            ? HouseholdAttribution.INVALID
            : this.attributeDeviceList(deviceList);
        const page: RenderedPage = { html, deviceList, household, observedSeq, observedAt };
        if(household === HouseholdAttribution.FOREIGN) {
            this.declinedForeignReports += 1;
            this.log.debug("Ignoring a rendered page that is not this household's " +
                "(%d report(s) declined so far).", this.declinedForeignReports);
            // Deliberately not cached. Serving it again would make one bad answer
            // the household for as long as nobody forces a fetch.
            return page;
        }
        if(household === HouseholdAttribution.INVALID) {
            // A page the parser could not read is not cached either - unlike a foreign page
            // it says nothing about any household, but serving it again would pin every
            // downstream reader to markup that already failed once. The caller still gets
            // the page itself: the credentials parser reads it for something the device
            // list has no bearing on.
            this.log.debug("The rendered page carried no readable device list.");
            return page;
        }
        // OWN and UNKNOWN are both kept. An UNKNOWN page is the candidate a first-time
        // setup shows the resident, and it has to stay one page - refetching between the
        // credentials parse and the device read could swap in a different household's.
        this.renderedPage = page;
        if(household === HouseholdAttribution.OWN && deviceList) {
            // Learned only from a page that proved itself ours - an unproven page must not
            // decide which device types the WallPad gets asked about.
            this.renderedDeviceTypes = deviceList
                .map((deviceGroup: any) => deviceGroup["type"] as DeviceType)
                .filter((deviceType: DeviceType) => !!deviceType);
        }
        return page;
    }

    /**
     * Whose household a device list is.
     *
     * WallPad `uid`s are only unique inside one household, so a stranger's list does not
     * merely miss ours - it collides with a few of them, and `parseDevices()` matches on
     * `uid` and type alone. That is how a light of ours picks up somebody else's on/off.
     *
     * Measured against a live household over a day: this account's own page names all but one
     * of the devices it lists in the configuration, while the pages of strangers name at most a
     * fifth of theirs. A majority sits between the two with room to spare on both sides.
     *
     * Where there is nothing to compare against, the answer is `UNKNOWN` rather than a pass:
     * the settings wizard shows such a list to the resident,
     * and only what they explicitly save becomes the yardstick for every later judgement.
     */
    private attributeDeviceList(deviceList: any[]): HouseholdAttribution {
        const configured = new Set((this.config.devices || []).map((device) => device.deviceId));
        // Nothing to hold the list against.
        if(configured.size === 0) {
            if(!this.reportedUncomparableDeviceList) {
                this.reportedUncomparableDeviceList = true;
                this.log.debug("Nothing configured to hold a device list against.");
            }
            return HouseholdAttribution.UNKNOWN;
        }
        let listed = 0;
        let ours = 0;
        for(const deviceGroup of deviceList) {
            for(const device of deviceGroup?.["devices"] || []) {
                const deviceId = device?.["uid"];
                if(typeof deviceId !== "string" || deviceId.trim().length === 0) {
                    continue;
                }
                listed += 1;
                if(configured.has(deviceId)) {
                    ours += 1;
                }
            }
        }
        // A list that named nobody carries no state to mistake for ours,
        // and no evidence about whose it is either.
        if(listed === 0) {
            return HouseholdAttribution.UNKNOWN;
        }
        return ours * 2 > listed ? HouseholdAttribution.OWN : HouseholdAttribution.FOREIGN;
    }

    /**
     * Whether a WebSocket frame is this household's.
     *
     * The two shapes have to be judged differently. A query answers with every device of its
     * type, which can be held against the configuration exactly as a page is - 91 of these
     * arrived from other households in a day of measurement. A push carries one device, where
     * a majority means nothing, but it does carry the room key, which the elevator frames
     * already rely on. A frame naming neither is let through: `elevator_call_request` carries
     * no room key at all.
     */
    private isOwnHouseholdFrame(data: any, completeSnapshot: boolean, deviceType: DeviceType): boolean {
        // Not every frame carries devices at all - the indoor air list answers with a bare
        // header - and a frame that names nothing cannot be attributed to anybody.
        if(!data || typeof data !== "object") {
            return true;
        }
        if(completeSnapshot) {
            // A whole page pools every type, so a handful of devices this household never
            // configured is lost in the majority. One type on its own has no such cushion:
            // where the configuration holds none of that type at all, every answer about it
            // names nobody we know and would read as somebody else's. The all-off switch is
            // exactly that - `fetchDevices()` never writes it down - and its own answers were
            // being refused. Judge only what there is something to judge against.
            const comparable = (this.config.devices || [])
                .some((device) => device.deviceType === deviceType);
            if(!comparable) {
                return true;
            }
            // Only a positive FOREIGN verdict declines a frame. UNKNOWN passes as before -
            // with nothing configured there are no accessories listening anyway.
            return this.attributeDeviceList([data]) !== HouseholdAttribution.FOREIGN;
        }
        const roomKey = data["roomkey"];
        if(typeof roomKey !== "string" || roomKey.length === 0) {
            return true;
        }
        return !this.wsCredentials?.roomKey || roomKey === this.wsCredentials.roomKey;
    }

    /**
     * Device types worth asking the WallPad about.
     *
     * What the last accepted page carried, where there has been one - that is the server's own
     * account of which types it answers for. Before then the configuration stands in, because
     * the first page after a sign-in is sometimes the one that gets declined, and a start that
     * declines its first page would otherwise ask about nothing at all and sit blind until a
     * page happens to come back ours. A type the query cannot answer for costs one entry in a
     * JSON array and is ignored.
     */
    private deviceTypesToAskAbout(): DeviceType[] {
        if(this.renderedDeviceTypes.length > 0) {
            return this.renderedDeviceTypes;
        }
        return [...new Set((this.config.devices || []).map((device) => device.deviceType))];
    }

    /**
     * Asks the WallPad for the state of whole device types,
     * the same query the app's own pages run when they open.
     * The answer arrives through the usual listeners, marked as a complete snapshot.
     *
     * This is what a declined page falls back on. The rendered page is the only thing
     * the server gets wrong; the socket answers for the session.
     */
    async requestDeviceStatus(deviceTypes: DeviceType[] = this.deviceTypesToAskAbout()) {
        if(!this.ws || deviceTypes.length === 0) {
            return;
        }
        await this.sendStatusQuery(
            deviceTypes.map((deviceType) => ({ type: deviceType.toString() })),
            deviceTypes);
    }

    /**
     * Sends a status query and records, per device type, the number drawn as it leaves.
     * The answers arrive through `onMessage` as complete snapshots and pick these numbers
     * back up in order - see `ListenerMetadata.observedSeq` for why the send is the moment
     * that counts.
     */
    private async sendStatusQuery(data: any[], deviceTypes: DeviceType[]) {
        for(const deviceType of deviceTypes) {
            const queue = this.pendingStatusQueries.get(deviceType) || [];
            queue.push(this.takeObservedSeq());
            this.pendingStatusQueries.set(deviceType, queue);
        }
        await this.sendJson({
            "roomKey": this.wsCredentials?.roomKey,
            "userKey": this.wsCredentials?.userKey,
            "accessToken": this.wsCredentials?.accessToken,
            "data": data,
        });
    }

    private async refreshDeviceStatus(forceFetch: boolean = false) {
        if(!this.ws) {
            return;
        }
        const page = await this.fetchRenderedPage(forceFetch);
        if(page.household === HouseholdAttribution.FOREIGN || !page.deviceList) {
            // Nothing of this page reaches the accessories, and none of it is echoed back
            // to the socket either - asking the server about a stranger's devices is how
            // their answers came back as ours. The WallPad is asked instead, so that
            // declining a page costs freshness rather than sight.
            // An UNKNOWN page passes: with nothing configured there are no accessories
            // listening, so publishing it is a no-op rather than a leak.
            await this.requestDeviceStatus();
            return;
        }
        const deviceList = page.deviceList;
        await this.sendStatusQuery(deviceList, deviceList
            .map((deviceGroup: any) => deviceGroup["type"] as DeviceType)
            .filter((deviceType: DeviceType) => !!deviceType));

        for(const deviceGroup of deviceList) {
            const deviceType = deviceGroup["type"] as DeviceType || DeviceType.UNKNOWN;
            if(deviceType === DeviceType.UNKNOWN)
                this.log.warn("Unknown device type: %s", deviceGroup["type"]);

            for(const listener of this.listeners) {
                if(listener.deviceType !== deviceType)
                    continue;
                listener.listener(deviceGroup, { code: Number("000"), message: undefined }, {
                    observedSeq: page.observedSeq,
                    observedAt: page.observedAt,
                    completeSnapshot: true,
                });
            }
        }
    }

    private async requestElevatorStatus() {
        await this.sendJson(createElevatorStatusRequest(this.getWebSocketCredentials()));
    }

    /**
     * What the last `fetchDevices()` read about this household's lights,
     * beyond what a `Device` carries.
     *
     * The rendered list gives each device's `operation` beside its name, which is the only
     * reason the settings wizard can tell a level flag from a light that dims on its own -
     * and it can do so without a WebSocket, which the wizard has none of. Kept beside the
     * devices rather than on them, because none of it belongs in the configuration.
     */
    lightDetails(): { deviceId: string, name: string, room: string, value: string }[] {
        return this.renderedLightDetails;
    }

    async fetchDevices(): Promise<DeviceFetchResult> {
        this.renderedLightDetails = [];
        const page = await this.fetchRenderedPage();
        if(page.household === HouseholdAttribution.FOREIGN || !page.deviceList) {
            // Failure is reported as what it is rather than as an empty household -
            // the wizard decides what to do with it, and must not mistake it for
            // a home that owns no devices.
            if(page.household === HouseholdAttribution.FOREIGN) {
                this.log.warn("The rendered device list was not this household's, so no devices were read. " +
                    "Try again in a moment.");
            } else {
                this.log.warn("The rendered page carried no readable device list, so no devices were read.");
            }
            return { household: page.household, devices: [] };
        }
        const deviceList = page.deviceList;
        const fetchedDevices: Device[] = [];
        for(const deviceGroup of deviceList) {
            const deviceType = deviceGroup["type"] as DeviceType || DeviceType.UNKNOWN;
            if(deviceType === DeviceType.UNKNOWN) {
                this.log.warn(`Unknown device type: ${deviceGroup["type"]}`);
                continue;
            }

            if(deviceType === DeviceType.ALL_OFF_SWITCH) continue;

            for(const device of deviceGroup["devices"]) {
                let name = device["device_name"];
                if(deviceType === DeviceType.GAS && device["options"] === "gas_02") {
                    name = "쿡탑";
                }
                const room = device["location_name"];
                const displayName = `${room} ${name}`;
                fetchedDevices.push({
                    displayName, name, deviceType,
                    deviceId: device["uid"],
                    disabled: false,
                });
                if(deviceType === DeviceType.LIGHT) {
                    this.renderedLightDetails.push({
                        deviceId: device["uid"], name, room,
                        value: device["operation"]?.["value"] || "",
                    });
                }
            }
        }
        return { household: page.household, devices: fetchedDevices };
    }

    private async fetchComplex() {
        if(!this.userInfo) {
            throw new Error("`UserInfo` must be init prior to fetch complex info.");
        }
        const complexes = await fetch(Utils.SMART_ELIFE_COMPLEX_URL)
            .then((response) => response.json())
            .then((json) => json as SmartELifeComplex[]);
        const complexOne = complexes
            .filter((complex) => complex.complexCode === this.userInfo?.complexCode);
        if(!complexOne) {
            return undefined;
        }
        return complexOne[0];
    }

    async sendHttpJson(path: string, p: any) {
        return await this.fetchJson(`${this.baseUrl}${path}`, {
            method: "POST",
            headers: {
                ...this.httpHeaders,
                "_csrf": await this.getCsrfToken(),
                "daelim_elife": this.accessToken,
            },
            body: JSON.stringify(p),
        });
    }

    async sendElevatorCallQuery(): Promise<boolean> {
        const response = await this.sendControlQuery(ControlQueryCategory.ELEVATOR, "call", {
            uid: EXTERIOR_ELEVATOR_DEVICE.deviceId,
            operation: {
                control: "down",
            },
        });
        return !!response["result"] && response["result"]["status"] === "000";
    }

    async sendControlQuery(
        category: ControlQueryCategory,
        type: string,
        data: any,
        command: string = "control_request",
    ) {
        return await this.fetchJson(`${this.baseUrl}/common/data.ajax`, {
            method: "POST",
            headers: {
                ...this.httpHeaders,
                "_csrf": await this.getCsrfToken(),
                "daelim_elife": this.accessToken,
            },
            body: JSON.stringify({
                header: {
                    category: category.toString(),
                    type, command,
                },
                data,
            })
        });
    }

    async sendDeviceControl(device: Device, control: string): Promise<boolean> {
        const response = await this.fetchJson(`${this.baseUrl}/device/control/all.ajax`, {
            method: "POST",
            headers: {
                ...this.httpHeaders,
                "_csrf": await this.getCsrfToken(),
                "daelim_elife": this.accessToken,
            },
            body: JSON.stringify({
                type: device.deviceType.toString(),
                uid: device.deviceId,
                control,
            }),
        });
        return response["result"] as boolean;
    }

    /**
     * Drives several devices of one type with a single request,
     * the way the official app controls a whole room: `uid` carries a comma separated list.
     * `is_control_all` is the app's flag for its "전체" card, which addresses every device of
     * the type regardless of the list, so room level control keeps it off.
     *
     * It carries a deadline of its own. The retry ladder inside `fetchJson()` runs for the
     * better part of twenty seconds, and a socket that never answers at all would otherwise
     * hold a per-accessory queue shut for the life of the process.
     */
    async sendDeviceControlAll(deviceType: DeviceType, deviceIds: string[], control: string): Promise<boolean> {
        const controller = new AbortController();
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<never>((_, reject) => {
            deadline = setTimeout(() => {
                reject(new Error(`Controlling ${deviceType.toString()} timed out after ${DEVICE_CONTROL_ALL_TIMEOUT_MILLISECONDS}ms.`));
                controller.abort();
            }, DEVICE_CONTROL_ALL_TIMEOUT_MILLISECONDS);
            deadline.unref();
        });
        try {
            const request = (async () => {
                const response = await this.fetchJson(`${this.baseUrl}/device/control/all.ajax`, {
                    method: "POST",
                    headers: {
                        ...this.httpHeaders,
                        "_csrf": await this.getCsrfToken(),
                        "daelim_elife": this.accessToken,
                    },
                    body: JSON.stringify({
                        type: deviceType.toString(),
                        uid: deviceIds.join(","),
                        control,
                        is_control_all: "N",
                    }),
                    signal: controller.signal,
                });
                return response["result"] as boolean;
            })();
            return await Promise.race([request, timedOut]);
        } finally {
            if(deadline) {
                clearTimeout(deadline);
            }
        }
    }

    async sendDeviceControlOp(device: Device, op: any): Promise<boolean> {
        const response = await this.fetchJson(`${this.baseUrl}/device/control.ajax`, {
            method: "POST",
            headers: {
                ...this.httpHeaders,
                "_csrf": await this.getCsrfToken(),
                "daelim_elife": this.accessToken,
            },
            body: JSON.stringify({
                type: device.deviceType.toString(),
                uid: device.deviceId,
                operation: op,
            }),
        });
        return response["result"] as boolean;
    }

    async sendJson(payload: any) {
        await this.ws?.wsSendJson(payload);
    }

    addListener(deviceType: DeviceType, listener: Listener) {
        this.listeners.push({ deviceType, listener });
    }

    addPushListener(pushType: PushType, listener: PushListener) {
        this.pushListeners.push({ pushType, listener });
    }
}
