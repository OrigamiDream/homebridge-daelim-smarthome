let globalIndoorRelativeHumidity = 50;

export function setGlobalIndoorRelativeHumidity(value: number) {
    if(!Number.isFinite(value)) {
        return;
    }
    globalIndoorRelativeHumidity = Math.max(0, Math.min(100, value));
}

export function getGlobalIndoorRelativeHumidity(): number {
    return globalIndoorRelativeHumidity;
}

