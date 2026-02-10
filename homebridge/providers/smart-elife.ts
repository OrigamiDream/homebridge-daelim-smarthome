import AbstractProvider from "./provider";
import {API, Logging, PlatformAccessory, PlatformConfig} from "homebridge";
import {SmartELifeConfig} from "../../core/interfaces/smart-elife-config";
import {Utils} from "../../core/utils";
import PushReceiver from "@eneris/push-receiver";
import SmartELifeClient from "../../core/smart-elife/smart-elife-client";
import {ClientResponseCode} from "../../core/smart-elife/responses";
import Accessories, {AccessoryInterface} from "../accessories/smart-elife/accessories";
import OutletAccessories from "../accessories/smart-elife/outlet";
import LightbulbAccessories from "../accessories/smart-elife/lightbulb";
import VentAccessories from "../accessories/smart-elife/vent";
import {WALLPAD_VERSION_3_0} from "../../core/smart-elife/parsers/version-parsers";

export default class SmartELifeProvider extends AbstractProvider {

    private readonly config?: SmartELifeConfig;
    private readonly accessories: Accessories<AccessoryInterface>[] = [];
    private client?: SmartELifeClient;

    constructor(log: Logging, platformConfig: PlatformConfig, api: API) {
        super(log, api);
        this.config = this.loadConfig(platformConfig);
        if(this.config) {
            this.accessories.push(new OutletAccessories(log, api, this.config));
            this.accessories.push(new LightbulbAccessories(log, api, this.config));
            this.accessories.push(new VentAccessories(log, api, this.config));
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
            roomKey: config["roomKey"], // nullable
            userKey: config["userKey"], // nullable
            version: Utils.currentSemanticVersion(),
            wallpadVersion: WALLPAD_VERSION_3_0,
            devices: config["devices"] || [],
        };
    }

    configureAccessory(accessory: PlatformAccessory) {
        for(const accessories of this.accessories) {
            if(accessories.deviceType !== accessory.context.deviceType) {
                continue;
            }
            accessories.configureAccessory(accessory);
        }
    }

    protected async serve(): Promise<void> {
        if(!this.config?.uuid) {
            this.log.warn("The plugin hasn't been configured. No available devices.");
            return;
        }

        // firebase cloud messaging
        const push = new PushReceiver({
            debug: false,
            persistentIds: [],
            firebase: {
                apiKey: Utils.SMART_ELIFE_FCM_API_KEY,
                appId: Utils.SMART_ELIFE_FCM_APP_ID,
                projectId: Utils.SMART_ELIFE_FCM_PROJECT_ID,
                messagingSenderId: Utils.SMART_ELIFE_FCM_SENDER_ID,
            },
            credentials: undefined,
        });
        this.client = SmartELifeClient.create(this.log, this.config, push);

        const response = await this.client.signIn();
        if(response !== ClientResponseCode.SUCCESS) {
            this.log.error(`Could not sign in to Smart eLife: ${response}`);
            return;
        }

        this.accessories.forEach(accessories => {
            accessories.client = this.client!;
            accessories.register();
        });

        await this.client.serve();
    }
}
