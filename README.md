<p align="center">
  <img alt="logo" src="https://github.com/OrigamiDream/homebridge-daelim-smarthome/blob/master/branding/smarthome+homebridge.png?raw=true" height="140px">
</p>

# Homebridge DL E&C Smart Home

[![Verified by Homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![Downloads](https://img.shields.io/npm/dt/homebridge-daelim-smarthome.svg?color=critical)](https://www.npmjs.com/package/homebridge-daelim-smarthome)
[![Version](https://img.shields.io/npm/v/homebridge-daelim-smarthome)](https://www.npmjs.com/package/homebridge-daelim-smarthome)

e편한세상 및 아크로 계열 아파트 단지를 위한 공식 [Homebridge](https://github.com/homebridge/homebridge) 플러그인

다음의 기능들을 지원합니다.
1. 전등
2. 난방
3. 콘센트
4. 가스 (단방향)
5. 엘레베이터 호출 (도착알림 없음)
6. 세대현관 및 공동현관 출입 모션 센서
7. 입차 모션 센서
8. HomeKit Secure Video를 통한 세대현관 및 공동현관 방문자 표시
9. 세대현관 및 공동현관 방문자 알림

###### DL건설에서 새로 출시한 [스마트 eLife](https://apps.apple.com/kr/app/%EC%8A%A4%EB%A7%88%ED%8A%B8-elife/id1551248421) 앱과 호환되지 않습니다.<br>해당 아파트 거주민 중 개발을 도와주실 의향이 있으시다면 [새 이슈 작성](https://github.com/OrigamiDream/homebridge-daelim-smarthome/issues/new)을 해 주시기 바랍니다.


## 설치 요구사항

<img alt="node" src="https://img.shields.io/badge/node-%3E%3D14.15-brightgreen"> <img alt="homebridge" src="https://img.shields.io/badge/homebridge-%3E%3D1.0.0-brightgreen"> <img alt="iOS" src="https://img.shields.io/badge/iOS-%3E%3D12.0.0-brightgreen">

## 설치

### Homebridge Config UI X를 이용한 설치

1. 가장 마지막 버전의 Homebridge Config UI X가 설치되어 있다면 검색 페이지에서 `homebridge-daelim-smarthome`을 검색하여 설치할 수 있습니다.
2. 설치 후 플러그인 구성 지침에 따르세요.

### Terminal에서 설치

<small>Node.js 환경을 필요로합니다.</small>

```
sudo npm install -g --unsafe-perm homebridge-daelim-smarthome
```

### 직접 빌드하여 Terminal에서 설치

<small>Node.js 환경을 필요로합니다.</small>

1. `git clone https://github.com/OrigamiDream/homebridge-daelim-smarthome.git`을 통해 레포지토리를 로컬에 설치합니다.
2. `cd homebridge-daelim-smarthome`으로 로컬에 설치된 레포지토리로 이동합니다.
3. `npm i && npm run build`로 플러그인을 빌드합니다.
4. `npm link`로 npm 패키지를 등록합니다.
5. Homebridge-ui 웹사이트로 이동하면 플러그인 목록에서 `homebridge-daelim-smarthome`을 찾을 수 있습니다.
6. 설정 버튼을 눌러 플러그인 구성 지침에 따르세요.
