import fetch from "node-fetch";
import {
    ApplicationLogSubTypes,
    DeviceSubTypes, ElevatorCallSubTypes,
    EMSSubTypes, EtceteraSubTypes,
    GuardSubTypes,
    HealthcareSubTypes,
    InfoSubTypes,
    LoginSubTypes, SettingSubTypes,
    SystemSubTypes,
    Types
} from "./fields";

export class Utils {

    public static PLUGIN_NAME = "homebridge-daelim-smarthome"
    public static PLATFORM_NAME = "DaelimSmartHomePlatform"

    public static URL = "https://smarthome.daelimcorp.co.kr/main/choice_1.do";

    public static AREA_REGEX = /{area( |\n|):( |\n|)"(.*)"( |\n|),( |\n|)citys( |\n|):( |\n|)\[(.*)]}/gi;
    public static REGION_REGEX = /region\.push\({(.*( |\n|))+?}\)/gi;

    static arraycopy(src: Uint8Array, srcPos: number, dst: Uint8Array, dstPos: number, length: number) {
        for(let i = 0; i < length; i++) {
            dst[dstPos + i] = src[srcPos + i];
        }
    }

    static async fetchComplexInfo() {
        const areas = [];
        const regions = [];

        const response = await fetch(this.URL).then(response => response.text()).catch(reason => {
            console.error(reason);
            return "";
        });
        const trimmed = response.split("\n").map(str => str.trim()).join("\n");

        // Interprocess areas raw array
        const areasRawArray = trimmed.match(this.AREA_REGEX) || [];
        for(const raw of areasRawArray) {
            areas.push(JSON.parse(raw.replace('area', '\"area\"').replace('citys', '\"citys\"')));
        }

        // Interprocess regions raw array
        const regionsRawArray = trimmed.match(this.REGION_REGEX) || [];
        for(const raw of regionsRawArray) {
            let str = raw.substring('region.push('.length);
            str = str.substring(0, str.length - ')'.length);
            str = str.split('\n').map(line => {
                if(line.indexOf(':') !== -1) {
                    const split = line.split(':');
                    const key = split[0].trim();
                    return `"${key}":${split[1]}`
                } else {
                    return line;
                }
            }).join('\n');
            regions.push(JSON.parse(str));
        }
        return {
            areas, regions
        }
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
            case Types.ELEVATOR_CELL:
                return ElevatorCallSubTypes;
            case Types.ETCETERA:
                return EtceteraSubTypes;
            case Types.APPLICATION_LOG:
                return ApplicationLogSubTypes;
            default:
                throw `Invalid SubTypes${type}`;
        }
    }

}