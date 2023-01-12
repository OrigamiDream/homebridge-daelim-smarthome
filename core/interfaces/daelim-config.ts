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
    disabled: boolean,
    camera?: CameraConfig
}

export interface CameraConfig {
    maxStreams?: number
    maxWidth?: number
    maxHeight?: number
    codec?: "libx264" | "h264_omx" | "h264_videotoolbox" | "copy";
    packetSize?: number
    forceMax: boolean
    videoFilter?: string
    encoderOptions?: string
    mapVideo?: string
    mapAudio?: string
    audio: boolean
    returnAudioTarget?: string
}

export function defaultCameraConfig(): CameraConfig {
    return {
        forceMax: false,
        audio: false
    };
}