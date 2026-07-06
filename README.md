# Chart Atlas

국가별 음악 차트 1위와 곡/아티스트별 국가 순위 차이를 보는 React MVP입니다.

## What is included

- 세계지도 기반 국가별 1위 곡 표시
- 곡/아티스트별 종합 점수, 국가별 순위, 강한 지역 표시
- 종합 점수: `Σ(101 - 국가별 순위)`, 국가 가중치 없음
- 강한 지역: `max(지역 점수 합계 / 해당 지역 수집 국가 수)`
- 날짜별 스냅샷 선택: `public/data/snapshot-index.json`
- 날짜별 누적 JSON: `public/data/snapshots/YYYY-MM-DD.json`
- 국가별 1위 곡 Spotify 플레이리스트 생성 버튼
- 데모 스냅샷 데이터 모델: `src/data/chartSnapshot.ts`
- 실제 수집 JSON: `public/data/chart-snapshot.json`

앱은 `public/data/snapshot-index.json`이 있으면 날짜별 스냅샷 목록을 먼저 읽고, 없으면 `public/data/chart-snapshot.json`, 그마저 없으면 제품 검증용 데모 스냅샷으로 fallback합니다. 현재 기본 수집 데이터는 Kworb가 재게시하는 Spotify country daily chart입니다. `collect:spotify`는 최신 스냅샷과 날짜별 누적 스냅샷을 함께 갱신합니다. 운영 수집은 차트의 일간 노이즈를 줄이기 위해 매주 월요일 13:10 KST에 실행합니다.

Spotify 플레이리스트 생성은 Chart Atlas 자체 서버의 같은 출처 API가 처리합니다. 서버는 기본적으로 `/home/ubuntu/spotify-mcp-server/spotify-config.json`에서 Spotify 사용자 토큰을 읽고, 필요하면 `SPOTIFY_CONFIG_PATH`로 config 위치를 바꿀 수 있습니다. Spotify 인증은 `/home/ubuntu/spotify-mcp-server`에서 수동으로 갱신합니다. 브라우저에는 Spotify 키나 토큰을 노출하지 않습니다. 생성되는 플레이리스트는 기본적으로 비공개입니다.

Production base path는 `/`이며, canonical public URL은 `https://foldalpha.com/`입니다.

AdSense 운영 상태와 광고 확장 계획은 `docs/adsense.md`에 기록합니다.

## Commands

```bash
npm install
npm run collect:spotify
npm run dev
npm run build
npm run lint
```

Optional iTunes Store RSS collector:

```bash
npm run collect:itunes
```

## Local URL

The development server can run on:

```text
http://localhost:5175/
```
