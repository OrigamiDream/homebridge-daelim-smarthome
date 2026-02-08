import AbstractProvider from "./provider";
import {API, Logging, PlatformAccessory, PlatformConfig} from "homebridge";
import {SmartELifeConfig} from "../../core/interfaces/smart-elife-config";
import {Utils} from "../../core/utils";
import PushReceiver from "@eneris/push-receiver";
import SmartELifeClient from "../../core/smart-elife/smart-elife-client";
import {ClientResponseCode} from "../../core/smart-elife/responses";

export default class SmartELifeProvider extends AbstractProvider {

    private readonly config?: SmartELifeConfig;
    private client?: SmartELifeClient;

    constructor(log: Logging, platformConfig: PlatformConfig, api: API) {
        super(log, api);
        this.config = this.loadConfig(platformConfig);
        if(this.config) {
            // TODO: Add accessory registrars
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
            devices: config["devices"] || [],
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

        // TODO: Add accessories.

        await this.client.serve();
    }
}
