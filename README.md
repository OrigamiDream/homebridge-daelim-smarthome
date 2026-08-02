<p align="center">
  <img alt="logo" src="https://github.com/OrigamiDream/homebridge-daelim-smarthome/blob/main/branding/smarthome+homebridge.png?raw=true" height="140px">
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
7. 엘리베이터 호출 (도착 알림은 Smart eLife 한정 지원)
8. 세대현관 및 공동현관 출입 모션 센서
9. 입차 모션 센서
10. 세대현관 및 공동현관 방문자 이미지 표시<sup>[3](#hksv)</sup>
11. 세대현관 및 공동현관 방문자 알림
12. 세대현관 실시간 영상<sup>[4](#onepass)</sup> (Smart eLife 한정 지원)

> [!WARNING]
> e편한세상 스마트홈 2.0 및 Smart eLife 앱은 동시접속 및 다중 로그인을 지원하지 않습니다.
> 따라서 이 플러그인 전용의 세대원 계정을 앱에서 하나 더 추가하시거나, 기존 계정을 로그아웃하신 후 사용하시기 바랍니다.
> 위 주의사항을 따르지 않을 시 로그인/로그아웃이 무한정 반복되며 정상적인 이용이 불가능할 수 있습니다.

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
<sub><b id="hksv">3</b> HomeKit Secure Video를 통해 표기되며, 홈킷 허브인 Apple TV 혹은 HomePod이 있어야 합니다.</sub><br>
<sub><b id="onepass">4</b> e편한세상 One Pass 인터폰 회선을 이용합니다. 기본 비활성이며 설정에서 켜야 합니다. 자세한 내용은 아래 <a href="#세대현관-실시간-영상-one-pass">세대현관 실시간 영상</a>을 참고하세요.</sub>

## 세대현관 실시간 영상 (One Pass)

기본적으로 `외부 세대현관 초인종` 카메라는 마지막 방문자의 정지 이미지 한 장만 보여줍니다. 설정에서 **세대현관 실시간 영상**을 켜면, 카메라를 열 때 e편한세상 One Pass 인터폰 회선으로 현재 세대현관 영상을 실시간으로 불러옵니다.

Homebridge 설정 화면의 `세대현관 실시간 영상 (One Pass)` 항목에서 켤 수 있고, config.json에 직접 쓸 때는 다음과 같습니다.

```json
{
  "platform": "DaelimSmartHomePlatform",
  "provider": "smart-elife",
  "onePass": {
    "enabled": true
  }
}
```

아이디와 동·호수는 스마트홈 로그인 정보에서 자동으로 채워집니다. 자동 조회가 실패하는 단지에서만 `userId`, `building`, `unit`, `complexCode`, `host`를 직접 지정하세요.

> [!IMPORTANT]
> 인터폰 회선은 한 번에 한 통화만 가능합니다. 실시간 영상을 보는 동안에는 폰의 One Pass 앱에서 세대현관을 모니터링할 수 없고, 반대로 앱이 모니터링 중이면 플러그인이 실시간 영상을 가져오지 못합니다. 이 경우 홈 앱이 카메라를 열지 못하고 자체 오류를 표시합니다. 카메라 타일의 미리보기 이미지와 초인종 알림의 방문자 사진은 그대로 동작합니다.

> [!NOTE]
> 이 기능은 **Smart eLife 전용**이며 **세대현관에만** 적용됩니다. `외부 공동현관 초인종`은 계속 방문자 스냅샷으로 동작합니다.

영상이 뜨지 않고 로그에 통화 실패가 남는다면 공유기가 SIP 트래픽(5061/TCP)을 막고 있을 수 있습니다. [문제 해결](TROUBLESHOOTING.md#세대현관-실시간-영상이-뜨지-않는-경우) 문서를 참고하세요.