import AbstractUiProvider from "./ui-provider";
import {HomebridgePluginUiServer} from "@homebridge/plugin-ui-utils";
import {LoggerBase, Semaphore, Utils} from "../../core/utils";
import SmartELifeClient from "../../core/smart-elife/smart-elife-client";
import {SmartELifeConfig} from "../../core/interfaces/smart-elife-config";
import {ClientResponseCode} from "../../core/smart-elife/responses";
import Timeout = NodeJS.Timeout;
import {Logging} from "homebridge";

export default class SmartELifeUiServer extends AbstractUiProvider {

    // Semaphore for Wall-pad code timers
    private readonly semaphore = new Semaphore();
    private semaphoreTimeout?: Timeout;
    private client?: SmartELifeClient;

    constructor(server: HomebridgePluginUiServer, log: LoggerBase | Logging) {
        super(server, log);
    }

    configure() {
        this.server.onRequest("/smart-elife/sign-in", this.signIn.bind(this));
        this.server.onRequest("/smart-elife/passcode", this.authorizePasscode.bind(this));
        this.server.onRequest("/smart-elife/invalidate", this.invalidate.bind(this));
    }

    async invalidate(_: any) {
        this.client = undefined;
    }

    async signIn(p: any) {
        const { complex, username, password } = p;

        this.log.info(`complex = ${complex}, username: ${username}`);

        const uuid = Utils.generateUUID(username);

        this.semaphore.createSemaphore();
        this.semaphoreTimeout = setTimeout(() => {
            if(!this.semaphoreTimeout) {
                return;
            }
            this.semaphore.removeSemaphore();
            clearTimeout(this.semaphoreTimeout);
            this.semaphoreTimeout = undefined;
        }, 10 * 1000);

        this.log.info("Starting up Smart eLife...");

        const config: SmartELifeConfig = {
            complex, username, password, uuid,
            version: Utils.currentSemanticVersion(),
        };
        this.client = new SmartELifeClient(this.log, config);

        const response = await this.client.signIn();
        switch(response) {
            case ClientResponseCode.WRONG_RESULT_PASSWORD: {
                this.server.pushEvent("invalid-authorization", {
                    "reason": "invalid_username_and_password",
                });
                break;
            }
            case ClientResponseCode.UNCERTIFIED_WALLPAD: {
                this.server.pushEvent("require-wallpad-passcode", {});
                break;
            }
            case ClientResponseCode.SUCCESS: {
                break;
            }
        }
    }

    async authorizePasscode(p: any) {
        const { passcode } = p;
        if(!this.client) {
            this.log.error("Unexpected access to wallpad authorization.");
            return;
        }
        const response = await this.client.authorizeWallpadPasscode(passcode);
        switch(response) {
            case ClientResponseCode.SUCCESS: {
                break;
            }
        }
    }
}
