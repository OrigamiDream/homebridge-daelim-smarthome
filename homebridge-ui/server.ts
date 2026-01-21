import { HomebridgePluginUiServer } from "@homebridge/plugin-ui-utils";
import AbstractUiProvider from "./providers/ui-provider";
import DaelimUiServer from "./providers/daelim";
import SmartELifeUiServer from "./providers/smart-elife";
import ServerLogger from "./logger";

export class UiServer extends HomebridgePluginUiServer {

    private readonly log: ServerLogger;
    private readonly providers: AbstractUiProvider[]

    constructor() {
        super();

        // @ts-ignore
        this.log = new ServerLogger();
        this.providers = [
            new DaelimUiServer(this, this.log),
            new SmartELifeUiServer(this, this.log),
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
