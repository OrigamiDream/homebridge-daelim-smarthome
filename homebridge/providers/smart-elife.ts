import AbstractProvider from "./provider";
import {API, Logging, PlatformAccessory, PlatformConfig} from "homebridge";
import {SmartELifeConfig} from "../../core/interfaces/smart-elife-config";
import {Utils} from "../../core/utils";

export default class SmartELifeProvider extends AbstractProvider {

    private readonly config?: SmartELifeConfig;

    constructor(log: Logging, platformConfig: PlatformConfig, api: API) {
        super(log, api);
        this.config = this.loadConfig(platformConfig);
        if(this.config) {
            // TODO: Add accessories
        }
    }

    loadConfig(config: PlatformConfig): SmartELifeConfig | undefined {
        for(const key in config) {
            const value = config[key];
            if(value === undefined || !value) {
                return undefined;
            }
        }
        return {
            complex: config["complex"],
            username: config["username"],
            password: config["password"],
            uuid: config["uuid"],
            version: Utils.currentSemanticVersion(),
        };
    }

    configureAccessory(accessory: PlatformAccessory) {
        // TODO: Implement `configureAccessory()`
    }

    protected async serve(): Promise<void> {
        if(!this.config?.uuid) {
            this.log.warn("The plugin hasn't been configured. No available devices.");
            return;
        }
        // TODO: Implement `serve()`
    }
}
