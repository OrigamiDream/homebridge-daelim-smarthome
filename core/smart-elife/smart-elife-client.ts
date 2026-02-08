import fetch, {Response} from "node-fetch";
import {LoggerBase, Utils} from "../utils";
import {SmartELifeConfig} from "../interfaces/smart-elife-config";
import {ClientResponseCode} from "./responses";
import PushReceiver from "@eneris/push-receiver";
import {Logging} from "homebridge";
import {SmartELifeComplex, SmartELifeUserInfo} from "../interfaces/smart-elife-complex";

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
    private userKey?: string;
    private roomKey?: string;

    private readonly baseUrl = Utils.SMART_ELIFE_BASE_URL;
    private readonly key = Utils.SMART_ELIFE_AES_KEY;
    private readonly iv = Utils.SMART_ELIFE_AES_IV;

    constructor(private readonly log: Logging | LoggerBase,
                private readonly config: SmartELifeConfig,
                private readonly push?: PushReceiver) {
        this.httpBody = {
            "input_dv_make_info": "apple",
            "input_dv_model_info": "iPhone18,4",
            "input_dv_osver_info": "26.2.1",
            "input_acc_os_info": "ios",
            "input_push_token": this.push?.fcmToken ?? "",
            "input_dv_uuid": Utils.generateUUID(this.config.username),
        };
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
        // node-fetch v2 exposes Set-Cookie via headers.raw().
        const raw = (response.headers as any)?.raw?.();
        const setCookies: string[] = raw?.["set-cookie"] ?? raw?.()["set-cookie"] ?? [];
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
                    this.log.debug("Could not perform the request (seams token expiration). Retrying immediately.");
                } else if(numAttempts <= 5) {
                    this.log.debug(`Could not perform the request over ${numAttempts} attempts. Retrying within 5 seconds.`);
                    await Utils.sleep(5000);
                } else {
                    throw new Error(`Could not perform the request over ${numAttempts} attempts. Request dropped.`);
                }

                if("_csrf" in opts.headers) {
                    opts.headers["_csrf"] = await this.getCsrfToken(true);
                }
                if("Authorization" in opts.headers) {
                    const response = await this.signIn();
                    if(response !== ClientResponseCode.SUCCESS) {
                        throw new Error(`Could not re-establish authentication.`);
                    }
                    const token = this.getAccessToken();
                    if(token) {
                        opts.headers["Authorization"] = `Bearer ${token}`;
                    }
                }
            }
            const response = await this.fetchWithJSessionId(url, opts);
            text = await response.text();

            needsRetry = !response.ok || response.status !== 200 || text === "requireLoginForAjax";
            numAttempts += 1;
        } while(needsRetry);

        return Utils.parseJsonSafe(text);
    }

    private async fetchCSRFInplace() {
        const url = `${this.baseUrl}/common/nativeToken.ajax`;
        const response = await fetch(url, {
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
                "_csrf": await this.getCsrfToken(),
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
                if(!!homeList) {
                    this.log.warn(`You may registered multiple homes. Requires to choose a home: ${JSON.stringify(homeList, null, 2)}`);
                    return ClientResponseCode.INCOMPLETE_USER_INFO;
                }
                return this.updateAuthorizationAndUserInfo(response);
            }
            case ClientResponseCode.UNCERTIFIED_WALLPAD: {
                this.userKey = response["userkey"];
                this.roomKey = response["roomkey"];
                this.log.info(`Received user-key = ${this.userKey}, room-key = ${this.roomKey} prior to wallpad authorization.`);

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
                "input_userkey": this.userKey,
                "input_roomkey": this.roomKey,
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
                "input_userkey": this.userKey,
                "input_roomkey": this.roomKey,
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
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const date = String(now.getDate()).padStart(2, "0");
        const hours = String(now.getHours()).padStart(2, "0");
        const minutes = String(now.getMinutes()).padStart(2, "0");
        const seconds = String(now.getSeconds()).padStart(2, "0");
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

    async serve() {
        if(this.push) {
            this.log("Setting up Push notification receiver...");

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

            this.push.onNotification((notification) => {
                const orig = notification.message;
                if(!orig || !orig.data) {
                    return;
                }
                this.log.info(`[Push] onNotify (JSON): ${JSON.stringify(orig.data, null, 2)}`);
            });
            await this.push.connect();
        }
        this.complex = await this.fetchComplex();
        if(this.complex) {
            this.log(`Complex: ${this.complex.complexDisplayName}`);
            this.log.debug("JSON: %s", JSON.stringify(this.complex, null, 2));
        }

        if(this.userInfo) {
            this.log(`User info: %s (%s-%s)`,
                this.userInfo.username,
                this.userInfo.apartment.building,
                this.userInfo.apartment.unit);
            this.log.debug("JSON: %s", JSON.stringify(this.userInfo, null, 2));
        }

        // TODO: RegEx on `home.do` and parse the in-placed values.
    }

    private async fetchComplex() {
        const complexes = await fetch(Utils.SMART_ELIFE_COMPLEX_URL)
            .then((response) => response.json())
            .then((json) => json as SmartELifeComplex[]);
        const complexOne = complexes
            .filter((complex) => complex.complexKey === this.config.complex);
        if(!complexOne) {
            return undefined;
        }
        return complexOne[0];
    }
}
