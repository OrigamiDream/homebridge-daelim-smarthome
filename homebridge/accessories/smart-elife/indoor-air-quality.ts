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
    UNKNOWN = "unknown",
}

namespace AirQuality {
    export function parse(quality: string): AirQuality {
        switch(quality) {
            case "very-bad": return AirQuality.VERY_BAD;
            case "bad": return AirQuality.BAD;
            case "normal": return AirQuality.NORMAL;
            case "good": return AirQuality.GOOD;
            // Unexpected `css` value: degrade gracefully instead of throwing, so one odd
            // reading can't abort the whole polling cycle (and the humidity aggregation
            // the A/C dehumidifier depends on).
            default: return AirQuality.UNKNOWN;
        }
    }
    // Maps a sensor grade to a HomeKit `Characteristic.AirQuality` value:
    //   0 = UNKNOWN, 1 = EXCELLENT, 2 = GOOD, 3 = FAIR, 4 = INFERIOR, 5 = POOR.
    // Note: `good` must map to EXCELLENT (1), NOT 0 — 0 renders as "Unknown" in Home.
    export function toHomeKitAirQuality(quality: AirQuality): number {
        switch(quality) {
            case AirQuality.GOOD: return 1;      // EXCELLENT
            case AirQuality.NORMAL: return 2;    // GOOD
            case AirQuality.BAD: return 4;       // INFERIOR
            case AirQuality.VERY_BAD: return 5;  // POOR
            case AirQuality.UNKNOWN: return 0;   // UNKNOWN
        }
    }
}

const INDOOR_AIR_QUALITY_POLLING_INTERVAL_MILLISECONDS = 60 * 1000;

// Apple-defined density characteristics (PM10Density, PM2_5Density, VOCDensity) only
// accept 0–1000 µg/m³, but the wall pad grades TVOC on its own 0–1500 scale (the feed's
// `max` field; readings up to ~1944 observed) with no unit metadata, so values above
// 1000 arrive routinely. Clamp into the valid range instead of raising maxValue via
// setProps; the air-quality grade shown in Home comes from `css`, not the raw density.
const HOMEKIT_DENSITY_MAX = 1000;

function clampDensity(density: number): number {
    if(!Number.isFinite(density)) {
        return 0;
    }
    return Math.max(0, Math.min(HOMEKIT_DENSITY_MAX, density));
}

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
        // Overall air quality reflects the worst-graded pollutant (the standard HomeKit
        // convention), ignoring UNKNOWN(0) grades unless every pollutant is unknown.
        const values = [ context.pm10, context.pm2_5, context.co2, context.vocs ]
            .map((q) => AirQuality.toHomeKitAirQuality(q.quality))
            .filter((v) => v > 0);
        if(values.length === 0) {
            return 0 as CharacteristicValue; // UNKNOWN
        }
        return Math.max(...values) as CharacteristicValue;
    }

    async fetchAirQuality() {
        if(this.skippedFirstPollingMessage) {
            this.log.info(`Polling device state :: ${this.deviceType.toString()} (${this.accessories.length} accessories)`);
        }
        this.skippedFirstPollingMessage = true;

        const response = await this.client.sendHttpJson("/monitoring/getAirList.ajax", { location: "all" });
        if(!response || !response["data"]) {
            const message = (response?.["result"]?.["errorMessage"] ?? "unknown reason").replace(/(<br\/>)/gi, " ");
            const code = response?.["result"]?.["status"] ?? "";
            this.log.warn("Devices (%s) not found: (%s) %s", this.deviceType.toString(), code, message);
            return;
        }
        const devices = response["data"]["list"] || [];
        let humiditySum = 0;
        let humidityCount = 0;
        let index = 0;
        for(const info of devices) {
            index++;

            const deviceId = `CMFIAQ${Utils.addPadding(index, 3)}`;
            const device = this.findDevice(deviceId);
            if(!device) continue;

            // Isolate per-device parsing so one malformed reading cannot abort the rest of
            // the cycle (including the humidity aggregation below).
            try {
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
                    pm10: { density: Number(info["pm10"]["value"]), quality: AirQuality.parse(info["pm10"]["css"]) },
                    pm2_5: { density: Number(info["pm25"]["value"]), quality: AirQuality.parse(info["pm25"]["css"]) },
                    co2: { density: Number(info["co2"]["value"]), quality: AirQuality.parse(info["co2"]["css"]) },
                    vocs: { density: Number(info["vocs"]["value"]), quality: AirQuality.parse(info["vocs"]["css"]) },
                    temperature: Number(info["temp"]),
                    humidity,
                });
            } catch(e: any) {
                this.log.warn("Could not parse air-quality reading for %s: %s", device.displayName, e?.message || e);
            }
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
                callback(undefined, clampDensity(context.pm10.density));
            });
        this.getService(accessory, this.api.hap.Service.AirQualitySensor)
            .getCharacteristic(this.api.hap.Characteristic.PM2_5Density)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, clampDensity(context.pm2_5.density));
            });
        this.getService(accessory, this.api.hap.Service.AirQualitySensor)
            .getCharacteristic(this.api.hap.Characteristic.VOCDensity)
            .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                const context = this.getAccessoryInterface(accessory);
                callback(undefined, clampDensity(context.vocs.density));
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

        // Wrap the scheduled polls so a rejected fetch (network/CSRF failure) is logged
        // instead of surfacing as an unhandled promise rejection.
        const run = () => {
            this.fetchAirQuality().catch((e: any) => {
                this.log.warn("Air-quality polling failed: %s", e?.message || e);
            });
        };
        setTimeout(run, 1000); // immediate run (asynchronously)
        setInterval(run, INDOOR_AIR_QUALITY_POLLING_INTERVAL_MILLISECONDS);
    }
}
