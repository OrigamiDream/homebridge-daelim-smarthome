import ServerLogger from "../logger";
import {HomebridgePluginUiServer} from "@homebridge/plugin-ui-utils";

export default class AbstractUiProvider {

    constructor(
        protected readonly server: HomebridgePluginUiServer,
        protected readonly log: ServerLogger) {
    }

    configure() {
    }
}
