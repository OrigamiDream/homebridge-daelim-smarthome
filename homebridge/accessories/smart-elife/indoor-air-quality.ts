import Accessories, {AccessoryInterface} from "./accessories";
import {
    API,
    CharacteristicEventTypes,
    CharacteristicGetCallback,
    CharacteristicValue,
    Logging,
    PlatformAccessory
} from "homebridge";
import {DeviceType, SmartELifeConfig} from "../../../core/interfaces/smart-elife-config";
import {Utils} from "../../../core/utils";
import {setGlobalIndoorRelativeHumidity} from "./indoor-air-quality-cache";

interface IndoorAirQualityAccessoryInterface extends AccessoryInterface {
    pm10: DensityWithQuality
    pm2_5: DensityWithQuality
    co2: DensityWithQuality
    vocs: DensityWithQuality
    temperature: number
    humidity: number
}

interface DensityWithQuality {
    density: number
    quality: AirQuality
}

enum AirQuality {
    VERY_BAD = "very-bad",
    BAD = "bad",
    NORMAL = "normal",
    GOOD = "good",
}

namespace AirQuality {
    export function parse(quality: string): AirQuality {
        switch(quality) {
            case "very-bad": return AirQuality.VERY_BAD;
            case "bad": return AirQuality.BAD;
            case "normal": return AirQuality.NORMAL;
            case "good": return AirQuality.GOOD;
            default: throw new Error(`Prohibited air quality: ${quality}`);
        }
    }
    export function score(quality: AirQuality): number {
        switch(quality) {
            case AirQuality.VERY_BAD: return 5;
            case AirQuality.BAD: return 3;
            case AirQuality.NORMAL: return 1;
            case AirQuality.GOOD: return 0;
        }
    }
}

const INDOOR_AIR_QUALITY_POLLING_INTERVAL_MILLISECONDS = 60 * 1000;

export default class IndoorAirQualityAccessories extends Accessories<IndoorAirQualityAccessoryInterface> {

    private skippedFirstPollingMessage: boolean = false;

    constructor(log: Logging, api: API, config: SmartELifeConfig) {
        super(log, api, config, DeviceType.INDOOR_AIR_QUALITY, [
            api.hap.Service.AirQualitySensor,
            api.hap.Service.TemperatureSensor,
            api.hap.Service.HumiditySensor,
        ]);
    }

    getAirQuality(context: IndoorAirQualityAccessoryInterface): CharacteristicValue {
        const q = [ context.pm10, context.pm2_5, context.co2, context.vocs ]
            .map((q) => AirQuality.score(q.quality));
        const sum = q.reduce((acc, n) => acc + n, 0);
        const avg = sum / q.length;
        return parseInt(avg.toFixed(0)) as CharacteristicValue;
    }

    async fetchAirQuality() {
        if(this.skippedFirstPollingMessage) {
            this.log.info(`Polling device state :: ${this.deviceType.toString()} (${this.accessories.length} accessories)`);
        }
        this.skippedFirstPollingMessage = true;

        const response = await this.client.sendHttpJson("/monitoring/getAirList.ajax", { location: "all" });
        if(!response["data"]) {
            const message = response["result"]["errorMessage"].replace(/(<br\/>)/gi, " ");
            const code = response["result"]["status"];
            this.log.warn("Devices (%s) not found: (%s) %s", this.deviceType.toString(), code, message);
            return;
        }
        const devices = response["data"]["list"];
        let humiditySum = 0;
        let humidityCount = 0;
        let index = 0;
        for(const info of devices) {
            index++;

            const deviceId = `CMFIAQ${Utils.addPadding(index, 3)}`;
            const device = this.findDevice(deviceId);
            if(!device) continue;

            const humidity = Number(info["humi"]);
            if(Number.isFinite(humidity)) {
                humiditySum += humidity;
                humidityCount += 1;
            }

            this.addOrGetAccessory({
                deviceId: device.deviceId,
                deviceType: device.deviceType,
                displayName: device.displayName,
                init: true,
                pm10: { density: info["pm10"]["value"], quality: AirQuality.parse(info["pm10"]["css"]) },
                pm2_5: { density: info["pm25"]["value"], quality: AirQuality.parse(info["pm25"]["css"]) },
                co2: { density: info["co2"]["value"], quality: AirQuality.parse(info["co2"]["css"]) },
                vocs: { density: info["vocs"]["value"], quality: AirQuality.parse(info["vocs"]["css"]) },
                temperature: Number(info["temp"]),
                humidity,
            });
        }
        if(humidityCount > 0) {
            setGlobalIndoorRelativeHumidity(humiditySum / humidityCount);
        }
    }

    configureAirQuality(accessory: PlatformAccessory) {
        this.getService(accessory, this.api.hap.Service.AirQualitySensor)
            .getCharacteristic(this.api.hap.Characteristic.AirQuality)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, this.getAirQuality(context));
            });
        this.getService(accessory, this.api.hap.Service.AirQualitySensor)
            .getCharacteristic(this.api.hap.Characteristic.PM10Density)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.pm10.density);
            });
        this.getService(accessory, this.api.hap.Service.AirQualitySensor)
            .getCharacteristic(this.api.hap.Characteristic.PM2_5Density)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.pm2_5.density);
            });
        this.getService(accessory, this.api.hap.Service.AirQualitySensor)
            .getCharacteristic(this.api.hap.Characteristic.VOCDensity)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.vocs.density);
            });
    }

    configureAccessory(accessory: PlatformAccessory) {
        super.configureAccessory(accessory);

        this.configureAirQuality(accessory);

        // Temperature
        this.getService(accessory, this.api.hap.Service.TemperatureSensor)
            .getCharacteristic(this.api.hap.Characteristic.CurrentTemperature)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.temperature);
            });
        // Humidity
        this.getService(accessory, this.api.hap.Service.HumiditySensor)
            .getCharacteristic(this.api.hap.Characteristic.CurrentRelativeHumidity)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, context.humidity);
            });
    }

    register() {
        super.register();

        setTimeout(this.fetchAirQuality.bind(this), 1000); // immediate run (asynchronously)
        setInterval(this.fetchAirQuality.bind(this), INDOOR_AIR_QUALITY_POLLING_INTERVAL_MILLISECONDS);
    }
}
