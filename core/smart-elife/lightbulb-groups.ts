import {LightbulbGroup} from "../interfaces/smart-elife-config";

/**
 * Works out which lights form a level group.
 *
 * Runs where the device list is fetched - in the settings wizard - and nowhere else.
 * The result is written into the configuration, so the accessory never has to derive
 * membership from a page of its own: `/main/home.do` is sometimes another household's,
 * and deriving topology from it tied which accessories exist to which page happened to
 * arrive. What the wizard resolves is as fresh as the device list it was resolved from,
 * which is the same thing the rest of the configuration is.
 */

/** What has to be known about a light before it can be grouped. */
export interface LightbulbGroupCandidate {
    deviceId: string

    /** Device name as the WallPad gives it, e.g. `조명1` or `1등`. */
    name: string

    /** Canonical room name (`location_name`), e.g. `침실1`. Never the resident's alias. */
    room: string

    disabled: boolean
    brightnessAdjustable: boolean
    colorTemperatureAdjustable: boolean
}

export interface LightbulbGroupResolution {
    /** The step-one light, which owns the opt-in and anchors the accessory's identity. */
    anchorDeviceId: string

    /** Set where the family can be merged. */
    group?: LightbulbGroup

    /** Why it cannot be, in words a resident can act on. Set where `group` is not. */
    refusal?: string

    /** Every light of the family, step-one included. */
    memberDeviceIds: string[]
}

/**
 * Splits a device name into the part shared by a level and the step it names,
 * so that `조명1`/`조명2` and `침실1-1등`/`침실1-2등` are both recognised.
 * The lazy head makes the match land on the *last* number, which is what the step is.
 * A name without a number belongs to no level.
 */
export function parseLevelName(name: string): { prefix: string, suffix: string, index: number } | undefined {
    const match = /^(.*?)(\d+)(\D*)$/.exec(name || "");
    if(!match) {
        return undefined;
    }
    return { prefix: match[1], suffix: match[3], index: Number(match[2]) };
}

/**
 * Names the level after what its members have in common,
 * minus the room the accessory is already named after:
 * `조명1`/`조명2` gives `조명` and `무드등1`/`무드등2` gives `무드등`.
 *
 * A stem worn down to nothing or to a single character falls back to the generic word.
 * `침실1-1등`/`침실1-2등` leaves `등`, and `침실1 등` beside the household's other lights
 * reads as a fragment of a name rather than as what the fixture is,
 * so `침실1 조명` is the kinder answer.
 */
function levelLabel(room: string, prefix: string, suffix: string): string {
    let label = `${prefix}${suffix}`;
    if(room) {
        label = label.split(room).join("");
    }
    label = label.replace(/[\s\-_]+/g, "");
    return label.length > 1 ? label : "조명";
}

/** Why this light cannot be a step of a level. Absent where it can. */
function memberRefusal(candidate: LightbulbGroupCandidate): string | undefined {
    if(candidate.disabled) {
        return `${candidate.name}이(가) 설정에서 비활성화되어 있습니다`;
    }
    if(candidate.brightnessAdjustable) {
        return `${candidate.name}은(는) 자체 밝기 조절이 됩니다`;
    }
    if(candidate.colorTemperatureAdjustable) {
        return `${candidate.name}은(는) 자체 색온도 조절이 됩니다`;
    }
    return undefined;
}

export function resolveLightbulbGroups(candidates: LightbulbGroupCandidate[]): LightbulbGroupResolution[] {
    const families = new Map<string, { room: string, prefix: string, suffix: string,
        members: { candidate: LightbulbGroupCandidate, index: number }[] }>();

    for(const candidate of candidates) {
        const level = parseLevelName(candidate.name);
        if(!level || !candidate.room) {
            continue; // a light naming no step belongs to no level
        }
        const key = [candidate.room, level.prefix, level.suffix].join("\u0000");
        const family = families.get(key)
            || { room: candidate.room, prefix: level.prefix, suffix: level.suffix, members: [] };
        family.members.push({ candidate, index: level.index });
        families.set(key, family);
    }

    const resolutions: LightbulbGroupResolution[] = [];
    for(const family of families.values()) {
        family.members.sort((a, b) =>
            a.index - b.index || a.candidate.deviceId.localeCompare(b.candidate.deviceId));
        const memberDeviceIds = family.members.map((member) => member.candidate.deviceId);
        const anchorDeviceId = memberDeviceIds[0];

        // A lone light gains nothing from a slider.
        if(family.members.length < 2) {
            continue;
        }
        // Only the exact 1..n run is a level group. Leave out `조명2` and what remains reads as
        // a room of two, whose second level would light the first and third lamps while the
        // fixture's own second level is the first and second - better to leave the whole family
        // alone than to command a sequence the room does not have.
        const continuous = family.members.every((member, index) => member.index === index + 1);
        if(!continuous) {
            const steps = family.members.map((member) => member.index).join(", ");
            resolutions.push({ anchorDeviceId, memberDeviceIds,
                refusal: `단계 번호(${steps})가 1부터 이어지지 않습니다` });
            continue;
        }
        const refusal = family.members
            .map((member) => memberRefusal(member.candidate))
            .find((reason) => !!reason);
        if(refusal) {
            resolutions.push({ anchorDeviceId, memberDeviceIds, refusal });
            continue;
        }
        resolutions.push({
            anchorDeviceId,
            memberDeviceIds,
            group: {
                room: family.room,
                members: memberDeviceIds,
                displayName: `${family.room} ${levelLabel(family.room, family.prefix, family.suffix)}`,
            },
        });
    }
    return resolutions;
}
