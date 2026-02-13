import * as fs from "fs";
import * as path from "path";
import {API, Logging} from "homebridge";
import PushReceiver from "@eneris/push-receiver";
import {Utils} from "../../core/utils";

const FILE_SCHEMA_VERSION = 1;
const MAX_PERSISTENT_IDS = 512;
const SAVE_DEBOUNCE_MS = 1000;

interface PushReceiverStateFile {
    schemaVersion: number;
    updatedAt: string;
    credentials?: any;
    persistentIds: string[];
}

interface PushReceiverState {
    credentials?: any;
    persistentIds: string[];
}

export default class PushReceiverStateStore {

    private readonly dirPath: string;
    private readonly filePath: string;
    private saveTimer?: NodeJS.Timeout;
    private cachedCredentials?: any;

    constructor(private readonly log: Logging,
                private readonly api: API,
                namespace: string) {
        // `persistPath()` is reserved for HAP/node-persist internals.
        // Creating plugin directories there can crash Homebridge startup with EISDIR.
        this.dirPath = path.join(this.api.user.storagePath(), Utils.PLUGIN_NAME);
        this.filePath = path.join(this.dirPath, `push-receiver-${namespace}.json`);
    }

    load(): PushReceiverState {
        if(!fs.existsSync(this.filePath)) {
            return { persistentIds: [] };
        }
        try {
            const text = fs.readFileSync(this.filePath, "utf8");
            const parsed = JSON.parse(text) as PushReceiverStateFile | any;
            const persistentIds = this.normalizePersistentIds(parsed?.persistentIds);
            const credentials = this.parseCredentials(parsed?.credentials);
            return { credentials, persistentIds };
        } catch(e) {
            this.log.warn("Could not read PushReceiver state from file: %s", this.filePath);
            this.log.debug("PushReceiver state read failure: %s", (e as Error)?.message || e);
            return { persistentIds: [] };
        }
    }

    bind(push: PushReceiver, credentials?: any): void {
        this.cachedCredentials = credentials;

        push.onCredentialsChanged((event) => {
            this.cachedCredentials = event.newCredentials;
            this.scheduleSave(push);
        });
        push.onNotification(() => {
            this.scheduleSave(push);
        });
        push.onReady(() => {
            this.scheduleSave(push);
        });
    }

    private parseCredentials(credentials: unknown): any | undefined {
        if(!credentials || typeof credentials !== "object") {
            return undefined;
        }
        return credentials as any;
    }

    private normalizePersistentIds(value: unknown): string[] {
        if(!Array.isArray(value)) {
            return [];
        }
        const persistentIds = value
            .filter((id) => typeof id === "string")
            .map((id) => id as string);
        if(persistentIds.length <= MAX_PERSISTENT_IDS) {
            return persistentIds;
        }
        return persistentIds.slice(persistentIds.length - MAX_PERSISTENT_IDS);
    }

    private scheduleSave(push: PushReceiver) {
        if(this.saveTimer) {
            clearTimeout(this.saveTimer);
        }
        this.saveTimer = setTimeout(() => this.saveNow(push), SAVE_DEBOUNCE_MS);
    }

    private saveNow(push: PushReceiver) {
        if(this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        try {
            const persistentIds = this.normalizePersistentIds(push.persistentIds);
            const state: PushReceiverStateFile = {
                schemaVersion: FILE_SCHEMA_VERSION,
                updatedAt: new Date().toISOString(),
                credentials: this.cachedCredentials,
                persistentIds,
            };
            fs.mkdirSync(this.dirPath, { recursive: true });

            const filePathTmp = `${this.filePath}.tmp`;
            fs.writeFileSync(filePathTmp, JSON.stringify(state, null, 2), "utf8");
            fs.renameSync(filePathTmp, this.filePath);
        } catch(e) {
            this.log.warn("Could not write PushReceiver state to file: %s", this.filePath);
            this.log.debug("PushReceiver state write failure: %s", (e as Error)?.message || e);
        }
    }

}
