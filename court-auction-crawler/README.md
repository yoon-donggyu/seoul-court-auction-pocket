# 서울 법원경매 일일 수집기

대한민국 법원 경매정보의 물건상세검색 화면에서 서울 5개 지방법원의 향후 2주 매각 물건을 매일 01:00(KST)에 수집합니다.

## 동작 원칙

- 서울중앙·동부·서부·남부·북부지방법원을 순차 조회합니다.
- 요청 사이에 2.5~5초 간격을 둡니다.
- 사건번호·물건번호 기준으로 중복을 제거합니다.
- 신규, 변경, 유효, 종료 상태를 기록합니다.
- 수집 실패 시 기존 `court-auctions.json`을 덮어쓰지 않습니다.
- 사이트 구조 변경 시 `data/last-failure.html`을 남기고 작업을 실패 처리합니다.

## 사용 방식

이 폴더의 **내용 전체를 하나의 GitHub 저장소 최상단에 업로드**합니다. Google Apps Script나 별도 서버는 사용하지 않습니다.

1. GitHub 저장소의 `Settings → Pages`에서 GitHub Pages를 활성화합니다.
2. `Actions`에서 `Daily Seoul Court Auction Crawl`을 한 번 수동 실행합니다.
3. 이후 매일 01:00(KST)에 데이터가 자동 갱신됩니다.
4. GitHub Pages 주소로 `index.html` 대시보드를 사용합니다.

## 로컬 시험

```bash
npm install
npx playwright install chromium
npm run crawl
```

GitHub 저장소에 올리면 `.github/workflows/daily-court-auction.yml`이 매일 한국시간 새벽 1시에 실행됩니다.

## 주의

법원 검색 화면은 조회일 기준 향후 2주 매각기일까지 제공합니다. 수집 결과는 참고용이며 입찰 전 매각물건명세서, 현황조사서, 감정평가서 및 등기사항전부증명서를 반드시 다시 확인해야 합니다.
