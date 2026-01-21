import AbstractUiProvider from "./ui-provider";
import {HomebridgePluginUiServer} from "@homebridge/plugin-ui-utils";
import {Semaphore} from "../../core/utils";
import Timeout = NodeJS.Timeout;
import ServerLogger from "../logger";

export default class SmartELifeUiServer extends AbstractUiProvider {

    // Semaphore for Wall-pad code timers
    private readonly semaphore = new Semaphore();
    private semaphoreTimeout?: Timeout;

    constructor(server: HomebridgePluginUiServer, log: ServerLogger) {
        super(server, log);
    }

    configure() {
        this.server.onRequest("/smart-elife/sign-in", this.signIn.bind(this));
        this.server.onRequest("/smart-elife/passcode", this.authorizePasscode.bind(this));
        this.server.onRequest("/smart-elife/invalidate", this.invalidate.bind(this));
    }

    async invalidate(_: any) {
        // TODO: Implement
    }

    async signIn(p: any) {
        const { complex, username, password } = p;
        // TODO: Implement
    }

    async authorizePasscode(p: any) {
        const { passcode } = p;
        // TODO: Implement
    }

}