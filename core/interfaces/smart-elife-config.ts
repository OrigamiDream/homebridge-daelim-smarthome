import {SemanticVersion} from "../utils";

export interface SmartELifeConfig {
    complex: string
    username: string
    password: string
    uuid: string // This value is the same with the `dpk` header.
    version: SemanticVersion
    devices: Device[]
}

export interface Device {
    disabled: boolean
}
