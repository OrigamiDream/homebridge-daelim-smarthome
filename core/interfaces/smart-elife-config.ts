import {SemanticVersion} from "../utils";

export interface SmartELifeConfig {
    complex: string
    username: string
    password: string
    uuid: string // This value is the same with the `dpk` header.
    roomKey?: string
    userKey?: string
    version: SemanticVersion
    wallpadVersion: string
    devices: Device[]
}

export interface Device {
    displayName: string
    name: string
    disabled: boolean
    deviceType: DeviceType
    deviceId: string
}

export enum DeviceType {
    HEATER = "heat",
    WALL_SOCKET = "wallsocket",
    LIGHT = "light",
    GAS = "gas",
    AIR_CONDITIONER = "aircon",
    AIR_CONDITIONER_2 = "aircon2",
    VENT = "vent",
    ALL_OFF_SWITCH = "alloffswitch",
}

export namespace DeviceType {
    export function parse(deviceType: string): DeviceType {
        switch(deviceType) {
            case "heat": return DeviceType.HEATER;
            case "wallsocket": return DeviceType.WALL_SOCKET;
            case "light": return DeviceType.LIGHT;
            case "gas": return DeviceType.GAS;
            case "aircon": return DeviceType.AIR_CONDITIONER;
            case "aircon2": return DeviceType.AIR_CONDITIONER_2;
            case "vent": return DeviceType.VENT;
            case "alloffswitch": return DeviceType.ALL_OFF_SWITCH;
            default:
                throw new Error(`Could not parse device type from string: ${deviceType}`);
        }
    }
}
