import {SemanticVersion} from "../utils";

export interface SmartELifeConfig {
    complex: string
    username: string
    password: string
    uuid: string // This value is the same with the `dpk` header.
    roomKey?: string
    userKey?: string
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

    export function toString(deviceType: DeviceType): string {
        switch(deviceType) {
            case DeviceType.BOARD: return "board"
            case DeviceType.SECURITY: return "security"
            case DeviceType.DEVICE: return "device"
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

    export function toString(deviceItemType: DeviceItemType): string {
        switch(deviceItemType) {
            case DeviceItemType.CHARGING: return "charge";
            case DeviceItemType.PARKING: return "parking";
            case DeviceItemType.FAMILY_LOCATION: return "family_location";
            case DeviceItemType.PARCEL: return "parcel";
            case DeviceItemType.VISITOR: return "visitor";
            case DeviceItemType.MODE: return "mode";
            case DeviceItemType.INDOOR_AIR: return "indoorair";
            case DeviceItemType.HISTORY: return "history";
            case DeviceItemType.ENERGY: return "energy";
            case DeviceItemType.VISITOR_CAR: return "visitorCar";
            case DeviceItemType.LIGHT: return "light";
            case DeviceItemType.GAS: return "gas";
            case DeviceItemType.HEATER: return "heat";
            case DeviceItemType.VENT: return "vent";
            case DeviceItemType.WALL_SOCKET: return "wallsocket";
            case DeviceItemType.AIR_CONDITIONER: return "aircon";
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
