# 문제 해결

다양한 스펙트럼의 사용자들이 이 소프트웨어를 사용하다 보면 개발자가 예상치 못한 부분에 대하여 때로는 문제나 어려움을 겪을 수도 있습니다.<br>
이를 해결하기 위하여 본 문서의 절차를 따라 이슈를 작성해주시거나 메일로 문의해주세요.
<br>
<br>

## homebridge-ui를 사용하는 사용자의 경우
1. 해당 문제가 발생했을 때, 어떠한 절차를 거쳐야 문제를 재현할 수 있는지 최대한 설명해주시면 큰 도움이 됩니다.
2. 로그 다운로드 및 첨부
   1. homebridge-ui 관리 패널에 접속
   2. 우측 상단 `로그 보기` 버튼 클릭
   3. 우측 상단 `다운로드` 버튼 클릭 (사용자 환경에 따라 개인정보 등이 포함될 수 있습니다.)
   4. 다운로드된 `homebridge.log.txt` 파일을 적절한 검열을 거쳐 [새 이슈 작성](https://github.com/OrigamiDream/homebridge-daelim-smarthome/issues/new)을 해 주시거나 개발자의 [메일](mailto:hello@origamidream.me)로 보내주세요.

<br>
<br>

## Terminal에서 직접적으로 사용하는 사용자의 경우
1. 해당 문제가 발생했을 때, 어떠한 절차를 거쳐야 문제를 재현할 수 있는지 최대한 설명해주시면 큰 도움이 됩니다.
2. 로그 다운로드
   1. Terminal 에서 `~/.homebridge` 혹은 사용자 설정된 Homebridge 디렉토리로 이동
   2. `homebridge.log` 파일을 적절한 검열을 거쳐 [새 이슈 작성](https://github.com/OrigamiDream/homebridge-daelim-smarthome/issues/new)을 해 주시거나 개발자의 [메일](mailto:hello@origamidream.me)로 보내주세요.

<br>
<br>

## homebridge.log 파일에서 오류를 분간하는 방법

homebridge-ui 패널의 콘솔에서 관찰하는 경우, 오류가 발생한 기록은 보통 `빨간색`으로 표시됩니다.<br>
혹은 `TypeError`, `ReferenceError` 등의 문구가 포함되어 오류임을 구분할 수 있습니다.<br><br>
해당 부분으로부터 **위, 아래로 약 30~50줄 사이를 포함한 텍스트**에서 개인정보를 최대한 가린 후 위 절차를 따라 주세요.