<p align="center">
  <img alt="logo" src="https://github.com/OrigamiDream/homebridge-daelim-smarthome/blob/master/branding/smarthome+homebridge.png?raw=true" height="140px">
</p>

# homebridge-daelim-smarthome

e편한세상 아파트 단지를 위한 비공식 [Homebridge](https://github.com/homebridge/homebridge) 플러그인

다음의 액세서리를 지원합니다.
1. 전등
2. 난방
3. 콘센트
4. 가스 (단방향)

## 설치 요구사항

<img alt="node" src="https://img.shields.io/badge/node-%3E%3D10.17-brightgreen"> &nbsp;
<img alt="homebridge" src="https://img.shields.io/badge/homebridge-%3E%3D1.0.0-brightgreen"> &nbsp;
<img alt="iOS" src="https://img.shields.io/badge/iOS-%3E%3D12.0.0-brightgreen">

## 설치

### Homebridge-ui를 이용한 설치

1. 가장 마지막 버전의 Homebridge-ui가 설치되어 있다면 검색 페이지에서 `homebridge-daelim-smarthome`을 검색하여 설치할 수 있습니다.
2. 설치 후 플러그인 구성 지침에 따르세요.

### 직접 빌드하여 Terminal에서 설치

<small>Node.js 환경을 필요로합니다.</small>

1. `git clone https://github.com/OrigamiDream/homebridge-daelim-smarthome.git`을 통해 레포지토리를 로컬에 설치합니다.
2. `cd homebridge-daelim-smarthome`으로 로컬에 설치된 레포지토리로 이동합니다.
3. `npm i && npm run build`로 플러그인을 빌드합니다.
4. `npm link`로 npm 패키지를 등록합니다.
5. Homebridge-ui 웹사이트로 이동하면 플러그인 목록에서 `homebridge-daelim-smarthome`을 찾을 수 있습니다.
6. 설정 버튼을 눌러 플러그인 구성 지침에 따르세요.