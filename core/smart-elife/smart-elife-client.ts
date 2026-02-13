import fetch, {Response} from "node-fetch";
import {LoggerBase, Utils} from "../utils";
import {
    ControlQueryCategory,
    Device,
    DeviceType,
    PushItem,
    PushItemKind,
    PushType,
    SmartELifeConfig
} from "../interfaces/smart-elife-config";
import {ClientResponseCode} from "./responses";
import PushReceiver from "@eneris/push-receiver";
import {Logging} from "homebridge";
import {SmartELifeComplex, SmartELifeUserInfo} from "../interfaces/smart-elife-complex";
import WebSocketScheduler from "./ws-scheduler";
import {parseWebSocketCredentials, WebSocketCredentials} from "./parsers/ws-creds-parsers";
import {parseDeviceList} from "./parsers/device-parsers";
import {HTMLCandidate, parseWallPadVersionFromHtmlCandidates, WALLPAD_VERSION_3_0} from "./parsers/version-parsers";
import {ELEVATOR_DEVICE} from "../../homebridge/accessories/smart-elife/elevator";

export interface ListenerError {
    code: number
    message?: string
}

export type Listener = (data: any | undefined, error: ListenerError) => void;
export type PushListener = (title: string | undefined, message: string | undefined) => void;

interface ListenerInfo {
    deviceType: DeviceType
    listener: Listener
}

interface PushListenerInfo {
    pushType: PushType
    listener: PushListener
}

export default class SmartELifeClient {

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
    private serverSideRenderedHTML?: string;

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
            async onMessage(client: SmartELifeClient, json: any) {
                const header = json["header"];
                const action = json["action"];

                let status = "000";
                let deviceTypeString, message;
                if(!!header) {
                    deviceTypeString = header["type"];
                    if(json["result"]) {
                        status = json["result"]["status"];
                        message = json["result"]["message"];
                    }
                } else if(!!action && action.startsWith("event_")) {
                    deviceTypeString = action.slice("event_".length);
                } else {
                    client.log.warn("Unexpected message format: %s", JSON.stringify(json));
                    return;
                }
                const deviceType = deviceTypeString as DeviceType || DeviceType.UNKNOWN;
                if(deviceType === DeviceType.UNKNOWN)
                    client.log.warn("Unknown device type: %s", deviceTypeString);

                for(const info of client.listeners) {
                    if(info.deviceType === deviceType) {
                        info.listener(json["data"], { code: Number(status), message });
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

    private async fetchWithJSessionId(url: string, options: any = {}): Promise<Response> {
        this.applySessionCookie(options);
        let response = await fetch(url, options);
        this.updateSessionCookieFromResponse(response);

        // Debugging purpose.
        let buf = `${options.method} ${url}\n`;
        for(const headerKey in options.headers) {
            const headerValue = options.headers[headerKey];
            buf += `${headerKey}: ${headerValue}\n`;
        }
        if(!!options.body) {
            buf += "\n";
            const body = JSON.parse(options.body);
            buf += JSON.stringify(body, null, 2);
        }
        this.log.debug(buf);
        return response;
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

            needsRetry = !response.ok || response.status !== 200 || text === "requireLoginForAjax";
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
        let { userKey, roomKey, accessToken } = parseWebSocketCredentials(await this.fetchServerSideRenderedHTML());

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

    private async configurePushNotification() {
        if(this.push) {
            this.log("Configuring Push");

            this.push.onNotification((notification) => {
                this.log.info(`[Push] onNotify (JSON): ${JSON.stringify(notification.message, null, 2)}`);
                const data = notification.message.data;
                if(!data || !data["data"]) {
                    this.log.warn("Unexpected Push message (no data): %s", JSON.stringify(notification.message));
                    return;
                }
                const payload = JSON.parse(data["data"] as string);
                if(!payload) {
                    this.log.warn("Unexpected Push message (not JSON): %s", JSON.stringify(notification.message));
                    return;
                }
                const pushTypeString = ["data1", "data2", "data3", "data4"]
                    .map((key) => payload[key])
                    .filter((value) => !!value)
                    .join("-");
                const pushType = pushTypeString as PushType || PushType.UNKNOWN;
                if(pushType === PushType.UNKNOWN) {
                    this.log.warn("Unexpected Push message (unknown payload): %s", JSON.stringify(notification.message));
                    return;
                }
                const title = notification.message.notification?.title;
                const body = notification.message.notification?.body;

                for(const listener of this.pushListeners) {
                    if(listener.pushType !== pushType) continue;
                    listener.listener(title, body);
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
            await this.setPushActive(items, [
                PushItemKind.VISITOR,
                PushItemKind.CAR,
                PushItemKind.DOOR,
                PushItemKind.FAMILY_ENTER,
                PushItemKind.SMART_DOOR_STATUS,
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

    private async fetchServerSideRenderedHTML() {
        if(!!this.serverSideRenderedHTML) {
            return this.serverSideRenderedHTML;
        }
        const html = await this.fetchWithJSessionId(`${this.baseUrl}/main/home.do`, {
            method: "GET",
            headers: await this.createDocumentHeaters(),
        }).then((response) => response.text());
        this.serverSideRenderedHTML = html;
        return html;
    }

    private async refreshDeviceStatus() {
        if(!this.ws) {
            return;
        }
        const deviceList = parseDeviceList(await this.fetchServerSideRenderedHTML());
        await this.sendJson({
            "roomKey": this.wsCredentials?.roomKey,
            "userKey": this.wsCredentials?.userKey,
            "accessToken": this.wsCredentials?.accessToken,
            "data": deviceList,
        });
    }

    async fetchDevices(): Promise<Device[]> {
        const deviceList: any[] = parseDeviceList(await this.fetchServerSideRenderedHTML());
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
                const displayName = `${device["location_name"]} ${name}`;
                fetchedDevices.push({
                    displayName, name, deviceType,
                    deviceId: device["uid"],
                    disabled: false,
                });
            }
        }
        return fetchedDevices;
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
            uid: ELEVATOR_DEVICE.deviceId,
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
