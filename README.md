# 딱밤 섯다

현금 대신 딱밤으로 즐기는 2~4인용 온라인 2장 섯다 웹 게임입니다. Supabase 계정으로 로그인해 코드 방을 만들거나 참가하고, 계정별 딱밤 장부를 이어서 관리할 수 있습니다.

## 게임 규칙

- 1월부터 10월까지 두 장씩인 20장 덱에서 각 계정이 두 장을 받습니다.
- 행동은 `받기`와 `올리기`뿐입니다. 다이/포기는 없고 올리기 금액에는 임의 상한을 두지 않습니다.
- 단독 승자가 나오면 각 패자가 최종 1인당 요구량만큼 승자에게 딱밤을 빚집니다. 동률이면 새 채무 없이 재경기합니다.
- 장부는 좌석이 아니라 `때릴 계정 → 맞을 계정` 쌍으로 저장합니다. 반대 방향 채무도 상계하지 않습니다.
- 실제 딱밤을 한 대 칠 때마다 해당 장부의 미지급 수와 두 계정의 누적 통계가 한 대씩 갱신됩니다.

족보는 38광땡, 18광땡, 13광땡, 10땡~1땡, 알리, 독사, 구삥, 장삥, 장사, 세륙, 갑오, 8끗~1끗, 망통 순입니다. 잡이 계열 지역 규칙은 포함하지 않았습니다.

## 개발 실행

Node.js 22 이상을 권장합니다.

```bash
npm install
cp .env.example .env.local
npm run dev
```

환경 변수:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

위 두 Supabase 환경 변수는 플레이에 필수입니다. 배포 환경에도 같은 값을 설정해야 합니다.

## 검증

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

## 데이터베이스

`supabase/migrations`의 마이그레이션은 프로필, 2~4인 방, 방 참가 계정, 게임 결과, 방향성 딱밤 채무 테이블과 RLS 정책을 생성합니다.

```bash
npx supabase db push
```

## 카드 이미지 출처

섯다 패 이미지는 [devMinkyu/Korean-Poker](https://github.com/devMinkyu/Korean-Poker)의 `Server/public/images/card`를 사용했습니다. 원본 저장소에 명시적인 라이선스 파일이 없어 재배포 전 권리 상태를 별도로 확인해야 합니다. 상세 출처는 [`public/cards/ATTRIBUTION.md`](public/cards/ATTRIBUTION.md)에 기록되어 있습니다.
