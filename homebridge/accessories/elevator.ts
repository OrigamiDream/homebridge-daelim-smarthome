import {Accessories, AccessoryInterface} from "./accessories";
import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback,
    CharacteristicSetCallback,
    CharacteristicValue,
    Logging,
    PlatformAccessory,
    Service
} from "homebridge";
import {DaelimConfig} from "../../core/interfaces/daelim-config";
import {ElevatorCallSubTypes, Types} from "../../core/fields";

interface ElevatorAccessoryInterface extends AccessoryInterface {

    timeoutId: number
    called: boolean

}

export const ELEVATOR_DEVICE_ID = "EV-000000";
export const ELEVATOR_DISPLAY_NAME = "엘레베이터";
export const ELEVATOR_TIMEOUT_DURATION = 30; // 30 seconds
export const ELEVATOR_MENU_NAME = "엘리베이터 콜";

export class ElevatorAccessories extends Accessories<ElevatorAccessoryInterface> {

    constructor(log: Logging, api: API, config: DaelimConfig) {
        super(log, api, config, ["elevator"], [api.hap.Service.Switch]);
    }

    async identify(accessory: PlatformAccessory): Promise<void> {
        await super.identify(accessory);

        this.log.warn("Identifying Elevator accessories is not possible.");
    }

    configureAccessory(accessory: PlatformAccessory, services: Service[]) {
        super.configureAccessory(accessory, services);
        const service = this.ensureServiceAvailability(this.api.hap.Service.Switch, services);
        service.getCharacteristic(this.api.hap.Characteristic.On)
            .on(CharacteristicEventTypes.SET, async (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                if(accessory.context.called) {
                    if(!value) {
                        // If the elevator have called, but attempt to set not-called state
                        const nextState = accessory.context.called;
                        setTimeout(() => {
                            service.setCharacteristic(this.api.hap.Characteristic.On, nextState);
                        }, 0);
                    }
                    callback(undefined);
                    return;
                }
                if(!!value) {
                    const response = await this.client?.sendDeferredRequest(
                        {},
                        Types.ELEVATOR_CALL,
                        ElevatorCallSubTypes.CALL_REQUEST,
                        ElevatorCallSubTypes.CALL_RESPONSE,
                        (_) => true
                    ).catch(_ => {
                        return undefined;
                    });
                    if(response === undefined) {
                        callback(new Error('TIMED OUT'));
                        return;
                    }
                    this.enqueueElevatorCallTimeout(accessory);
                }
                accessory.context.init = true;
                accessory.context.called = value;
                callback(undefined);
            })
            .on(CharacteristicEventTypes.GET, async (callback: CharacteristicGetCallback) => {
                this.client?.checkKeepAlive();
                callback(undefined, accessory.context.called);
            });
    }

    enqueueElevatorCallTimeout(accessory: PlatformAccessory) {
        if(accessory.context.timeoutId !== -1) {
            clearTimeout(accessory.context.timeoutId);
        }
        const device = this.findDeviceInfoFromAccessory(accessory);
        accessory.context.timeoutId = setTimeout(() => {
            this.invalidateElevatorContextState();
        }, (device?.duration?.elevator || ELEVATOR_TIMEOUT_DURATION) * 1000);
    }

    invalidateElevatorContextState() {
        const accessory = this.findAccessoryWithDeviceID(ELEVATOR_DEVICE_ID);
        if(accessory) {
            if(accessory.context.timeoutId !== -1) {
                clearTimeout(accessory.context.timeoutId);
            }
            accessory.context.timeoutId = -1;
            accessory.context.called = false;
            this.findService(accessory, this.api.hap.Service.Switch, (service) => {
                service.setCharacteristic(this.api.hap.Characteristic.On, accessory.context.called);
            });
        }
    }

    registerAccessories() {
        if(!this.client?.isDeviceSupported(ELEVATOR_MENU_NAME)) {
            return;
        }
        this.addAccessory({
            deviceID: ELEVATOR_DEVICE_ID,
            displayName: ELEVATOR_DISPLAY_NAME,
            init: false, // Lazy-init when characteristic update
            timeoutId: -1,
            called: false // inactive as a default since this is on-only switch
        });
    }

}