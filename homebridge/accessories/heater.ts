import {HeaterCoolerAccessories, HeaterCoolerAccessoryInterface} from "./heater-cooler";
import {API, Characteristic, CharacteristicValue, Logging, PlatformAccessory} from "homebridge";
import {DaelimConfig} from "../../core/interfaces/daelim-config";
import {WithUUID} from "hap-nodejs";

export class HeaterAccessories extends HeaterCoolerAccessories {

    constructor(log: Logging, api: API, config: DaelimConfig) {
        super(log, api, config, ["heating", "heater"], 5, 40);
    }

    getAvailableCurrentHeaterCoolerStates(): number[] {
        return [
            this.api.hap.Characteristic.CurrentHeaterCoolerState.INACTIVE,
            this.api.hap.Characteristic.CurrentHeaterCoolerState.IDLE,
            this.api.hap.Characteristic.CurrentHeaterCoolerState.HEATING,
        ];
    }

    getAvailableTargetHeaterCoolerStates(): number[] {
        return [
            this.api.hap.Characteristic.TargetHeaterCoolerState.HEAT
        ];
    }

    getCurrentHeaterCoolerState(accessory: PlatformAccessory): CharacteristicValue {
        const context = accessory.context as HeaterCoolerAccessoryInterface;
        if(context.active && context.desiredTemperature > context.currentTemperature) {
            return this.api.hap.Characteristic.CurrentHeaterCoolerState.HEATING;
        }
        return this.api.hap.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }

    getTargetHeaterCoolerState(): CharacteristicValue {
        return this.api.hap.Characteristic.TargetHeaterCoolerState.HEAT;
    }

    getThresholdTemperatureCharacteristic(): WithUUID<{ new(): Characteristic }> {
        return this.api.hap.Characteristic.HeatingThresholdTemperature;
    }

}
