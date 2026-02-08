import {SemanticVersion} from "../utils";

export interface SmartELifeConfig {
    complex: string
    username: string
    password: string
    uuid: string // This value is the same with the `dpk` header.
    version: SemanticVersion
    devices: Device[]
}

export enum DeviceType {
    BOARD,
    SECURITY,
    DEVICE,
}

export namespace DeviceType {
    export function parse(deviceType: string): DeviceType {
        switch(deviceType) {
            case "board":
                return DeviceType.BOARD;
            case "security":
                return DeviceType.SECURITY;
            case "device":
                return DeviceType.DEVICE;
            default:
                throw new Error(`Prohibited device type: ${deviceType}`);
        }
    }
}

export enum DeviceItemType {
    CHARGING,
    PARKING,
    FAMILY_LOCATION,
    PARCEL,
    VISITOR,
    MODE, // Security mode
    INDOOR_AIR,
    HISTORY,
    ENERGY,
    VISITOR_CAR,
    LIGHT,
    GAS,
    HEATER,
    VENT,
    WALL_SOCKET,
    AIR_CONDITIONER,
}

export namespace DeviceItemType {
    export function parse(deviceItemType: string): DeviceItemType {
        switch(deviceItemType) {
            case "charge": return DeviceItemType.CHARGING;
            case "parking": return DeviceItemType.PARKING;
            case "family_location": return DeviceItemType.FAMILY_LOCATION;
            case "parcel": return DeviceItemType.PARCEL;
            case "visitor": return DeviceItemType.VISITOR;
            case "mode": return DeviceItemType.MODE;
            case "indoorair": return DeviceItemType.INDOOR_AIR;
            case "history": return DeviceItemType.HISTORY;
            case "energy": return DeviceItemType.ENERGY;
            case "visitorCar": return DeviceItemType.VISITOR_CAR;
            case "light": return DeviceItemType.LIGHT;
            case "gas": return DeviceItemType.GAS;
            case "heat": return DeviceItemType.HEATER;
            case "vent": return DeviceItemType.VENT;
            case "wallsocket": return DeviceItemType.WALL_SOCKET;
            case "aircon": return DeviceItemType.AIR_CONDITIONER;
            default:
                throw new Error(`Prohibited device item type: ${deviceItemType}`);
        }
    }
}

export interface Device {
    displayName: string
    disabled: boolean
    deviceType: DeviceType
    deviceItemType: DeviceItemType
    uid: string
}
