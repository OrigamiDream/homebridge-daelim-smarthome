import {
    API,
    APIEvent,
    Logging,
    PlatformAccessory,
    PlatformConfig,
} from "homebridge";
import {DaelimConfig} from "./components/interfaces/daelim-config";
import {Client} from "./components/client";
import {LightbulbAccessories} from "./accessories/lightbulb";
import {Utils} from "./components/utils";
import {Accessories, AccessoryInterface} from "./accessories/accessories";
import {OutletAccessories} from "./accessories/outlet";
import {HeaterAccessories} from "./accessories/heater";

export = (api: API) => {
    api.registerPlatform(Utils.PLATFORM_NAME, DaelimSmartHomePlatform);
}

class DaelimSmartHomePlatform {

    private readonly log: Logging;
    private readonly api: API;
    private readonly config?: DaelimConfig;
    private client?: Client;

    private readonly accessories: Accessories<AccessoryInterface>[] = [];

    constructor(log: Logging, config: PlatformConfig, api: API) {
        this.log = log;
        this.api = api;

        this.accessories.push(new LightbulbAccessories(this.log, this.api));
        this.accessories.push(new OutletAccessories(this.log, this.api));
        this.accessories.push(new HeaterAccessories(this.log, this.api));

        log.info("Daelim Smarthome platform finished initializing!");

        this.config = this.setupDaelimConfig(config);

        api.on(APIEvent.DID_FINISH_LAUNCHING, async () => {
            await this.createDaelimSmarthomeService();
        });
    }

    setupDaelimConfig(config: PlatformConfig): DaelimConfig | undefined {
        for(const key in config) {
            const value = config[key];
            if(value === undefined) {
                return undefined;
            }
        }
        return {
            region: config['region'],
            complex: config['complex'],
            username: config['username'],
            password: config['password'],
            uuid: config['uuid']
        };
    }

    configureAccessory(accessory: PlatformAccessory): void {
        for(const accessories of this.accessories) {
            const service = accessory.getService(accessories.getServiceType());
            if(service !== undefined) {
                accessories.configureAccessory(accessory, service);
            }
        }
    }

    async createDaelimSmarthomeService() {
        if(this.config === undefined) {
            this.log.warn("Config parameters are not set. No accessories.");
            return;
        }
        this.client = new Client(this.log, this.config);
        await this.client.prepareService();

        this.accessories.forEach(accessories => {
            accessories.setClient(this.client!);
            accessories.registerListeners();
        });

        this.client.startService();
    }
}