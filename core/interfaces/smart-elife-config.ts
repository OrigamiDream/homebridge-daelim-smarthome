import {SemanticVersion} from "../utils";
import {CameraConfig, DeviceDuration} from "./config";
import {OnePassConfig} from "./smart-elife-onepass-config";

export interface SmartELifeConfig {
    username: string
    password: string
    uuid: string // This value is the same with the `dpk` header.
    roomKey?: string
    userKey?: string
    version: SemanticVersion
    wallpadVersion: string
    devices: Device[]
    onePass?: OnePassConfig
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
    SMART_DOOR = "smartdoor",
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

// The server renamed the push setting item keys around July 2026 (e.g. `car` -> `push_car`,
// `smartdoorstatus` -> `push_doorlock`), alongside the push payload format change. The values
// below are the keys /mypage/pushList.ajax currently returns. The legacy `visitor` and
// `familyenter` kinds have no observed equivalent in the new list.
export enum PushItemKind {
    UNKNOWN = "unknown",
    NOTICE = "push_notice",
    DOOR_LOCK = "push_doorlock",
    MODE_RUNNING = "push_mode",
    PASSWORD_CHANGE = "push_change_pw",
    INDOOR_AIR = "push_indoorair",
    EMS = "push_ems",
    CAR = "push_car",
    EV = "push_ev",
    CONTROL = "push_control",
    PARKING_LOT = "push_parking_lot",
    DOOR = "push_door",
    PARCEL = "push_parcel",
    MEMBER = "push_member",
    // FAMILY_ENTER = "familyenter",
    // VISITOR = "visitor",
}

export enum PushType {
    UNKNOWN = "unknown",

    // The following values are built from: data1-data2-data3, filtering out empty data.
    VISITOR = "5-32",
    CAR = "5-46",
    FRONT_DOOR = "5-61",

    // Not a wire-format value. The access (출입) push category covers both the
    // household front door and the communal door; parsing resolves to this type
    // when the notification body points to the communal door.
    COMMUNAL_DOOR = "communal-door",
}

// Since July 2026 the server sends a single `data4` code instead of the legacy
// data1/data2/data3 JSON payload. Only codes observed in the wild are mapped here;
// unknown codes fall back to matching the notification title (`TITLE_PUSH_TYPES`).
export const DATA4_PUSH_TYPES: { [code: string]: PushType } = {
    "55": PushType.FRONT_DOOR, // 도어락: "수동에 의하여 문이 열렸습니다." (sent only when push_doorlock is enabled)
    "58": PushType.CAR, // 입출차: "등록 ... 차량이 입차하였습니다."
    "64": PushType.FRONT_DOOR, // 출입: "공동 현관 출입이 감지되었습니다." (refined by body into COMMUNAL_DOOR)
};

// Fallback mapping for unmapped `data4` codes. The titles are the same category
// names that appear in /mypage/pushList.ajax (push_car: "입출차", push_door: "출입 알림").
export const TITLE_PUSH_TYPES: { [title: string]: PushType } = {
    "입출차": PushType.CAR,
    "출입": PushType.FRONT_DOOR,
};
