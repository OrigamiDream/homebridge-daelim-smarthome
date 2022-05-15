import fetch from "node-fetch";
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
} from "./fields";
import {Complex, ComplexInfo} from "./interfaces/complex";

export class Utils {

    public static PLUGIN_NAME = "homebridge-daelim-smarthome";
    public static PLATFORM_NAME = "DaelimSmartHomePlatform";
    public static MANUFACTURER_NAME = "DL E&C Co.,Ltd.";

    public static COMPLEX_URL = "https://raw.githubusercontent.com/OrigamiDream/homebridge-daelim-smarthome/master/complexes/complexes.json";

    static arraycopy(src: Uint8Array, srcPos: number, dst: Uint8Array, dstPos: number, length: number) {
        for(let i = 0; i < length; i++) {
            dst[dstPos + i] = src[srcPos + i];
        }
    }

    static async fetchComplexInfo(): Promise<ComplexInfo> {
        return await fetch(this.COMPLEX_URL)
            .then(response => response.json() as ComplexInfo | any)
            .catch(reason => {
                console.error('Failed to parse complex info:');
                console.error(reason);
                return {
                    complexes: []
                }
            });
    }

    static async findMatchedComplex(regionName: string, complexName: string): Promise<Complex> {
        const info = await Utils.fetchComplexInfo();
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

}