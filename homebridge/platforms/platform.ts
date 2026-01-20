import {API, APIEvent, Logging, PlatformAccessory} from "homebridge";
import {Semaphore} from "../../core/utils";

export default class AbstractSmartHomePlatform {

    constructor(
        protected readonly log: Logging,
        protected readonly api: API) {
    }

    registerOnLaunching() {
        this.api.on(APIEvent.DID_FINISH_LAUNCHING, async () => {
            const semaphore = new Semaphore();
            semaphore.removeSemaphore(); // remove all orphan semaphores

            await this.serve();
        });
    }

    configureAccessory(accessory: PlatformAccessory): void {
    }

    protected async serve(): Promise<void> {
    }
}
