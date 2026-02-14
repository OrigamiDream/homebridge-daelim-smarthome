export interface DeviceDuration {
    elevator?: number
    vehicle?: number
    door?: number
    camera?: number
}

export interface CameraConfig {
    maxStreams?: number
    maxWidth?: number
    maxHeight?: number
    codec?: "libx264" | "h264_omx" | "h264_videotoolbox" | "copy"
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