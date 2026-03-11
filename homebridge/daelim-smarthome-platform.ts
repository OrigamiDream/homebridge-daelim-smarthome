import {API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig,} from "homebridge";
import {Utils} from "../core/utils";
import AbstractProvider from "./providers/provider";
import DaelimProvider from "./providers/daelim";
import SmartELifeProvider from "./providers/smart-elife";

export = (api: API) => {
    api.registerPlatform(Utils.PLATFORM_NAME, DaelimSmartHomePlatform);
}

class DaelimSmartHomePlatform implements DynamicPlatformPlugin {

    private readonly provider?: AbstractProvider;

    constructor(log: Logging, config: PlatformConfig, api: API) {
        const provider = config["provider"] || "daelim";
        if(!provider) {
            log.warn("Provider is not defined. (daelim | smart-elife)");
            return;
        }

        switch(provider) {
            case "daelim": {
                this.provider = new DaelimProvider(log, config, api);
                break;
            }
            case "smart-elife": {
                this.provider = new SmartELifeProvider(log, config, api);
                break;
            }
            default:
                log.warn(`Prohibited provider type: ${provider}`);
                return;
        }
        this.provider.registerOnLaunching();
    }

    configureAccessory(accessory: PlatformAccessory): void {
        this.provider?.configureAccessory(accessory);
    }
}
