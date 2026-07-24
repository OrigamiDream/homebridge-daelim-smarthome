import Accessories, {AccessoryInterface} from "./accessories";
import {
    API,
    CharacteristicEventTypes, CharacteristicGetCallback,
    CharacteristicSetCallback,
    CharacteristicValue,
    Logging,
    PlatformAccessory
} from "homebridge";
import {Device, DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import {
    beginElevatorCall,
    completeElevatorCallRequest,
    ElevatorCallState,
    isElevatorCallActive,
    normalizeElevatorCallState,
    reduceElevatorServerEvent,
} from "../../../core/smart-elife/elevator-protocol";
import {EXTERIOR_ELEVATOR_DEVICE} from "../../../core/smart-elife/exterior-devices";
import Timeout = NodeJS.Timeout;

interface ElevatorAccessoryInterface extends AccessoryInterface {
    switchTimer?: Timeout
    callState: ElevatorCallState
    requestSequence: number

    motionTimer?: Timeout
    motionDetected: boolean
}

const ELEVATOR_MOTION_DURATION_TIMEOUT_SECONDS = 5; // 5 seconds
const ELEVATOR_CALL_FALLBACK_TIMEOUT_SECONDS = 120; // 2 minutes

export default class ElevatorAccessories extends Accessories<ElevatorAccessoryInterface> {
    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.ELEVATOR, [api.hap.Service.Switch, api.hap.Service.MotionSensor]);
    }

    private clearSwitchTimer(context: ElevatorAccessoryInterface) {
        if(context.switchTimer) {
            clearTimeout(context.switchTimer);
            context.switchTimer = undefined;
        }
    }

    private updateSwitch(accessory: PlatformAccessory) {
        const context = this.getAccessoryInterface(accessory);
        context.callState = normalizeElevatorCallState(context.callState);
        this.getService(accessory, this.api.hap.Service.Switch)
            .getCharacteristic(this.api.hap.Characteristic.On)
            .updateValue(isElevatorCallActive(context.callState));
    }

    private queueSwitchUpdate(accessory: PlatformAccessory) {
        setTimeout(() => this.updateSwitch(accessory), 0);
    }

    private releaseCall(accessory: PlatformAccessory) {
        const context = this.getAccessoryInterface(accessory);
        this.clearSwitchTimer(context);
        context.callState = ElevatorCallState.IDLE;
        this.updateSwitch(accessory);
    }

    private armSwitchFallback(accessory: PlatformAccessory, device: Device) {
        const context = this.getAccessoryInterface(accessory);
        if(context.switchTimer) return;

        let timer: Timeout;
        timer = setTimeout(() => {
            const current = this.getAccessoryInterface(accessory);
            if(current.switchTimer !== timer) return;

            current.switchTimer = undefined;
            current.callState = ElevatorCallState.IDLE;
            this.updateSwitch(accessory);
        }, (device.duration?.elevator ?? ELEVATOR_CALL_FALLBACK_TIMEOUT_SECONDS) * 1000);
        context.switchTimer = timer;
    }

    private triggerArrivalMotion(accessory: PlatformAccessory) {
        const context = this.getAccessoryInterface(accessory);
        if(context.motionTimer) clearTimeout(context.motionTimer);

        context.motionDetected = true;
        this.getService(accessory, this.api.hap.Service.MotionSensor)
            .getCharacteristic(this.api.hap.Characteristic.MotionDetected)
            .updateValue(true);

        let timer: Timeout;
        timer = setTimeout(() => {
            const current = this.getAccessoryInterface(accessory);
            if(current.motionTimer !== timer) return;

            current.motionTimer = undefined;
            current.motionDetected = false;
            this.getService(accessory, this.api.hap.Service.MotionSensor)
                .getCharacteristic(this.api.hap.Characteristic.MotionDetected)
                .updateValue(false);
        }, ELEVATOR_MOTION_DURATION_TIMEOUT_SECONDS * 1000);
        context.motionTimer = timer;
    }

    configureAccessory(accessory: PlatformAccessory) {
        super.configureAccessory(accessory);
        this.getService(accessory, this.api.hap.Service.Switch)
            .getCharacteristic(this.api.hap.Characteristic.On)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                context.callState = normalizeElevatorCallState(context.callState);
                context.requestSequence = context.requestSequence || 0;

                const called = value as boolean;
                if(!called) {
                    // The app disables its button once the server reports progressing. Keep the
                    // short local request transaction atomic as well, and restore the authoritative
                    // state without re-entering this SET handler.
                    callback(undefined);
                    this.queueSwitchUpdate(accessory);
                    return;
                }

                const attempt = beginElevatorCall(context.callState);
                if(!attempt.accepted) {
                    if(context.callState === ElevatorCallState.UNKNOWN) {
                        callback(new Error("Elevator call status is not ready."));
                    } else {
                        // Coalesce duplicate writes during the same HTTP request, and mirror the
                        // disabled app button once the server reports progressing.
                        callback(undefined);
                    }
                    this.queueSwitchUpdate(accessory);
                    return;
                }

                const device = this.findDevice(EXTERIOR_ELEVATOR_DEVICE.deviceId);
                if(!device) {
                    callback(new Error(`Unknown device: ${context.deviceId}`));
                    return;
                }

                context.callState = attempt.state;
                const requestSequence = ++context.requestSequence;
                this.armSwitchFallback(accessory, device);

                let success = false;
                let requestError: unknown;
                try {
                    success = await this.client.sendElevatorCallQuery();
                } catch(error) {
                    requestError = error;
                }

                const current = this.getAccessoryInterface(accessory);
                const isCurrentRequest = current.requestSequence === requestSequence;
                if(!success) {
                    if(isCurrentRequest && current.callState === ElevatorCallState.PROGRESSING) {
                        // The WebSocket status is authoritative, just as it is in the original UI.
                        // Keep the switch active if the server confirmed movement even when the
                        // independent HTTP response failed or was lost.
                        this.log.warn("Elevator call HTTP response failed after the server reported progressing.");
                        callback(undefined);
                    } else {
                        if(isCurrentRequest && current.callState === ElevatorCallState.REQUESTING) {
                            this.releaseCall(accessory);
                        }
                        if(requestError) {
                            this.log.error("Could not call the elevator: %s", (requestError as Error)?.message || requestError);
                        }
                        callback(new Error("Failed to set the device state."));
                    }
                    this.queueSwitchUpdate(accessory);
                    return;
                }

                // Server events may have advanced or completed this request during the HTTP
                // round trip. The HTTP success itself does not mean the car is moving; the app
                // disables its button only after `progressing`. If that status has not arrived,
                // return to idle and let a later WebSocket event authoritatively activate it.
                if(isCurrentRequest) {
                    const completedState = completeElevatorCallRequest(current.callState);
                    if(completedState !== current.callState) {
                        this.releaseCall(accessory);
                    }
                }
                callback(undefined);
                this.queueSwitchUpdate(accessory);
            })
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                context.callState = normalizeElevatorCallState(context.callState);
                callback(undefined, isElevatorCallActive(context.callState));
            });

        this.getService(accessory, this.api.hap.Service.MotionSensor)
            .getCharacteristic(this.api.hap.Characteristic.MotionDetected)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.motionDetected);
            });
    }

    register() {
        super.register();

        // Create/reset the virtual accessory before the WebSocket connects. The app requests
        // elevator status immediately on open, and dropping that first snapshot would leave the
        // HomeKit switch permanently in the unknown/loading state.
        const device = EXTERIOR_ELEVATOR_DEVICE;
        if(this.findDevice(device.deviceId)) {
            this.addOrGetAccessory({
                deviceId: device.deviceId,
                deviceType: device.deviceType,
                displayName: device.displayName,
                init: true,
                switchTimer: undefined,
                callState: ElevatorCallState.UNKNOWN,
                requestSequence: 0,
                motionTimer: undefined,
                motionDetected: false,
            });
        }

        this.addListener((data, _error, metadata) => {
            if(!data) return;

            const configuredDevice = this.findDevice(EXTERIOR_ELEVATOR_DEVICE.deviceId);
            if(!configuredDevice) return;

            const accessory = this.findAccessory(configuredDevice.deviceId);
            if(!accessory) return;

            const context = this.getAccessoryInterface(accessory);
            const transition = reduceElevatorServerEvent(
                normalizeElevatorCallState(context.callState),
                metadata?.action,
                data["rerection"],
            );
            if(!transition.recognized) return;

            context.callState = transition.state;
            if(isElevatorCallActive(transition.state)) {
                this.armSwitchFallback(accessory, configuredDevice);
            } else {
                this.clearSwitchTimer(context);
            }
            this.updateSwitch(accessory);

            // Only `elevate_call` is the app's arrival event. `unprogressing` is an idle status
            // and releases the switch without fabricating motion during startup or reconnect.
            if(transition.arrival) {
                this.triggerArrivalMotion(accessory);
            }
        });
    }
}
