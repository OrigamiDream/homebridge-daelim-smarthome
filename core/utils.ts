import fetch from "node-fetch";
import {version} from "../package.json";
import {
    ApplicationLogSubTypes,
    DeviceSubTypes,
    ElevatorCallSubTypes,
    EMSSubTypes,
    EtceteraSubTypes,
    GuardSubTypes,
    HealthcareSubTypes,
    InfoSubTypes,
    LoginSubTypes,
    SettingSubTypes,
    SystemSubTypes,
    Types
} from "./daelim/fields";
import {DaelimComplex, DaelimComplexInfo} from "./interfaces/daelim-complex";
import * as fs from "fs";
import {MenuItem} from "./interfaces/menu";
import axios from "axios";
import * as https from "node:https";
import crypto from "crypto";
import {createHash} from "node:crypto";

export interface LoggerBase {
    (message: string, ...parameters: any[]): void;
    info(message: string, ...parameters: any[]): void;
    warn(message: string, ...parameters: any[]): void;
    error(message: string, ...parameters: any[]): void;
    debug(message: string, ...parameters: any[]): void;
}

export interface SemanticVersion {
    major: number,
    minor: number,
    patch: number,
    beta: number,
    toString(): string,
    isNewerThan(spec: SemanticVersion): boolean,
}

export class Semaphore {

    public static readonly FILENAME = 'daelim-semaphore';

    private getFilePath() {
        return `${process.cwd()}/${Semaphore.FILENAME}`;
    }

    public createSemaphore() {
        if(this.isLocked()) {
            return;
        }
        fs.openSync(this.getFilePath(), 'w');
    }

    public removeSemaphore() {
        if(!this.isLocked()) {
            return;
        }
        fs.unlinkSync(this.getFilePath());
    }

    public isLocked() {
        return fs.existsSync(this.getFilePath());
    }

}

export class Utils {

    public static PLUGIN_NAME = "homebridge-daelim-smarthome";
    public static PLATFORM_NAME = "DaelimSmartHomePlatform";
    public static MANUFACTURER_NAME = "DL E&C Co.,Ltd.";

    public static DAELIM_FCM_SENDER_ID = "251248256994";
    public static DAELIM_FCM_PROJECT_ID = "daelim-smarthome";
    public static DAELIM_FCM_APP_ID = "1:251248256994:android:4f4ccc5221a7b689";
    public static DAELIM_FCM_API_KEY = "AIzaSyAm__JwMJS8utB54p36cDxl8lsKu2wHKNI";

    public static SMART_ELIFE_FCM_SENDER_ID = "277598878115";
    public static SMART_ELIFE_FCM_PROJECT_ID = "elife-smarthome-fcm";
    public static SMART_ELIFE_FCM_APP_ID = "1:277598878115:android:0cf9968e683237d23e4216";
    public static SMART_ELIFE_FCM_API_KEY = "AIzaSyC_XtNnRG3Xk2hCV9EM8b_B1nb_bxIcYYs";

    public static SMART_ELIFE_AES_KEY = "12345678901234567890123456789012";
    public static SMART_ELIFE_AES_IV = "HrPtH4kvhKjVsPU=";
    public static SMART_ELIFE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 9_2 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Mobile/13C75 DAELIM/IOS";
    public static SMART_ELIFE_BASE_URL = "https://smartelife.apt.co.kr";
    public static SMART_ELIFE_APP_VERSION = "1.2.11";

    public static DAELIM_COMPLEX_URL = "https://raw.githubusercontent.com/OrigamiDream/homebridge-daelim-smarthome/refs/heads/v1.5.0-beta/complexes/daelim/complexes.json";
    public static SMART_ELIFE_COMPLEX_URL = "https://raw.githubusercontent.com/OrigamiDream/homebridge-daelim-smarthome/refs/heads/v1.5.0-beta/complexes/smart-elife/complexes.json";
    public static HOMEKIT_SECURE_VIDEO_IDLE_URL = "https://raw.githubusercontent.com/OrigamiDream/homebridge-daelim-smarthome/master/assets/hksv_camera_idle.png";
    public static MENU_INFO_URL = "https://smarthome.daelimcorp.co.kr/json/getApartMenuInfo.do";

    static homekitString(value: unknown, maxLen: number = 64): string {
        let s = String(value ?? "");
        // Replace control chars/newlines with spaces and collapse whitespace.
        s = s.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
        if (maxLen > 0 && s.length > maxLen) {
            s = s.slice(0, maxLen);
        }
        return s;
    }

    static createSemanticVersion(major: number, minor: number, patch: number, beta: number = -1): SemanticVersion {
        return {
            major, minor, patch, beta,
            toString(): string {
                let string = major + "." + minor + "." + patch;
                if(beta !== -1) {
                    string += "-beta." + beta;
                }
                return string;
            },
            isNewerThan(spec: SemanticVersion): boolean {
                const a = [this.major, this.minor, this.patch]
                const b = [spec.major, spec.minor, spec.patch]
                for(let i = 0; i < a.length; i++) {
                    if(a[i] > b[i]) {
                        return true;
                    } else if (a[i] < b[i]) {
                        return false;
                    }
                }
                if(this.beta === -1 && spec.beta !== -1) {
                    // 1.0.0 > 1.0.0-beta.1 == true
                    return true;
                } else if(this.beta !== -1 && spec.beta === -1) {
                    // 1.0.0-beta.1 > 1.0.0 == false
                    return false;
                } else if(this.beta !== -1 && spec.beta !== -1 && this.beta > spec.beta) {
                    // 1.0.0-beta.2 > 1.0.0-beta.1 == true
                    return true;
                }
                return false;
            }
        };
    }

    static parseSemanticVersion(version: string): SemanticVersion {
        let beta = -1;
        if(version.indexOf("-beta.") !== -1) {
            const splits = version.split("-beta.");
            version = splits[0];
            beta = parseInt(splits[1]);
        }
        const splits = version.split(".");
        return Utils.createSemanticVersion(
            parseInt(splits[0]),
            parseInt(splits[1]),
            parseInt(splits[2]),
            beta
        );
    }

    static sleep(ms: number) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    static currentSemanticVersion(): SemanticVersion {
        return Utils.parseSemanticVersion(version);
    }

    static arraycopy(src: Uint8Array, srcPos: number, dst: Uint8Array, dstPos: number, length: number) {
        for(let i = 0; i < length; i++) {
            dst[dstPos + i] = src[srcPos + i];
        }
    }

    static async fetchDaelimComplexInfo(): Promise<DaelimComplexInfo> {
        return await fetch(this.DAELIM_COMPLEX_URL)
            .then(response => response.json() as DaelimComplexInfo | any)
            .catch(reason => {
                console.error('Failed to parse complex info:');
                console.error(reason);
                return {
                    complexes: []
                }
            });
    }

    static async fetchSupportedMenus(complex: DaelimComplex): Promise<MenuItem[]> {
        const params = {
            apartId: complex.apartId,
            searchMenuGubun: "mobile"
        };

        // Avoid expired SSL certificate on the request.
        const httpsAgent = new https.Agent({
            rejectUnauthorized: false
        });

        const queryString = new URLSearchParams(params).toString();
        return await axios.post(`${this.MENU_INFO_URL}?${queryString}`, undefined, {
            responseType: "json",
            httpsAgent,
        }).then((response) => {
            return response.data;
        }).then((data: any) => {
            const items: MenuItem[] = [];
            for(const item of data["item"]) {
                if(item["menuGubun"] !== "mobile") {
                    continue;
                }
                items.push({
                    menuName: item["menuName"],
                    supported: item["useYn"] == "Y"
                });
            }
            return items;
        });
    }

    static async findMatchedComplex(regionName: string, complexName: string): Promise<DaelimComplex> {
        const info = await Utils.fetchDaelimComplexInfo();
        const regions = info.complexes;
        if(regions.length == 0) {
            throw new Error('No regions are available');
        }

        const complexes = regions
            .filter(region => region.region == regionName)
            .flatMap(region => region.complexes);
        if(complexes.length == 0) {
            throw new Error('No complexes are available');
        }

        const buildings = complexes
            .filter(complex => complex.name == complexName);
        if(buildings.length == 0) {
            throw new Error('No matched buildings are available');
        }
        return buildings[0];
    }

    static findSubType(type: Types) {
        switch (type) {
            case Types.SYSTEM:
                return SystemSubTypes;
            case Types.LOGIN:
                return LoginSubTypes;
            case Types.GUARD:
                return GuardSubTypes;
            case Types.DEVICE:
                return DeviceSubTypes;
            case Types.EMS:
                return EMSSubTypes;
            case Types.INFO:
                return InfoSubTypes;
            case Types.HEALTHCARE:
                return HealthcareSubTypes;
            case Types.SETTING:
                return SettingSubTypes;
            case Types.ELEVATOR_CALL:
                return ElevatorCallSubTypes;
            case Types.ETCETERA:
                return EtceteraSubTypes;
            case Types.APPLICATION_LOG:
                return ApplicationLogSubTypes;
            default:
                throw `Invalid SubTypes${type}`;
        }
    }

    static parseJsonSafe(text: string): any {
        try {
            return JSON.parse(text);
        } catch (e) {
            throw new Error(`Failed to parse JSON response: ${text}`);
        }
    }

    static generateUUID(key: string): string {
        return crypto
            .createHash('md5')
            .update(key)
            .digest('hex')
            .toUpperCase();
    }

    static addPadding(num: number, width: number) {
        const numString = num + "";
        return numString.length >= width ? numString : new Array(width - numString.length + 1).join("0") + numString;
    }

    static aes256Base64(plaintext: string, key: string, iv: string, algorithm: string = "aes-256-cbc") {
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

    static sha256(a: string, b: string, enc: BufferEncoding = "utf8"): string {
        const data = Buffer.concat([
            Buffer.from(a, enc),
            Buffer.from(b, enc),
        ]);
        return createHash("sha256").update(data).digest("hex");
    }
}
