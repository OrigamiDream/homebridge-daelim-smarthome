<p align="center">
  <img alt="logo" src="https://github.com/OrigamiDream/homebridge-daelim-smarthome/blob/master/branding/smarthome+homebridge.png?raw=true" height="140px">
</p>

# Homebridge DL E&C Smart Home

[![Verified by Homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![Downloads](https://img.shields.io/npm/dt/homebridge-daelim-smarthome.svg?color=critical)](https://www.npmjs.com/package/homebridge-daelim-smarthome)
[![Version](https://img.shields.io/npm/v/homebridge-daelim-smarthome)](https://www.npmjs.com/package/homebridge-daelim-smarthome)

e편한세상 및 아크로 계열 아파트 단지를 위한 [Homebridge](https://github.com/homebridge/homebridge) 인증된 플러그인

**e편한세상 스마트홈 2.0** 및 **Smart eLife** 앱 사용자 대상으로 다음의 기능들을 지원합니다.
1. 전등<sup>[1](#lightbulb)</sup>
2. 난방
3. 콘센트
4. 환풍기<sup>[2](#fans)</sup>
5. 시스템 에어컨
6. 가스 밸브 (단방향)
7. 엘레베이터 호출 (도착 알림은 Smart eLife 한정 지원)
8. 세대현관 및 공동현관 출입 모션 센서
9. 입차 모션 센서
10. 세대현관 및 공동현관 방문자 이미지 표시<sup>[3](#hksv)</sup>
11. 세대현관 및 공동현관 방문자 알림

## 설치 요구사항

<img alt="node" src="https://img.shields.io/badge/node-%3E%3D14.15-brightgreen"> <img alt="homebridge" src="https://img.shields.io/badge/homebridge-%3E%3D1.5.1-brightgreen"> <img alt="iOS" src="https://img.shields.io/badge/iOS-%3E%3D12.0.0-brightgreen">

## 설치

### Homebridge Config UI X를 이용한 설치

1. 가장 마지막 버전의 Homebridge Config UI X가 설치되어 있다면 검색 페이지에서 `homebridge-daelim-smarthome`을 검색하여 설치할 수 있습니다.
2. 설치 후 플러그인 구성 지침에 따르세요.

### Terminal에서 설치

<small>Node.js 환경을 필요로합니다.</small>

```
sudo npm install -g --unsafe-perm homebridge-daelim-smarthome
```

### 직접 빌드하여 설치 (macOS, Linux 전용)

<small>Node.js 환경을 필요로합니다.</small>

1. `git clone https://github.com/OrigamiDream/homebridge-daelim-smarthome.git`을 통해 레포지토리를 로컬에 설치합니다.
2. `cd homebridge-daelim-smarthome`으로 로컬에 설치된 레포지토리로 이동합니다.
3. `npm i && npm run build`로 플러그인을 빌드합니다.
4. `npm link`로 npm 패키지를 등록합니다.
5. Homebridge-UI 웹사이트로 이동하면 플러그인 목록에서 `homebridge-daelim-smarthome`을 찾을 수 있습니다.
6. 설정 버튼을 눌러 플러그인 구성 지침에 따르세요.

### 직접 빌드하여 설치 (Homebridge Docker Terminal 내에서 작업)

1. `git clone https://github.com/OrigamiDream/homebridge-daelim-smarthome.git`을 통해 레포지토리를 로컬에 설치합니다.
2. `npm install ./homebridge-daelim-smarthome`으로 플러그인을 빌드 및 설치합니다.
3. 문제가 생긴 경우, `npm install hap-nodejs` 실행 후 Step 2 를 다시 수행합니다.
4. Homebridge-UI 웹사이트로 이동하면 플러그인 목록에서 `homebridge-daelim-smarthome`을 찾을 수 있습니다.
5. 설정 버튼을 눌러 플러그인 구성 지침에 따르세요.

<sub><b id="lightbulb">1</b> 세대에 따라 거실 전등 밝기를 3단계 혹은 8단계로 조절 가능합니다.</sub><br>
<sub><b id="fans">2</b> 일부 세대의 경우 환풍기 풍량 조절이 가능합니다.</sub><br>
<sub><b id="hksv">3</b> HomeKit Secure Video를 통해 표기되며, 홈킷 허브인 Apple TV 혹은 HomePod이 있어야 합니다.</sub>