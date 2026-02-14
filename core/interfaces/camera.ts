import Timeout = NodeJS.Timeout;

export interface CameraInfo {
    snapshot?: Buffer
}

export interface CameraAccessoryInterfaceBase {
    cameraDisplayName: string
    cameraInfo?: CameraInfo
    motionTimer?: Timeout
    motionDetected: boolean
    recordingActive: boolean
    eventSnapshotsActive: boolean
    cameraActive: boolean
    periodicSnapshotsActive: boolean
}
