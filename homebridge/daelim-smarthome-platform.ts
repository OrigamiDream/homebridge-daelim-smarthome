import {API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig,} from "homebridge";
import {Utils} from "../core/utils";
import AbstractSmartHomePlatform from "./platforms/platform";
import DaelimPlatform from "./platforms/daelim";
import SmartELifePlatform from "./platforms/smart-elife";

export = (api: API) => {
    api.registerPlatform(Utils.PLATFORM_NAME, DaelimSmartHomePlatform);
}

class DaelimSmartHomePlatform implements DynamicPlatformPlugin {

    private readonly platform?: AbstractSmartHomePlatform;

    constructor(log: Logging, config: PlatformConfig, api: API) {
        const platform = config["platform"] || null;
        if(!platform) {
            log.warn("Platform is not defined. (daelim | smart-elife)");
            return;
        }

        switch(platform) {
            case "daelim": {
                this.platform = new DaelimPlatform(log, config, api);
                break;
            }
            case "smart-elife": {
                this.platform = new SmartELifePlatform(log, config, api);
                break;
            }
            default:
                log.warn(`Prohibited platform type: ${platform}`);
                return;
        }
        this.platform.registerOnLaunching();
    }

    configureAccessory(accessory: PlatformAccessory): void {
        this.platform?.configureAccessory(accessory);
    }
}
