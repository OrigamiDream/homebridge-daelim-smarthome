import {SemanticVersion} from "../utils";

export interface SmartELifeConfig {
    complex: string
    username: string
    password: string
    uuid: string
    version: SemanticVersion
    devices: Device[]
}

export interface Device {
    disabled: boolean
}
