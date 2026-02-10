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
                        <img class="img-fluid mb-2 w-25" style="border-radius: 24%" alt="DL E&C Smart Home" src="https://github.com/OrigamiDream/homebridge-daelim-smarthome/blob/feature/smart-elife/branding/daeilm.png?raw=true">
                        <input class="form-check-input" type="radio" name="provider" value="daelim" checked>
                        <span>e편한세상 스마트홈 2.0</span>
                    </label>
                    <label class="d-flex flex-column align-items-center m-3">
                        <img class="img-fluid mb-2 w-25" style="border-radius: 24%" alt="Smart eLife" src="https://github.com/OrigamiDream/homebridge-daelim-smarthome/blob/feature/smart-elife/branding/smart-elife.png?raw=true">
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
            return new ComplexPane(this.element, this.config, "smart-elife");
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
        this.url = "https://raw.githubusercontent.com/OrigamiDream/homebridge-daelim-smarthome/master/complexes/regions.json";

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
        this.url = `https://raw.githubusercontent.com/OrigamiDream/homebridge-daelim-smarthome/refs/heads/feature/smart-elife/complexes/${provider}/complexes.json`

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
            this.usernameElement.value.length <= 5 ||
            this.passwordElement.value.length <= 5
        );
    }

    prevPane() {
        return new ComplexPane(this.element, this.config, this.provider);
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
        if(this.provider === "daelim") {
            this.verifyButton.disabled = this.passcodeElement.value.length < 12;
        } else {
            this.verifyButton.disabled = this.passcodeElement.value.length < 8;
        }
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

class CompletePane extends Pane {
    constructor(element, config) {
        super(element, config);

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

    devicesEquals(oldDevice, newDevice) {
        if(this.config.provider === "daelim") {
            return oldDevice.name === newDevice.name
                && oldDevice.deviceId === newDevice.deviceId
                && oldDevice.deviceType === newDevice.deviceType;
        } else {
            return oldDevice.deviceType === newDevice.deviceType
                && oldDevice.deviceItemType === newDevice.deviceItemType
                && oldDevice.alias === newDevice.alias
                && oldDevice.uid === newDevice.uid;
        }
    }

    register() {
        this.ensureAttached();
        refreshTrademark(this.config);
        setTimeout(async () => {
            await window.homebridge.request(`/${this.config.provider}/fetch-devices`, {
                region: this.config.region,
                complex: this.config.complex,
                username: this.config.username,
                password: this.config.password,
            });
        }, 0);
        this.addHomebridgeListener("devices-fetched", async (event) => {
            const devices = event["data"].devices;
            console.log(`Num of devices: ${devices.length}`);

            const availableDevices = [];
            for(const device of devices) {
                const equiv = (this.config.devices || [])
                    .filter(oldDevice => this.devicesEquals(oldDevice, device));
                if(!equiv || !equiv.length) {
                    availableDevices.push(device);
                } else {
                    availableDevices.push(equiv[0]);
                }
            }
            this.config.devices = availableDevices;
            await this.updatePluginConfig();

            this.advancedButton.removeAttribute("disabled");
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
