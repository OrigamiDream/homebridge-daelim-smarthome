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

class CompletePane extends Pane {
    constructor(element, config) {
        super(element, config);

        // Device data still arrives through an event for compatibility, while each
        // provider request now has its own terminal success or failure.
        this._settled = false;
        this._refreshed = false;
        this._advancedFormOpened = false;

        // What the last fetch reported, held until the resident explicitly saves it.
        // The config keeps its saved list all the while - that list is also the yardstick
        // the server judges fetched pages against, so replacing it must be a decision.
        this._pendingDevices = null;
        this._pendingAdded = [];
        this._pendingRemoved = [];
        // Which confirmation screen is showing: "first", "first-failed", "diff", or null.
        this._confirmMode = null;

        this.pane = document.createElement("div");
        this.pane.classList.add("hidden");
        this.pane.id = "done";
        this.pane.innerHTML = `
            <div class="text-center" id="done-main">
                <h2>설정이 완료되었습니다.</h2>
                <p>이제 <span class="brand-name">DL E&C</span> 아파트의 가구를 애플 기기에서 제어할 수 있습니다.</p>
                <button type="button" id="advanced-button" class="btn btn-secondary" disabled>고급</button>
                <button type="button" id="reset-button" class="btn btn-primary">재설정</button>
                <button type="button" id="done-button" class="btn btn-primary">닫기</button>
            </div>
            <div class="hidden" id="device-confirm"></div>
        `;
        this.doneMain = this.pane.querySelector("#done-main");
        this.confirmContainer = this.pane.querySelector("#device-confirm");
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
        this.advancedButton.removeAttribute("disabled");
        if(warning) {
            window.homebridge.toast.warning(warning);
        }
    }

    devicesEquals(oldDevice, newDevice) {
        if(this.config.provider === "daelim") {
            return oldDevice.name === newDevice.name
                && oldDevice.deviceId === newDevice.deviceId
                && oldDevice.deviceType === newDevice.deviceType;
        } else {
            return oldDevice.deviceType === newDevice.deviceType
                && oldDevice.name === newDevice.name
                && oldDevice.deviceId === newDevice.deviceId;
        }
    }

    _deviceRow(device, badge) {
        const label = badge === "removed"
            ? `<span class="badge badge-danger ml-2">빠짐</span>`
            : badge === "added"
                ? `<span class="badge badge-success ml-2">추가</span>`
                : "";
        const strike = badge === "removed" ? ` style="text-decoration: line-through;"` : "";
        return `<li class="list-group-item d-flex justify-content-between align-items-center py-1 px-3">
            <span${strike}>${escapeHtml(device.displayName || device.deviceId)}${label}</span>
            <small class="text-muted">${escapeHtml(device.deviceType)}</small>
        </li>`;
    }

    _deviceGroupHeader(title) {
        return `<li class="list-group-item py-1 px-3 bg-light">
            <small class="font-weight-bold text-muted">${escapeHtml(title)}</small>
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

    _confirmScreenHtml() {
        if(this._confirmMode === "first-failed") {
            return `
                <div class="text-center">
                    <h4>기기 목록을 조회하지 못했습니다.</h4>
                    <p class="small text-muted mb-3">잠시 후 '다시 조회'를 눌러주세요.</p>
                    <button type="button" id="refetch-button" class="btn btn-secondary">다시 조회</button>
                </div>
            `;
        }
        if(this._confirmMode === "first") {
            return `
                <div class="text-center">
                    <h4>기기 목록을 확인해주세요.</h4>
                    <p class="small text-muted mb-2">${this._pendingDevices.length}개의 기기가 조회되었습니다. 아래 목록이 맞는지 확인해주세요.</p>
                </div>
                <ul class="list-group mb-3 text-left" style="max-height: 220px; overflow-y: auto; font-size: 14px;">
                    ${this._deviceListRows(this._pendingDevices)}
                </ul>
                <div class="text-center">
                    <button type="button" id="refetch-button" class="btn btn-secondary">다시 조회</button>
                    <button type="button" id="confirm-save-button" class="btn btn-primary">확인하고 저장</button>
                </div>
            `;
        }
        // "diff": what an explicit save would add and take away, against the saved list.
        const keptCount = this._pendingDevices.length - this._pendingAdded.length;
        const rows = [this._deviceGroupHeader("변경")];
        for(const device of this._pendingAdded) {
            rows.push(this._deviceRow(device, "added"));
        }
        for(const device of this._pendingRemoved) {
            rows.push(this._deviceRow(device, "removed"));
        }
        rows.push(`<li class="list-group-item py-1 px-3 text-center">
            <small class="text-muted">외 ${keptCount}개 유지</small>
        </li>`);
        return `
            <div class="text-center">
                <h4>기기 목록에 달라진 내용이 있습니다.</h4>
                <p class="small text-muted mb-2">달라진 내용이 사실이 아니라면 '다시 조회'를 눌러주세요.<br>
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

    _showConfirm(mode) {
        this._confirmMode = mode;
        this.confirmContainer.innerHTML = this._confirmScreenHtml();
        this.doneMain.classList.add("hidden");
        this.confirmContainer.classList.remove("hidden");

        const refetchButton = this.confirmContainer.querySelector("#refetch-button");
        if(refetchButton) {
            this.addListener(refetchButton, "click", async () => {
                refetchButton.disabled = true;
                await this._requestRefresh(true);
                refetchButton.disabled = false;
            });
        }
        const confirmButton = this.confirmContainer.querySelector("#confirm-save-button");
        if(confirmButton) {
            this.addListener(confirmButton, "click", async () => {
                confirmButton.disabled = true;
                await this._confirmSave();
            });
        }
    }

    _showDone() {
        this._confirmMode = null;
        this.confirmContainer.classList.add("hidden");
        this.confirmContainer.innerHTML = "";
        this.doneMain.classList.remove("hidden");
    }

    async _confirmSave() {
        const mode = this._confirmMode;
        this.config.devices = this._pendingDevices;
        await this.updatePluginConfig();
        await this.savePluginConfig();
        this._pendingDevices = null;
        this._pendingAdded = [];
        this._pendingRemoved = [];
        this._showDone();
        this._settle();
        if(mode === "diff") {
            // The resident was on their way to the editor - continue there.
            await this._openAdvancedForm();
        }
    }

    async _requestRefresh(force) {
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
                force: !!force,
            });
        } catch(error) {
            console.error("Refreshing devices failed:", error);
            if(this.config.provider === "smart-elife") {
                this._handleRefreshFailure();
            } else {
                // daelim keeps its original terminal state: the saved list stays editable.
                this._settle(DEVICE_REFRESH_FAILED_MESSAGE);
            }
        } finally {
            window.homebridge.hideSpinner();
        }
    }

    _handleRefreshFailure() {
        this._refreshed = true;
        if(this._advancedFormOpened) {
            return;
        }
        if(this._confirmMode === "first" || this._confirmMode === "diff") {
            // A re-fetch from a confirmation screen came back empty-handed.
            // The candidate on screen is left exactly as it was.
            window.homebridge.toast.warning(DEVICE_REFRESH_KEPT_MESSAGE);
            return;
        }
        if((this.config.devices || []).length === 0) {
            // First-time setup with nothing fetched - there is nothing to edit yet,
            // so the only way forward is asking again.
            this._showConfirm("first-failed");
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
        setTimeout(async () => {
            await this._requestRefresh(false);
            if(this.config.provider === "smart-elife" && !this._refreshed) {
                // The handler awaits the whole sign-in,
                // so returning without having reported any device means the query gave up quietly.
                this._handleRefreshFailure();
            }
        }, 0);

        this.addHomebridgeListener("authorization-failed", () => {
            this._settle(DEVICE_REFRESH_FAILED_MESSAGE);
        });
        // Wallpad certification expired; the resident has to sign in again to refresh.
        this.addHomebridgeListener("require-wallpad-passcode", () => {
            this._settle(WALLPAD_REAUTHORIZATION_MESSAGE);
        });
        this.addHomebridgeListener("device-refresh-failed", () => {
            this._handleRefreshFailure();
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

            const savedDevices = this.config.devices || [];
            const availableDevices = [];
            for(const device of devices) {
                const equiv = savedDevices
                    .filter(oldDevice => this.devicesEquals(oldDevice, device));
                if(!equiv || !equiv.length) {
                    availableDevices.push(device);
                } else {
                    // The saved entry wins, which is how a renamed accessory, a disabled one and
                    // every per-device setting survive a refresh - including the resident's
                    // choice to merge a light group. `lightbulbGroup` is the exception: it was
                    // resolved from the server's list, so it is taken afresh, and taken away
                    // where the family no longer forms a group at all.
                    const merged = Object.assign({}, equiv[0]);
                    if(device.lightbulbGroup !== undefined) {
                        merged.lightbulbGroup = device.lightbulbGroup;
                    } else {
                        delete merged.lightbulbGroup;
                    }
                    availableDevices.push(merged);
                }
            }

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
            // the resident presses '확인하고 저장' - that press is the confirmation the
            // household judgement stands on ever after.
            this._pendingDevices = availableDevices;
            this._pendingAdded = devices.filter(device =>
                !savedDevices.some(oldDevice => this.devicesEquals(oldDevice, device)));
            this._pendingRemoved = savedDevices.filter(oldDevice =>
                !availableDevices.some(device => this.devicesEquals(oldDevice, device)));

            if(savedDevices.length === 0) {
                // First-time setup: the list itself is the screen.
                this._showConfirm("first");
                return;
            }
            if(this._pendingAdded.length === 0 && this._pendingRemoved.length === 0) {
                // The membership did not change, but the server-owned group resolution
                // may have - it is replaced on every refresh and carries no resident
                // choice, so it is saved without a confirmation there would be
                // nothing to read for.
                const groupsRefreshed = availableDevices.some((device) => {
                    const saved = savedDevices.find((oldDevice) => this.devicesEquals(oldDevice, device));
                    return JSON.stringify(saved?.lightbulbGroup) !== JSON.stringify(device.lightbulbGroup);
                });
                if(groupsRefreshed) {
                    this.config.devices = availableDevices;
                    await this.updatePluginConfig();
                    await this.savePluginConfig();
                }
                // Beyond that, nothing changed - saving would be a no-op,
                // so there is nothing to confirm.
                this._pendingDevices = null;
                const wasRetryFromDiff = this._confirmMode === "diff";
                this._showDone();
                this._settle();
                if(wasRetryFromDiff) {
                    // The re-fetch converged with the saved list;
                    // continue to the editor the resident was headed for.
                    await this._openAdvancedForm();
                }
                return;
            }
            if(this._confirmMode === "diff") {
                // A re-fetch changed the picture - redraw it against the saved list.
                this._showConfirm("diff");
                return;
            }
            // The confirmation waits until the resident actually goes for the editor.
            this._settle();
        });
        this.addListener(this.resetButton, "click", async () => {
            await this.advance({}, this.nextPane());
        });
        this.addListener(this.doneButton, "click", async () => {
            await this.updatePluginConfig();
            await this.savePluginConfig();
            window.homebridge.closeSettings();
        });

        this.addListener(this.advancedButton, "click", async () => {
            if(this.config.provider === "smart-elife" && this._pendingDevices
                && (this._pendingAdded.length > 0 || this._pendingRemoved.length > 0)) {
                // The fetched list differs from the saved one - show what saving would
                // change before the editor built on that list opens.
                this._showConfirm("diff");
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
