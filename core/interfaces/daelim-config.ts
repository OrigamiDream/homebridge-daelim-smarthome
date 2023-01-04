import {SemanticVersion} from "../utils";

export interface DaelimConfig {

    region: string,
    complex: string,
    username: string,
    password: string,
    uuid: string,
    version: SemanticVersion,
    devices: Device[]

}

export interface Device {
    displayName: string,
    name: string,
    deviceType: string,
    deviceId: string,
    disabled: boolean
}