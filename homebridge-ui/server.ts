import { HomebridgePluginUiServer } from "@homebridge/plugin-ui-utils";
import AbstractUiProvider from "./providers/ui-provider";
import DaelimUiServer from "./providers/daelim";
import SmartELifeUiServer from "./providers/smart-elife";
import {LoggerBase} from "../core/utils";
import ServerLogger from "./logger";

export class UiServer extends HomebridgePluginUiServer {

    private readonly log: LoggerBase = ServerLogger;
    private readonly providers: AbstractUiProvider[]

    constructor() {
        super();

        this.providers = [
            new DaelimUiServer(this, ServerLogger),
            new SmartELifeUiServer(this, ServerLogger),
        ];
        for(const provider of this.providers) {
            provider.configure();
        }
        this.ready();
    }
}

(() => {
    return new UiServer;
})();
