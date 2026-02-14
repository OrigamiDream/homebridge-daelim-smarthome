import {SemanticVersion} from "../utils";
import {CameraConfig, DeviceDuration} from "./config";

export interface SmartELifeConfig {
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
    camera?: CameraConfig
    duration?: DeviceDuration
}

export enum ControlQueryCategory {
    USER_MODE = "user_mode",
    ELEVATOR = "elevator",
    CONTROL = "control",
    BOARD = "board",
}

export enum DeviceType {
    UNKNOWN = "unknown",
    HEATER = "heat",
    WALL_SOCKET = "wallsocket",
    LIGHT = "light",
    GAS = "gas",
    AIR_CONDITIONER = "aircon",
    AIR_CONDITIONER_2 = "aircon2",
    VENT = "vent",
    ALL_OFF_SWITCH = "alloffswitch",
    INDOOR_AIR_QUALITY = "indoorair",
    ELEVATOR = "elevator",
    DOOR = "door",
    VEHICLE = "vehicle",
    CAMERA = "camera",
}

export interface PushItem {
    kind: PushItemKind
    name: string
    hasSmartdoor: boolean
    enabled: boolean
    desc?: string
}

export enum PushItemKind {
    UNKNOWN = "unknown",
    GAS = "gas",
    FAMILY_ENTER = "familyenter",
    NEW_BOARD = "boardnew",
    ENTRANCE_PASSWORD_CHANGE = "entpw",
    NEW_NOTICE = "notice",
    HEATING = "heating",
    WALL_SOCKET = "wallsocket",
    SMART_DOOR_STATUS = "smartdoorstatus",
    SECURITY = "OUTING",
    SECURITY_PASSWORD_CHANGE = "secpw",
    VISITOR = "visitor",
    MODE_RUNNING = "moderun",
    AIR_CONDITIONER = "aircon",
    EMS = "ems",
    ELEVATOR = "elevator",
    ALL_OFF_SWITCH = "allofswitch",
    ONE_TIME_KEY = "onetimekey",
    CAR = "car",
    LIGHT = "light",
    DOOR = "door",
    CARE_SERVICE = "careservice",
    PARCEL = "parcel",
    VENT = "vent",
    NEW_USER = "usernew",
    UNREGISTER_USER = "userout",
}

export enum PushType {
    UNKNOWN = "unknown",

    // The following values are built from: data1-data2-data3, filtering out empty data.
    VISITOR = "5-32",
    CAR = "5-46",
    FRONT_DOOR = "5-61",
}
