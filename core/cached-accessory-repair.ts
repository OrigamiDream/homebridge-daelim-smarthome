import * as fs from "fs";
import * as path from "path";
import {API} from "homebridge";
import {Utils} from "./utils";

const ACCESSORY_INFORMATION_UUID = "0000003E-0000-1000-8000-0026BB765291";

// The characteristics HAP itself adds to a freshly constructed AccessoryInformation.
// Only the identity ones need a value; the plugin overwrites them on the next
// `configureAccessory()` anyway. `Identify` is the mandatory write-only one.
const ACCESSORY_INFORMATION_SERVICE = {
    displayName: "Accessory Information",
    UUID: ACCESSORY_INFORMATION_UUID,
    hiddenService: false,
    primaryService: false,
    characteristics: [
        {
            displayName: "Identify",
            UUID: "00000014-0000-1000-8000-0026BB765291",
            value: null,
            props: {format: "bool", perms: ["pw"]},
        },
        {
            displayName: "Manufacturer",
            UUID: "00000020-0000-1000-8000-0026BB765291",
            value: Utils.MANUFACTURER_NAME,
            props: {format: "string", perms: ["pr"]},
        },
        {
            displayName: "Model",
            UUID: "00000021-0000-1000-8000-0026BB765291",
            value: "Unknown",
            props: {format: "string", perms: ["pr"]},
        },
        {
            displayName: "Name",
            UUID: "00000023-0000-1000-8000-0026BB765291",
            value: "Unknown",
            props: {format: "string", perms: ["pr"]},
        },
        {
            displayName: "Serial Number",
            UUID: "00000030-0000-1000-8000-0026BB765291",
            value: "Unknown",
            props: {format: "string", perms: ["pr"]},
        },
        {
            displayName: "Firmware Revision",
            UUID: "00000052-0000-1000-8000-0026BB765291",
            value: "1.0.0",
            props: {format: "string", perms: ["pr"]},
        },
    ],
    optionalCharacteristics: [],
};

type Logger = (message: string) => void;

function hasAccessoryInformation(accessory: any): boolean {
    const services = accessory?.["services"];
    if(!Array.isArray(services)) {
        return false;
    }
    return services.some((service: any) => service?.["UUID"] === ACCESSORY_INFORMATION_UUID);
}

// Repairs one cache file, returning the display names of the accessories it fixed.
function repairFile(filePath: string): string[] {
    const text = fs.readFileSync(filePath, "utf8");
    const cached = JSON.parse(text);
    if(!Array.isArray(cached)) {
        return [];
    }

    const repaired: string[] = [];
    for(const accessory of cached) {
        // Only ever touch this plugin's own accessories.
        if(accessory?.["plugin"] !== Utils.PLUGIN_NAME) {
            continue;
        }
        if(hasAccessoryInformation(accessory)) {
            continue;
        }
        if(!Array.isArray(accessory["services"])) {
            accessory["services"] = [];
        }
        const name = accessory["displayName"] || "Unknown";
        const service = JSON.parse(JSON.stringify(ACCESSORY_INFORMATION_SERVICE));
        for(const characteristic of service.characteristics) {
            if(characteristic.displayName === "Name") {
                characteristic.value = name;
            }
        }
        // HAP expects the information service first.
        accessory["services"].unshift(service);
        repaired.push(name);
    }
    if(!repaired.length) {
        return [];
    }

    // Keep one copy of the unrepaired file around, and swap the repaired one in
    // atomically so an interrupted write cannot leave a truncated cache behind.
    const backupPath = `${filePath}.broken`;
    if(!fs.existsSync(backupPath)) {
        fs.copyFileSync(filePath, backupPath);
    }
    const tempPath = `${filePath}.repair`;
    fs.writeFileSync(tempPath, JSON.stringify(cached), "utf8");
    fs.renameSync(tempPath, filePath);
    return repaired;
}

// An accessory cached without its `AccessoryInformation` service takes the whole bridge
// down at startup: HAP dereferences that service unconditionally while deserializing the
// cache, so the failure lands before any plugin code that could react to it, and it
// repeats on every restart until the file is corrected. Rolling the plugin back does not
// help either, because the damage is on disk rather than in the code.
//
// This runs from the plugin's entry point, which Homebridge executes *before* it reads
// the cache, and it is the only point where the file can still be corrected from inside
// the plugin. Repairing rather than dropping the entry keeps the accessory's HomeKit
// identity, so its room and automations survive.
export function repairCachedAccessories(api: API, log: Logger): void {
    try {
        const directory = path.join(api.user.storagePath(), "accessories");
        if(!fs.existsSync(directory)) {
            return;
        }
        for(const name of fs.readdirSync(directory)) {
            if(!name.startsWith("cachedAccessories") || name.endsWith(".broken") || name.endsWith(".repair")) {
                continue;
            }
            try {
                const repaired = repairFile(path.join(directory, name));
                for(const accessory of repaired) {
                    log(`Repaired the cached accessory "${accessory}", which was missing its information service.`);
                }
            } catch(error) {
                log(`Could not inspect the accessory cache ${name}: ${(error as Error)?.message}`);
            }
        }
    } catch(error) {
        // Never let a repair attempt keep the plugin from loading.
        log(`Could not inspect the accessory cache: ${(error as Error)?.message}`);
    }
}
