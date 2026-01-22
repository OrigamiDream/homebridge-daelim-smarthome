import fetch from "node-fetch";
import {LoggerBase, Utils} from "../utils";
import {SmartELifeConfig} from "../interfaces/smart-elife-config";
import crypto from "crypto";
import {ClientResponseCode} from "./responses";

export default class SmartELifeClient {

    private readonly httpBody: {[key: string]: string};
    private readonly httpHeaders = {
        "User-Agent": Utils.SMART_ELIFE_USER_AGENT,
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    private csrfToken?: string;
    private attemptsCsrfIssuing: number = 0;

    // WallPad authorization temporary keys
    private userKey?: string;
    private roomKey?: string;

    private readonly baseUrl = Utils.SMART_ELIFE_BASE_URL;
    private readonly key = Utils.SMART_ELIFE_AES_KEY;
    private readonly iv = Utils.SMART_ELIFE_AES_IV;

    constructor(private readonly log: LoggerBase,
                private readonly config: SmartELifeConfig) {
        this.httpBody = {
            "input_dv_make_info": "oznu",
            "input_dv_model_info": "homebridge",
            "input_dv_osver_info": this.config.version.toString(),
            "input_acc_os_info": "android",
            "input_push_token": "",
            "input_dv_uuid": this.config.uuid,
        };
    }

    private async fetchJson(url: string, options: any = {}) {
        let response = await fetch(url, options);
        if(!response.ok && response.status === 401) {
            const headers = options["headers"] || {};
            headers["_csrf"] = this.getCsrfToken(true);
            options["headers"] = headers;
            response = await fetch(url, options);
        }
        return response.json();
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

    private aesEncryptBase64(plaintext: string, key: string, iv: string, algorithm: string = "aes-256-cbc") {
        const cipher = crypto.createCipheriv(
            algorithm,
            Buffer.from(key, "utf8"),
            Buffer.from(iv, "utf8"),
        );
        const out = Buffer.concat([
            cipher.update(plaintext, "utf8"),
            cipher.final(),
        ]);
        return out.toString("base64");
    }

    async signIn(): Promise<ClientResponseCode> {
        const username = this.aesEncryptBase64(this.config.username, this.key, this.iv);
        const password = this.aesEncryptBase64(this.config.password, this.key, this.iv);

        const url = `${this.baseUrl}/login.ajax`
        const response = await this.fetchJson(url, {
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
                "input_username": username,
                "input_password": password,
                "input_auto_login": "on",
            }),
        });
        this.log.info(JSON.stringify(response, null, 2));

        const code = ClientResponseCode[response["errCode"] as keyof typeof ClientResponseCode];
        if(code === ClientResponseCode.UNCERTIFIED_WALLPAD) {
            this.userKey = response["userkey"];
            this.roomKey = response["roomkey"];
            this.log.info(`Received user-key = ${this.userKey}, room-key = ${this.roomKey} prior to wallpad authorization.`);
        }
        return code;
    }

    async authorizeWallpadPasscode(passcode: string): Promise<ClientResponseCode> {
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
                "input_errtype": "",
                "input_wallpad_key": passcode,
            }),
        });
        this.log.info(JSON.stringify(response, null, 2));
        return ClientResponseCode[response["errCode"] as keyof typeof ClientResponseCode];
    }
}
