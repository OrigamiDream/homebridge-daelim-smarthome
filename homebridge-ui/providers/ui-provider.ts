import {HomebridgePluginUiServer} from "@homebridge/plugin-ui-utils";
import {LoggerBase} from "../../core/utils";

export default class AbstractUiProvider {

    constructor(
        protected readonly server: HomebridgePluginUiServer,
        protected readonly log: LoggerBase) {
    }

    configure() {
    }
}
