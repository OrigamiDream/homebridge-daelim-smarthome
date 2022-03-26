import {
    API,
    APIEvent,
    Logging,
    PlatformAccessory,
    PlatformConfig,
} from "homebridge";
import {DaelimConfig} from "../core/interfaces/daelim-config";
import {Client} from "../core/client";
import {LightbulbAccessories} from "./accessories/lightbulb";
import {Utils} from "../core/utils";
import {Accessories, AccessoryInterface} from "./accessories/accessories";
import {OutletAccessories} from "./accessories/outlet";
import {HeaterAccessories} from "./accessories/heater";
import {GasAccessories} from "./accessories/gas";

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

        this.config = this.setupDaelimConfig(config);

        this.accessories.push(new LightbulbAccessories(this.log, this.api, this.config));
        this.accessories.push(new OutletAccessories(this.log, this.api, this.config));
        this.accessories.push(new HeaterAccessories(this.log, this.api, this.config));
        this.accessories.push(new GasAccessories(this.log, this.api, this.config));

        log.info("Daelim-SmartHome finished initializing!");

        api.on(APIEvent.DID_FINISH_LAUNCHING, async () => {
            await this.createDaelimSmarthomeService();
        });
    }

    setupDaelimConfig(config: PlatformConfig): DaelimConfig | undefined {
        for(const key in config) {
            const value = config[key];
            if(value === undefined || !value) {
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

    /* override */
    configureAccessory(accessory: PlatformAccessory): void {
        for(const accessories of this.accessories) {
            if(accessory.context.accessoryType !== accessories.getAccessoryType()) {
                continue;
            }
            const services = accessories.getServiceTypes().map((serviceType) => {
                return accessory.getService(serviceType) || accessory.addService(serviceType, accessory.displayName);
            });
            if(services.length > 0) {
                accessories.configureAccessory(accessory, services);
            }
        }
    }

    async createDaelimSmarthomeService() {
        if(!this.config?.uuid) {
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