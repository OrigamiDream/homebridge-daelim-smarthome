function refreshTrademark(config) {
    const complex = config.complex;
    let tm = "DL E&C";
    if(complex === undefined) {
        tm = "DL E&C";
    } else if(complex.indexOf('e편한세상') !== -1 || complex.indexOf('이편한세상') !== -1) {
        tm = "e편한세상";
    } else if(complex.indexOf('아크로') !== -1 || complex.indexOf('ACRO') !== -1) {
        tm = "아크로";
    }

    for(const span of document.getElementsByClassName("brand-name")) {
        span.innerText = tm;
    }
}

class PaneManager {
    constructor() {
        this.element = document.getElementById("mainForm");
        this.platformConfig = {
            platform: "DaelimSmartHomePlatform",
            name: "DL E&C",
        };
        this.currentPane = null;
    }

    async init() {
        const pluginConfigBlocks = await window.homebridge.getPluginConfig();
        if(pluginConfigBlocks[0]) {
            this.platformConfig = pluginConfigBlocks[0];
        }
        this.currentPane = new ProviderPane(this.element, this.platformConfig);
        this.currentPane.manager = this;
        while(this.currentPane.canPassthrough()) {
            this.currentPane.unregister();
            this.currentPane = this.currentPane.nextPane();
            this.currentPane.manager = this;
        }
        this.currentPane.register();
        doTransition(undefined, this.currentPane.selfPane());

        document.getElementById("back-button").addEventListener("click", async () => {
            document.getElementById("advancedForm").classList.add("hidden");
            document.getElementById("setupForm").classList.remove("hidden");
            document.getElementById("footer").classList.remove("hidden");

            this.currentPane.updatePluginConfig();
            this.currentPane.savePluginConfig();
            window.homebridge.endForm();
        });
    }
}

class Pane {
    constructor(element, config) {
        this.element = element;
        this.config = config;
        this._listeners = [];
        this._homebridgeListeners = [];
        this._disposed = false;
    }

    selfPane() {
    }

    prevPane() {
    }

    nextPane() {
    }

    register() {
    }

    unregister() {
        this.dispose();
        this.selfPane().remove();
    }

    dispose() {
        if(this._disposed) {
            return;
        }
        this._disposed = true;
        for(const entry of this._listeners) {
            entry.target.removeEventListener(entry.event, entry.handler, entry.options);
        }
        this._listeners = [];
        if(window.homebridge && window.homebridge.removeEventListener) {
            for(const entry of this._homebridgeListeners) {
                window.homebridge.removeEventListener(entry.event, entry.handler);
            }
        }
        this._homebridgeListeners = [];
    }

    addListener(target, event, handler, options) {
        target.addEventListener(event, handler, options);
        this._listeners.push({ target, event, handler, options });
    }

    addHomebridgeListener(event, handler) {
        if(window.homebridge && window.homebridge.addEventListener) {
            window.homebridge.addEventListener(event, handler);
            this._homebridgeListeners.push({ event, handler });
        }
    }

    ensureAttached() {
        const pane = this.selfPane();
        if(pane && !pane.isConnected) {
            this.element.append(pane);
        }
    }

    async updatePluginConfig() {
        await window.homebridge.updatePluginConfig([this.config]);
    }

    async savePluginConfig() {
        await window.homebridge.savePluginConfig();
    }

    async advance(newConfigOptions, newPane, backward) {
        backward = backward || false;

        for(const key in newConfigOptions) {
            this.config[key] = newConfigOptions[key];
        }
        await this.updatePluginConfig();
        refreshTrademark(this.config);

        console.log("newConfig:", this.config);
        console.log("newPane:", newPane);

        if(!backward) {
            while(newPane.canPassthrough()) {
                newPane.unregister(); // attempt to remove elements.
                newPane = newPane.nextPane();
            }
        }
        newPane.register();
        if(this.manager) {
            newPane.manager = this.manager;
            this.manager.currentPane = newPane;
        }
        this.dispose();
        doTransition(this.selfPane(), newPane.selfPane());
        setTimeout(() => {
            this.unregister();
        }, 1000);

        return newPane;
    }

    createNavigation(key, options) {
        options = Object.assign({
            previous: true,
            next: true,
            errors: [],
        }, options || {});
        const previous = `<button type="button" id="${key}-prev-btn" class="btn btn-primary">이전</button>`
        const next = `<button type="button" id="${key}-next-btn" class="btn btn-primary" disabled>다음</button>`

        const errors = [];
        for(const error of options.errors) {
            errors.push(`<p id="${error["id"]}" class="hidden text-danger">${error["text"]}</p>`);
        }

        return `
            <div class="text-center mt-3">
                ${errors.join("")}
                ${options.previous ? previous : ''}
                ${options.next ? next : ''}
            </div>
        `
    }

    canPassthrough() {
        return false;
    }

    getLeftNavigation(key) {
        return this.selfPane().querySelector(`#${key}-prev-btn`);
    }

    getRightNavigation(key) {
        return this.selfPane().querySelector(`#${key}-next-btn`);
    }

    registerPrevNavigation(key, fn) {
        const nav = this.getLeftNavigation(key);
        const handler = async () => {
            if(nav.disabled) {
                return;
            }
            nav.disabled = true;
            await fn();
            nav.disabled = false;
        };
        this.addListener(nav, "click", handler);
    }

    registerNextNavigation(key, fn) {
        const nav = this.getRightNavigation(key);
        const handler = async () => {
            if(nav.disabled) {
                return;
            }
            nav.disabled = true;
            await fn();
            nav.disabled = false;
        };
        this.addListener(nav, "click", handler);
    }
}

class ProviderPane extends Pane {
    constructor(element, config) {
        super(element, config);

        this.pane = document.createElement("div");
        this.pane.classList.add("hidden");
        this.pane.id = "setup-provider";
        this.pane.innerHTML = `
            <div class="text-center">
                <h2>사용하실 플랫폼을 선택해주세요.</h2>
            </div>
            <div class="form-group">
                <div class="d-flex justify-content-center align-items-start">
                    <label class="d-flex flex-column align-items-center m-3">
                        <img class="img-fluid mb-2 w-25" style="border-radius: 24%" alt="DL E&C Smart Home" src="https://github.com/OrigamiDream/homebridge-daelim-smarthome/blob/main/branding/daeilm.png?raw=true">
                        <input class="form-check-input" type="radio" name="provider" value="daelim" checked>
                        <span>e편한세상 스마트홈 2.0</span>
                    </label>
                    <label class="d-flex flex-column align-items-center m-3">
                        <img class="img-fluid mb-2 w-25" style="border-radius: 24%" alt="Smart eLife" src="https://github.com/OrigamiDream/homebridge-daelim-smarthome/blob/main/branding/smart-elife.png?raw=true">
                        <input class="form-check-input" type="radio" name="provider" value="smart-elife">
                        <span>스마트 eLife</span>
                    </label>
                </div>
            </div>
            ${this.createNavigation("provider", { previous: false })}
        `;
    }

    canPassthrough() {
        return !!this.config.provider;
    }

    selfPane() {
        return this.pane;
    }

    nextPane() {
        const provider = this.getSelectedProvider();
        console.log("Provider:", provider);
        if(provider === "daelim") {
            return new RegionPane(this.element, this.config);
        } else if(provider === "smart-elife") {
            // Smart eLife does not need complex info.
            return new AuthorizationPane(this.element, this.config, provider);
        } else {
            console.error(`Prohibited provider: ${provider}`);
        }
    }

    getSelectedProvider() {
        if(!!this.config.provider) {
            return this.config.provider;
        } else {
            return this.pane.querySelector('input[name="provider"]:checked')?.value;
        }
    }

    register() {
        this.ensureAttached();
        this.getRightNavigation("provider").disabled = false;
        this.registerNextNavigation("provider", async () => {
            await this.advance({ provider: this.getSelectedProvider() }, this.nextPane());
        });
    }
}

class RegionPane extends Pane {
    constructor(element, config) {
        super(element, config);
        this.url = "https://raw.githubusercontent.com/OrigamiDream/homebridge-daelim-smarthome/refs/heads/main/complexes/daelim/regions.json";

        this.pane = document.createElement("div");
        this.pane.classList.add("hidden");
        this.pane.id = "setup-regions";
        this.pane.innerHTML = `
            <div class="form-group">
                <label for="region">지역</label>
                <select class="form-control" id="region" name="region">
                    <option selected disabled>로딩 중</option>
                </select>
            </div>
            ${this.createNavigation("region")}
        `;
        this.regionElement = this.pane.querySelector("#region");
        this.regionElement.value = config.region;
        this._regionsLoaded = false;
    }

    canPassthrough() {
        return !!this.config.region;
    }

    selfPane() {
        return this.pane;
    }

    prevPane() {
        return new ProviderPane(this.element, this.config);
    }

    nextPane() {
        return new ComplexPane(this.element, this.config, "daelim");
    }

    register() {
        this.ensureAttached();
        if(!this._regionsLoaded) {
            this._regionsLoaded = true;
            setTimeout(async () => {
                const regionsJson = await fetch(this.url)
                    .then((response) => response.json())
                    .then((json) => json["regions"]);
                if(this._disposed) {
                    return;
                }
                if(!!regionsJson) {
                    this.regionElement.innerHTML = "";
                }
                for(const region of regionsJson) {
                    this.regionElement.append(createElement("option", {
                        innerText: region,
                        value: region,
                    }));
                }
                this.regionElement.append(createElement("option", {
                    innerText: "지역을 선택하세요.",
                    disabled: true,
                    selected: true,
                }));
            }, 0);
        }
        this.addListener(this.regionElement, "change", () => {
            const newValue = this.regionElement.value;
            if(newValue === "로딩 중" || newValue === "지역을 선택하세요.") {
                this.getRightNavigation("region").disabled = true;
                return;
            }
            this.getRightNavigation("region").disabled = false;
        });
        this.registerPrevNavigation("region", async () => {
            await this.advance({ region: undefined }, this.prevPane(), true);
        });
        this.registerNextNavigation("region", async () => {
            let newConfigOptions;
            if(this.regionElement.value === this.config.region) {
                newConfigOptions = {
                    region: this.regionElement.value,
                }
            } else {
                newConfigOptions = {
                    region: this.regionElement.value,
                    complex: undefined,
                }
            }
            await this.advance(newConfigOptions, this.nextPane());
        });
    }
}

class ComplexPane extends Pane {

    constructor(element, config, provider) {
        super(element, config);
        this.provider = provider;
        this.url = `https://raw.githubusercontent.com/OrigamiDream/homebridge-daelim-smarthome/refs/heads/main/complexes/${provider}/complexes.json`

        this.pane = document.createElement("div");
        this.pane.classList.add("hidden");
        this.pane.id = "setup-complexes";
        this.pane.innerHTML = `
            <div class="form-group">
                <label for="complex">단지</label>
                <select class="form-control" id="complex" name="complex">
                    <option selected disabled>로딩 중</option>
                </select>
            </div>
            ${this.createNavigation("complex")}
        `;
        this.complexElement = this.pane.querySelector("#complex");
        this.complexElement.value = config.complex;
        this._complexesLoaded = false;
    }

    canPassthrough() {
        return !!this.config.complex;
    }

    selfPane() {
        return this.pane;
    }

    prevPane() {
        if(this.provider === "daelim") {
            return new RegionPane(this.element, this.config);
        } else if(this.provider === "smart-elife") {
            return new ProviderPane(this.element, this.config);
        } else {
            console.error(`Prohibited provider: ${this.provider}`);
        }
    }

    nextPane() {
        return new AuthorizationPane(this.element, this.config, this.provider);
    }

    register() {
        this.ensureAttached();
        if(!this._complexesLoaded) {
            this._complexesLoaded = true;
            setTimeout(async () => {
                const response = await fetch(this.url).then((response) => response.json());
                if(this._disposed) {
                    return;
                }
                if(this.provider === "daelim") {
                    const complexesJson = response["complexes"].filter(o => o["region"] === this.config.region);
                    if(!complexesJson || !complexesJson[0]) {
                        this.complexElement.innerHTML = '<option selected disabled>적합한 단지 정보가 없습니다.</option>';
                        return;
                    }
                    const complexes = complexesJson[0]["complexes"];
                    if(!!complexes) {
                        this.complexElement.innerHTML = "";
                    }
                    for(const complex of complexes) {
                        this.complexElement.append(createElement("option", {
                            innerText: complex["name"],
                            value: complex["name"],
                        }));
                    }
                    this.complexElement.prepend(createElement("option", {
                        innerText: "단지를 선택하세요.",
                        disabled: true,
                        selected: true,
                    }));
                } else if(this.provider === "smart-elife") {
                    if(!response) {
                        this.complexElement.innerHTML = '<option selected disabled>적합한 단지 정보가 없습니다.</option>';
                        return;
                    }
                    this.complexElement.innerHTML = "";
                    for(const complex of response) {
                        this.complexElement.append(createElement("option", {
                            innerText: complex["complexDisplayName"],
                            value: complex["complexKey"],
                        }));
                    }
                    this.complexElement.prepend(createElement("option", {
                        innerText: "단지를 선택하세요.",
                        disabled: true,
                        selected: true,
                    }));
                }
            }, 0);
        }
        // register events
        this.addListener(this.complexElement, "change", () => {
            const newValue = this.complexElement.value;
            if(newValue === "단지를 선택하세요." || newValue === "적합한 단지 정보가 없습니다.") {
                this.getRightNavigation("complex").disabled = true;
                return;
            }
            this.getRightNavigation("complex").disabled = false;
        });
        this.registerPrevNavigation("complex", async () => {
            await this.advance({ complex: undefined }, this.prevPane(), true);
        });
        this.registerNextNavigation("complex", async () => {
            await this.advance({ complex: this.complexElement.value }, this.nextPane());
        });
    }
}

class AuthorizationPane extends Pane {
    constructor(element, config, provider) {
        super(element, config);
        this.provider = provider;
        this.isCompleted = false;

        this.errors = [
            { "id": "invalid-authorization", "text": "아이디 혹은 비밀번호가 유효하지 않습니다." },
            { "id": "wallpad-preparation-fail", "text": "월패드 연결에 실패했습니다. 나중에 다시 시도해주세요." },
            { "id": "incomplete-user-info", "text": "사용자 정보가 완전하지 않습니다. 앱으로 로그인하여 다시 설정해주세요." },
        ];
        this.pane = document.createElement("div");
        this.pane.classList.add("hidden");
        this.pane.id = "setup-authorization";
        this.pane.innerHTML = `
            <div class="form-group">
                <label for="username">아이디</label>
                <input class="form-control" type="text" id="username" name="username" autocomplete="username">
                <br>
                <label for="password">비밀번호</label>
                <input class="form-control" type="password" id="password" name="password" autocomplete="password">
            </div>
            ${this.createNavigation("authorization", { errors: this.errors })}
        `;
        this.usernameElement = this.pane.querySelector("#username");
        this.usernameElement.value = config.username || "";
        this.passwordElement = this.pane.querySelector("#password");
        this.passwordElement.value = config.password || "";
    }

    canPassthrough() {
        return !!this.config.username && !!this.config.password;
    }

    selfPane() {
        return this.pane;
    }

    _refreshNavigation() {
        this.getRightNavigation("authorization").disabled = (
            this.usernameElement.value.length < 1 || this.passwordElement.value.length < 1
        );
    }

    prevPane() {
        if(this.provider === "daelim") {
            return new ComplexPane(this.element, this.config, this.provider);
        } else if(this.provider === "smart-elife") {
            return new ProviderPane(this.element, this.config);
        } else {
            console.error(`Prohibited provider: ${this.provider}`);
        }
    }

    nextPane() {
        if(this.isCompleted) {
            if(this.provider === "smart-elife") {
                // The confirmation pane sits before the completion screen and decides
                // for itself whether there is anything to confirm - see canPassthrough.
                return new DeviceConfirmPane(this.element, this.config);
            }
            // daelim: the per-complex server answers for this household alone,
            // so the fetched list needs no confirmation.
            return new CompletePane(this.element, this.config);
        } else {
            return new WallpadPasscodePane(this.element, this.config, this.provider);
        }
    }

    dispose() {
        this.isCompleted = false;
        return super.dispose();
    }

    register() {
        this.ensureAttached();
        this.addListener(this.usernameElement, "keyup", this._refreshNavigation.bind(this));
        this.addListener(this.passwordElement, "keyup", this._refreshNavigation.bind(this));
        this.registerPrevNavigation("authorization", async () => {
            await this.advance({ username: undefined, password: undefined }, this.prevPane(), true);
        });
        this.registerNextNavigation("authorization", async () => {
            window.homebridge.showSpinner();
            for(const id in this.errors) {
                const element = document.getElementById(id);
                if(!!element && !element.classList.contains("hidden")) {
                    element.classList.add("hidden");
                }
            }
            await window.homebridge.request(`/${this.provider}/sign-in`, {
                region: this.config.region,
                complex: this.config.complex,
                username: this.usernameElement.value,
                password: this.passwordElement.value,
                // The saved device list rides along as the yardstick the server holds
                // fetched pages against. Empty on a first-time setup, and ignored by daelim.
                devices: this.config.devices || [],
            });
        });
        this.addHomebridgeListener("authorization-failed", (event) => {
            const reasonId = event["data"].reason;
            window.homebridge.hideSpinner();
            const element = document.getElementById(reasonId);
            if(!!element) {
                element.classList.remove("hidden");
            }
        });
        this.addHomebridgeListener("require-wallpad-passcode", async () => {
            window.homebridge.hideSpinner();
            this.isCompleted = false;

            await this.advance(
                {
                    username: this.usernameElement.value,
                    password: this.passwordElement.value,
                },
                this.nextPane(),
            );
        });
        this.addHomebridgeListener("complete", async (event) => {
            window.homebridge.hideSpinner();
            this.isCompleted = true;

            console.log("Sign-in successful.");
            const newOptions = {
                username: this.usernameElement.value,
                password: this.passwordElement.value,
                uuid: event["data"].uuid,
            }
            if(this.provider === "smart-elife") {
                newOptions["roomKey"] = event["data"].roomKey;
                newOptions["userKey"] = event["data"].userKey;
                newOptions["wallpadVersion"] = event["data"].version;
                newOptions["complex"] = event["data"].complex;
            }
            await this.advance(newOptions, this.nextPane());
        });
    }
}

class WallpadPasscodePane extends Pane {
    constructor(element, config, provider) {
        super(element, config);
        this.provider = provider;

        this.pane = document.createElement("div");
        this.pane.classList.add("hidden");
        this.pane.id = "verify-wallpad";
        this.pane.innerHTML = `
            <div class="form-group">
                <label for="passcode">월패드 인증번호</label>
                <input class="form-control" type="text" id="passcode" name="passcode">
                <br>
                
                <div class="text-center mt-3">
                    <p>월패드에 나타난 인증번호를 <span id="remaining-time">—</span>초 내에 입력하세요.</p>
                    <button type="button" id="verify-button" class="btn btn-primary" disabled=>인증</button>
                </div>
            </div>
        `;
        this.passcodeElement = this.pane.querySelector("#passcode");
        this.passcodeElement.value = "";
        this.verifyButton = this.pane.querySelector("#verify-button");
    }

    selfPane() {
        return this.pane;
    }

    canPassthrough() {
        return !!this.config.uuid;
    }

    _refreshNavigation() {
        this.verifyButton.disabled = this.passcodeElement.value.length < 4;
    }

    prevPane() {
        return new AuthorizationPane(this.element, this.config, this.provider);
    }

    nextPane() {
        if(this.provider === "smart-elife") {
            // Same station as AuthorizationPane's: the confirmation pane decides
            // for itself whether there is anything to confirm.
            return new DeviceConfirmPane(this.element, this.config);
        }
        // daelim: no confirmation - see AuthorizationPane.
        return new CompletePane(this.element, this.config);
    }

    register() {
        this.ensureAttached();
        this.addListener(this.passcodeElement, "keyup", this._refreshNavigation.bind(this));
        startTimer(180, () => {
            const element = this.pane.querySelector("#remaining-time");
            element.innerText = remainingDuration;
        }, async () => {
            await this.advance({ uuid: undefined }, this.prevPane(), true);
        });
        this.addListener(this.verifyButton, "click", async () => {
            if(this.verifyButton.disabled) {
                return;
            }
            this.verifyButton.disabled = true;
            stopTimer();
            window.homebridge.showSpinner();
            await window.homebridge.request(`/${this.config.provider}/passcode`, {
                complex: this.config.complex,
                username: this.config.username,
                password: this.config.password,
                passcode: this.passcodeElement.value,
                // Rides through to the sign-in this passcode completes - see AuthorizationPane.
                devices: this.config.devices || [],
            });
        });
        this.addHomebridgeListener("invalid-wallpad-passcode", async () => {
            window.homebridge.hideSpinner();
            this.verifyButton.disabled = true;
            window.homebridge.toast.error("월패드 인증번호가 다릅니다.");
            await this.advance({ uuid: undefined }, this.prevPane(), true);
        });
        this.addHomebridgeListener("complete", async (event) => {
            window.homebridge.hideSpinner();
            this.verifyButton.disabled = true;

            console.log("Sign-in successful.");
            const newOptions = {
                uuid: event["data"].uuid,
            }
            if(this.provider === "smart-elife") {
                newOptions["roomKey"] = event["data"].roomKey;
                newOptions["userKey"] = event["data"].userKey;
                newOptions["wallpadVersion"] = event["data"].version;
            }
            await this.advance(newOptions, this.nextPane());
        });
    }

    dispose() {
        stopTimer();
        super.dispose();
    }
}

const DEVICE_REFRESH_FAILED_MESSAGE = "기기 목록을 갱신하지 못했습니다. 저장된 목록으로 설정을 편집합니다.";
const WALLPAD_REAUTHORIZATION_MESSAGE = "월패드 재인증이 필요합니다. 기기 목록을 갱신하려면 '재설정'으로 다시 로그인해주세요.";
const DEVICE_REFRESH_KEPT_MESSAGE = "기기 목록을 조회하지 못했습니다. 저장된 설정은 그대로 유지됩니다.";
const DEVICE_SAVE_FAILED_MESSAGE = "기기 목록을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.";
const SETTINGS_SAVE_FAILED_MESSAGE = "설정을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.";

const DEVICE_TYPE_LABELS = {
    "light": "조명",
    "heat": "난방",
    "wallsocket": "콘센트",
    "vent": "환기",
    "gas": "가스",
    "aircon": "에어컨",
    "aircon2": "에어컨",
    "alloffswitch": "일괄소등",
    "indoorair": "공기질",
    "elevator": "엘리베이터",
    "door": "현관",
    "smartdoor": "도어락",
    "vehicle": "주차",
    "camera": "초인종 카메라",
};

function escapeHtml(text) {
    return String(text ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function devicesEquals(provider, oldDevice, newDevice) {
    if(provider === "daelim") {
        return oldDevice.name === newDevice.name
            && oldDevice.deviceId === newDevice.deviceId
            && oldDevice.deviceType === newDevice.deviceType;
    } else {
        return oldDevice.deviceType === newDevice.deviceType
            && oldDevice.name === newDevice.name
            && oldDevice.deviceId === newDevice.deviceId;
    }
}

// Merges a fetched device list against the saved one, keeping the saved entry
// (with its display name and disabled flag) wherever the device is already known,
// and says what saving the merge would add and take away.
function mergeFetchedDevices(provider, savedDevices, fetchedDevices) {
    const availableDevices = [];
    for(const device of fetchedDevices) {
        const equiv = savedDevices
            .filter(oldDevice => devicesEquals(provider, oldDevice, device));
        if(!equiv || !equiv.length) {
            availableDevices.push(device);
        } else {
            availableDevices.push(equiv[0]);
        }
    }
    const added = fetchedDevices.filter(device =>
        !savedDevices.some(oldDevice => devicesEquals(provider, oldDevice, device)));
    const removed = savedDevices.filter(oldDevice =>
        !availableDevices.some(device => devicesEquals(provider, oldDevice, device)));
    return { availableDevices, added, removed };
}

/**
 * The device-list confirmation procedure, on its own pane.
 *
 * Nothing is saved while this pane is showing. The fetched list is a candidate until
 * the resident presses '확인하고 저장' - that press is the confirmation the household
 * judgement stands on ever after - and '다시 조회' asks the server again, which signs
 * in anew and reads the page right after, the most reliable moment there is (#198).
 *
 * Exclusive to the Smart eLife provider, whose device list cannot be trusted as
 * fetched: the sign-in panes route only smart-elife here, and canPassthrough keeps
 * a provider check as a second line of defence. daelim's per-complex server answers
 * for one household alone, so its wizard skips this procedure entirely.
 *
 * A member of the wizard chain, between the sign-in panes and CompletePane. Finished
 * settings pass straight through - a saved list is a confirmed one - while a
 * first-time setup stops here, asks the server, and shows what it got: "loading"
 * becomes "first" (the whole fetched list), or "first-failed" (retry as the only way
 * forward). CompletePane also enters it explicitly with a payload, which never
 * passes through: "diff" shows what a re-fetch would add and take away, on the way
 * into the advanced editor.
 */
class DeviceConfirmPane extends Pane {
    constructor(element, config, payload) {
        super(element, config);

        // With a payload this pane was entered deliberately, carrying a judged list;
        // without one it is a chain member that has to ask the server itself.
        this._explicit = !!payload;
        payload = payload || {};
        this._mode = payload.mode || "loading";
        this._devices = payload.devices || [];
        this._added = payload.added || [];
        this._removed = payload.removed || [];
        // Display-only: the resident's own room names, keyed by device id.
        this._aliases = payload.aliases || {};
        // Whether the last re-fetch request produced any terminal event;
        // a request that resolves without one gave up quietly and counts as a failure.
        this._answered = false;
        // One operation at a time. Refetching while a save is committing (or the other
        // way around) would let two paths advance() off this pane, or let a disposed
        // pane mistake its still-running refetch for a quiet failure.
        this._busy = false;
        // Latched once a transition off this pane has started. The refetch request can
        // settle while the devices-fetched handler is still mid-advance() - the event
        // emitter does not await its handlers - and the click handler's finally must
        // not re-enable the departing screen's buttons in that gap.
        this._advancing = false;

        this.pane = document.createElement("div");
        this.pane.classList.add("hidden");
        this.pane.id = "device-confirm";
    }

    canPassthrough() {
        if(this._explicit) {
            // Entered deliberately, with a list to confirm - always shown.
            return false;
        }
        // As a chain member it only stops the wizard where nothing is confirmed yet:
        // a saved list means a confirmed one. The provider clause is defence in
        // depth - the sign-in panes only route smart-elife here - so a misrouted
        // daelim chain would still pass through untouched.
        return this.config.provider !== "smart-elife"
            || (this.config.devices || []).length > 0;
    }

    nextPane() {
        return new CompletePane(this.element, this.config);
    }

    selfPane() {
        return this.pane;
    }

    _deviceRow(device, badge) {
        const label = badge === "removed"
            ? `<span class="badge badge-danger ml-2">제외됨</span>`
            : badge === "added"
                ? `<span class="badge badge-success ml-2">추가됨</span>`
                : "";
        const strike = badge === "removed" ? ` style="text-decoration: line-through;"` : "";
        const displayName = device.displayName || device.deviceId;
        // The side slot names the room the device is in - the name the resident
        // gave it where there is one, the canonical name otherwise, and nothing
        // where the page carried neither.
        const aside = this._aliases[device.deviceId] || "";
        return `<li class="list-group-item d-flex justify-content-between align-items-center py-1 px-3">
            <span${strike}>${escapeHtml(displayName)}${label}</span>
            <small style="opacity: .65;">${escapeHtml(aside)}</small>
        </li>`;
    }

    _deviceGroupHeader(title) {
        // Styled with inherited colour and translucency rather than bootstrap's
        // bg-light/text-muted, which assume a light theme - Config UI X renders
        // this pane in the resident's theme, dark included.
        return `<li class="list-group-item py-1 px-3" style="background: rgba(127, 127, 127, .12);">
            <small class="font-weight-bold" style="opacity: .75;">${escapeHtml(title)}</small>
        </li>`;
    }

    // The whole fetched list, grouped by device type in order of first appearance.
    _deviceListRows(devices) {
        const groups = new Map();
        for(const device of devices) {
            const label = DEVICE_TYPE_LABELS[device.deviceType] || device.deviceType;
            if(!groups.has(label)) {
                groups.set(label, []);
            }
            groups.get(label).push(device);
        }
        const rows = [];
        for(const [label, members] of groups) {
            rows.push(this._deviceGroupHeader(label));
            for(const device of members) {
                rows.push(this._deviceRow(device));
            }
        }
        return rows.join("");
    }

    _screenHtml() {
        if(this._mode === "loading") {
            return `
                <div class="text-center">
                    <h2>기기 목록을 조회하고 있습니다.</h2>
                    <p>잠시만 기다려주세요.</p>
                </div>
            `;
        }
        if(this._mode === "first-failed") {
            return `
                <div class="text-center">
                    <h2>기기 목록을 조회하지 못했습니다.</h2>
                    <p>잠시 후 '다시 조회'를 눌러주세요.</p>
                    <button type="button" id="refetch-button" class="btn btn-secondary">다시 조회</button>
                </div>
            `;
        }
        if(this._mode === "first") {
            return `
                <div class="text-center">
                    <h2>기기 목록을 확인해주세요.</h2>
                    <p>${this._devices.length}개의 기기가 조회되었습니다. 아래 목록이 맞는지 확인해주세요.</p>
                </div>
                <ul class="list-group mb-3 text-left" style="max-height: 220px; overflow-y: auto; font-size: 14px;">
                    ${this._deviceListRows(this._devices)}
                </ul>
                <div class="text-center">
                    <button type="button" id="refetch-button" class="btn btn-secondary">다시 조회</button>
                    <button type="button" id="confirm-save-button" class="btn btn-primary">확인하고 저장</button>
                </div>
            `;
        }
        // "diff": what an explicit save would add and take away, against the saved list.
        const keptCount = this._devices.length - this._added.length;
        const rows = [this._deviceGroupHeader("변경")];
        for(const device of this._added) {
            rows.push(this._deviceRow(device, "added"));
        }
        for(const device of this._removed) {
            rows.push(this._deviceRow(device, "removed"));
        }
        rows.push(`<li class="list-group-item py-1 px-3 text-center">
            <small style="opacity: .65;">외 ${keptCount}개 유지</small>
        </li>`);
        return `
            <div class="text-center">
                <h2>기기 목록에 달라진 내용이 있습니다.</h2>
                <p>달라진 내용이 사실이 아니라면 '다시 조회'를 눌러주세요.<br>
                '확인하고 저장'을 누르기 전까지 기존 설정은 그대로 유지됩니다.</p>
            </div>
            <ul class="list-group mb-3 text-left" style="max-height: 200px; overflow-y: auto; font-size: 14px;">
                ${rows.join("")}
            </ul>
            <div class="text-center">
                <button type="button" id="refetch-button" class="btn btn-secondary">다시 조회</button>
                <button type="button" id="confirm-save-button" class="btn btn-primary">확인하고 저장</button>
            </div>
        `;
    }

    _render() {
        this.pane.innerHTML = this._screenHtml();
    }

    _setButtonsDisabled(disabled) {
        for(const button of this.pane.querySelectorAll("button")) {
            button.disabled = disabled;
        }
    }

    async _refetch(force = true) {
        window.homebridge.showSpinner();
        this._answered = false;
        try {
            await window.homebridge.request(`/${this.config.provider}/fetch-devices`, {
                region: this.config.region,
                complex: this.config.complex,
                username: this.config.username,
                password: this.config.password,
                // The saved device list rides along as the yardstick the server holds
                // fetched pages against. Empty on a first-time setup.
                devices: this.config.devices || [],
                force: !!force,
            });
        } catch(error) {
            console.error("Refreshing devices failed:", error);
        } finally {
            window.homebridge.hideSpinner();
        }
        if(!this._answered) {
            this._onRefetchFailed();
        }
    }

    _onRefetchFailed() {
        this._answered = true;
        if(this._mode === "loading" || this._mode === "first-failed") {
            // Still nothing to show; retry is the only way forward.
            this._mode = "first-failed";
            this._render();
            return;
        }
        // The candidate on screen is left exactly as it was.
        window.homebridge.toast.warning(DEVICE_REFRESH_KEPT_MESSAGE);
    }

    // A failed step must hand the screen back - without this, a refused save or a
    // failed transition leaves `_advancing` latched and the pane dead until the
    // settings are reopened.
    _recoverFromFailure() {
        this._advancing = false;
        this._busy = false;
        this._setButtonsDisabled(false);
    }

    async _save() {
        const mode = this._mode;
        const savedDevices = this.config.devices;
        this._advancing = true;
        try {
            this.config.devices = this._devices;
            await this.updatePluginConfig();
            await this.savePluginConfig();
        } catch(error) {
            console.error("Saving the device list failed:", error);
            // Nothing was persisted; the saved list stays the yardstick.
            this.config.devices = savedDevices;
            try {
                await this.updatePluginConfig();
            } catch {
                // The next update rewrites the whole config block anyway.
            }
            window.homebridge.toast.warning(DEVICE_SAVE_FAILED_MESSAGE);
            this._recoverFromFailure();
            return;
        }
        try {
            await this.advance({}, new CompletePane(this.element, this.config, {
                // The resident was on their way to the editor - continue there.
                openAdvanced: mode === "diff",
            }));
        } catch(error) {
            // The list is saved; only the screen failed to move on.
            console.error("Leaving the confirmation screen failed:", error);
            this._recoverFromFailure();
        }
    }

    register() {
        this.ensureAttached();
        refreshTrademark(this.config);
        this._render();

        if(!this._explicit) {
            // A chain member arrives with nothing and asks the server itself.
            // The sign-in that brought the wizard this far left its list in the
            // wizard server's cache, so this resolves without another login.
            setTimeout(async () => {
                await this._refetch(false);
            }, 0);
        }

        // One delegated listener survives every re-render;
        // wiring the buttons anew per render would pile up dead handler bookkeeping.
        // While either operation runs, BOTH buttons are disabled - '확인하고 저장'
        // during a refetch (or the reverse) would race two advance() paths.
        this.addListener(this.pane, "click", async (event) => {
            const button = event.target.closest("button");
            if(!button || button.disabled || this._busy) {
                return;
            }
            this._busy = true;
            this._setButtonsDisabled(true);
            try {
                if(button.id === "refetch-button") {
                    await this._refetch();
                } else if(button.id === "confirm-save-button") {
                    await this._save();
                }
            } finally {
                // Once a transition has started this pane is on its way out, and its
                // buttons stay dead - the request may settle before the handler that
                // is advancing off this pane does.
                if(!this._advancing) {
                    this._busy = false;
                    // A refetch re-rendered fresh (enabled) buttons; re-enabling
                    // covers the failure paths that kept the old screen.
                    this._setButtonsDisabled(false);
                }
            }
        });

        this.addHomebridgeListener("devices-fetched", async (event) => {
            this._answered = true;
            if(this._advancing) {
                // Already leaving this pane; a late list must not redraw it
                // or start a second transition.
                return;
            }
            const {availableDevices, added, removed} = mergeFetchedDevices(
                this.config.provider, this.config.devices || [], event["data"].devices);
            this._aliases = event["data"].aliases || {};

            if((this.config.devices || []).length === 0) {
                // First-time setup: the list itself is the screen.
                this._mode = "first";
                this._devices = availableDevices;
                this._added = added;
                this._removed = removed;
                this._render();
                return;
            }
            if(added.length === 0 && removed.length === 0) {
                // The re-fetch converged with the saved list - saving would be a no-op,
                // so there is nothing left to confirm. Continue to the editor the
                // resident was headed for.
                this._advancing = true;
                try {
                    await this.advance({}, new CompletePane(this.element, this.config, {
                        openAdvanced: this._mode === "diff",
                    }));
                } catch(error) {
                    console.error("Leaving the confirmation screen failed:", error);
                    this._recoverFromFailure();
                }
                return;
            }
            // A re-fetch changed the picture - redraw it against the saved list.
            this._mode = "diff";
            this._devices = availableDevices;
            this._added = added;
            this._removed = removed;
            this._render();
        });
        this.addHomebridgeListener("device-refresh-failed", () => {
            this._onRefetchFailed();
        });
        this.addHomebridgeListener("authorization-failed", () => {
            this._answered = true;
            window.homebridge.toast.warning(DEVICE_REFRESH_FAILED_MESSAGE);
            if(this._mode === "loading") {
                // The loading screen has no buttons to fall back on.
                this._mode = "first-failed";
                this._render();
            }
        });
        this.addHomebridgeListener("require-wallpad-passcode", () => {
            this._answered = true;
            window.homebridge.toast.warning(WALLPAD_REAUTHORIZATION_MESSAGE);
            if(this._mode === "loading") {
                this._mode = "first-failed";
                this._render();
            }
        });
    }
}

class CompletePane extends Pane {
    constructor(element, config, options) {
        super(element, config);

        // Device data still arrives through an event for compatibility, while each
        // provider request now has its own terminal success or failure.
        this._settled = false;
        // Not the same thing as `_settled`: a failed refresh for an existing
        // configuration reaches its terminal state with the editor deliberately
        // locked - the fetched list it would edit does not exist. Only `_settle()`
        // unlocks, and failure recovery restores buttons from this flag, not from
        // `_settled`.
        this._advancedUnlocked = false;
        this._refreshed = false;
        this._advancedFormOpened = false;

        // What the last fetch reported where it differs from the saved list, held for
        // the confirmation pane the advanced button hands it to. The config keeps its
        // saved list all the while - that list is also the yardstick the server judges
        // fetched pages against, so replacing it must be a decision, and the decision
        // belongs to DeviceConfirmPane.
        this._pendingFetch = null;
        // Set when the confirmation pane sends the resident onward to the editor.
        this._openAdvancedOnRegister = !!(options && options.openAdvanced);
        // Single-flight latch for every way off this pane. advance() awaits the
        // config update, and a second press in that window would register a second
        // pane - duplicate DOM, duplicate Homebridge listeners.
        this._transitioning = false;

        this.pane = document.createElement("div");
        this.pane.classList.add("hidden");
        this.pane.id = "done";
        this.pane.innerHTML = `
            <div class="text-center">
                <h2>설정이 완료되었습니다.</h2>
                <p>이제 <span class="brand-name">DL E&C</span> 아파트의 가구를 애플 기기에서 제어할 수 있습니다.</p>
                <button type="button" id="advanced-button" class="btn btn-secondary" disabled>고급</button>
                <button type="button" id="reset-button" class="btn btn-primary">재설정</button>
                <button type="button" id="done-button" class="btn btn-primary">닫기</button>
            </div>
        `;
        this.advancedButton = this.pane.querySelector("#advanced-button");
        this.resetButton = this.pane.querySelector("#reset-button");
        this.doneButton = this.pane.querySelector("#done-button");
    }

    selfPane() {
        return this.pane;
    }

    canPassthrough() {
        // this is the EOP (end-of-pane)
        return false;
    }

    nextPane() {
        return new ResetConfirmablePane(this.element, this.config);
    }

    _settle(warning) {
        if(this._settled) {
            return; // only the first terminal state wins
        }
        this._settled = true;
        this._advancedUnlocked = true;
        this.advancedButton.removeAttribute("disabled");
        if(warning) {
            window.homebridge.toast.warning(warning);
        }
    }

    _setActionButtonsDisabled(disabled) {
        // The advanced button only ever unlocks through `_settle()`.
        this.advancedButton.disabled = disabled || !this._advancedUnlocked;
        this.resetButton.disabled = disabled;
        this.doneButton.disabled = disabled;
    }

    // Every way off this pane goes through here: one transition at a time, all
    // action buttons dead while it runs, and both restored if it fails.
    async _transitionTo(makePane) {
        if(this._transitioning) {
            return;
        }
        this._transitioning = true;
        this._setActionButtonsDisabled(true);
        try {
            await this.advance({}, makePane());
        } catch(error) {
            console.error("Leaving the completion screen failed:", error);
            this._transitioning = false;
            this._setActionButtonsDisabled(false);
        }
    }

    async _requestRefresh() {
        window.homebridge.showSpinner();
        try {
            await window.homebridge.request(`/${this.config.provider}/fetch-devices`, {
                region: this.config.region,
                complex: this.config.complex,
                username: this.config.username,
                password: this.config.password,
                // The saved device list rides along as the yardstick the server holds
                // fetched pages against. Empty on a first-time setup, and ignored by daelim.
                devices: this.config.devices || [],
            });
        } catch(error) {
            console.error("Refreshing devices failed:", error);
            if(this.config.provider === "smart-elife") {
                await this._handleRefreshFailure();
            } else {
                // daelim keeps its original terminal state: the saved list stays editable.
                this._settle(DEVICE_REFRESH_FAILED_MESSAGE);
            }
        } finally {
            window.homebridge.hideSpinner();
        }
    }

    async _handleRefreshFailure() {
        this._refreshed = true;
        if(this._advancedFormOpened) {
            return;
        }
        if((this.config.devices || []).length === 0) {
            // First-time setup with nothing fetched - there is nothing to edit yet,
            // so the only way forward is asking again, and the confirmation pane
            // owns the retry.
            await this._transitionTo(() => new DeviceConfirmPane(this.element, this.config,
                { mode: "first-failed" }));
            return;
        }
        // A refresh for an existing configuration failed. The advanced editor stays
        // locked - the fetched list it would edit does not exist - and nothing is saved.
        // Closing and reopening the settings retries, because a failure never
        // replaces the server's device cache.
        window.homebridge.toast.warning(DEVICE_REFRESH_KEPT_MESSAGE);
        this._settled = true;
    }

    async _openAdvancedForm() {
        this._advancedFormOpened = true;

        document.getElementById("setupForm").classList.add("hidden");
        document.getElementById("footer").classList.add("hidden");
        document.getElementById("advancedForm").classList.remove("hidden");

        await this.updatePluginConfig();

        const configSchema = await window.homebridge.getPluginConfigSchema();
        const configForm = window.homebridge.createForm(configSchema, this.config);
        configForm.onChange((change) => {
            Object.assign(this.config, change);
            this.updatePluginConfig();
        });
    }

    register() {
        this.ensureAttached();
        refreshTrademark(this.config);
        if(this._openAdvancedOnRegister) {
            // The confirmation pane already fetched, judged and saved the list on the
            // resident's way to the editor - fetching again here would only replay it.
            this._settle();
            setTimeout(async () => {
                await this._openAdvancedForm();
            }, 0);
        } else {
            setTimeout(async () => {
                await this._requestRefresh();
                if(this.config.provider === "smart-elife" && !this._refreshed) {
                    // The handler awaits the whole sign-in,
                    // so returning without having reported any device means the query gave up quietly.
                    await this._handleRefreshFailure();
                }
            }, 0);
        }

        this.addHomebridgeListener("authorization-failed", () => {
            this._settle(DEVICE_REFRESH_FAILED_MESSAGE);
        });
        // Wallpad certification expired; the resident has to sign in again to refresh.
        this.addHomebridgeListener("require-wallpad-passcode", () => {
            this._settle(WALLPAD_REAUTHORIZATION_MESSAGE);
        });
        this.addHomebridgeListener("device-refresh-failed", () => {
            void this._handleRefreshFailure();
        });
        this.addHomebridgeListener("devices-fetched", async (event) => {
            const devices = event["data"].devices;
            console.log(`Num of devices: ${devices.length}`);

            this._refreshed = true; // mark before yielding, the request may settle next
            if(this._advancedFormOpened) {
                // The user is already editing the device list,
                // and the button can only have been opened by an earlier `_settle()`.
                // Replacing the list now would silently discard those edits.
                return;
            }
            if(this._transitioning) {
                // Already on the way off this pane (재설정, 닫기, or an earlier list);
                // a late list must not race that transition with another one.
                return;
            }

            const savedDevices = this.config.devices || [];
            const {availableDevices, added, removed} = mergeFetchedDevices(
                this.config.provider, savedDevices, devices);

            if(this.config.provider !== "smart-elife") {
                // daelim: the per-complex server answers for this household alone,
                // so the fetched list needs no confirmation.
                this.config.devices = availableDevices;
                await this.updatePluginConfig();
                await this.savePluginConfig();
                this._settle();
                return;
            }

            // smart-elife: nothing is saved here. The fetched list is a candidate until
            // the resident confirms it on DeviceConfirmPane - that press is the
            // confirmation the household judgement stands on ever after.
            const aliases = event["data"].aliases || {};
            if(savedDevices.length === 0) {
                // First-time setup: the list itself is the screen.
                await this._transitionTo(() => new DeviceConfirmPane(this.element, this.config,
                    { mode: "first", devices: availableDevices, added, removed, aliases }));
                return;
            }
            if(added.length === 0 && removed.length === 0) {
                // Nothing changed - saving would be a no-op, so there is nothing to confirm.
                this._pendingFetch = null;
                this._settle();
                return;
            }
            // The confirmation waits until the resident actually goes for the editor.
            this._pendingFetch = { devices: availableDevices, added, removed, aliases };
            this._settle();
        });
        this.addListener(this.resetButton, "click", async () => {
            await this._transitionTo(() => this.nextPane());
        });
        this.addListener(this.doneButton, "click", async () => {
            if(this._transitioning) {
                return;
            }
            // 닫기 holds the latch like every other way off this pane: its awaits
            // leave a window where 재설정 or 고급 would register a pane the close
            // then pulls down, and a double click would save and close twice.
            this._transitioning = true;
            this._setActionButtonsDisabled(true);
            try {
                await this.updatePluginConfig();
                await this.savePluginConfig();
            } catch(error) {
                console.error("Saving the configuration failed:", error);
                window.homebridge.toast.warning(SETTINGS_SAVE_FAILED_MESSAGE);
                this._transitioning = false;
                this._setActionButtonsDisabled(false);
                return;
            }
            window.homebridge.closeSettings();
        });

        this.addListener(this.advancedButton, "click", async () => {
            if(this._transitioning) {
                return;
            }
            if(this.config.provider === "smart-elife" && this._pendingFetch) {
                // The fetched list differs from the saved one - show what saving would
                // change before the editor built on that list opens.
                await this._transitionTo(() => new DeviceConfirmPane(this.element, this.config,
                    { mode: "diff", ...this._pendingFetch }));
                return;
            }
            await this._openAdvancedForm();
        });
    }

}

class ResetConfirmablePane extends Pane {
    constructor(element, config) {
        super(element, config);

        this.pane = document.createElement("div");
        this.pane.classList.add("hidden");
        this.pane.id = "confirmable";
        this.pane.innerHTML = `
            <div class="text-center">
                <h2>정말 재설정하시겠습니까?</h2>
                <p>확인 시 모든 저장된 설정이 초기화됩니다.</p>
                <button type="button" id="reset-confirmed-button" class="btn btn-primary">확인</button>
                <button type="button" id="reset-cancel-button" class="btn btn-primary">취소</button>
            </div>
        `;
        this.confirmButton = this.pane.querySelector("#reset-confirmed-button");
        this.cancelButton = this.pane.querySelector("#reset-cancel-button");
    }

    canPassthrough() {
        return false;
    }

    selfPane() {
        return this.pane;
    }

    register() {
        this.ensureAttached();
        this.addListener(this.confirmButton, "click", async () => {
            window.homebridge.showSpinner();

            const provider = this.config.provider;

            // invalidate all.
            this.config.provider = undefined;
            this.config.region = undefined;
            this.config.complex = undefined;
            this.config.username = undefined;
            this.config.password = undefined;
            this.config.uuid = undefined;
            this.config.devices = [];

            await window.homebridge.request(`/${provider}/invalidate`, {});
            await this.updatePluginConfig();
            await this.savePluginConfig();

            refreshTrademark(this.config);
            window.homebridge.hideSpinner();

            await this.advance({}, new ProviderPane(this.element, this.config));
        });
        this.addListener(this.cancelButton, "click", async () => {
            await this.advance({}, new CompletePane(this.element, this.config));
        });
    }
}
