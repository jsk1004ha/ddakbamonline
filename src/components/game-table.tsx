"use client";

import { useEffect, useReducer, useState } from "react";
import {
  applyAction,
  compareHands,
  createBettingState,
  dealRound,
  evaluateHand,
  recordHit,
  settleRound,
  summarizeAccountLedger,
  type BettingState,
  type Card,
  type EvaluatedHand,
  type ExactInteger,
  type ExactQuantity,
  type HitObligation,
} from "@/lib/game/engine.mjs";

type Account = {
  id: string;
  name: string;
  handle: string;
  mark: string;
};

type RoundSession = {
  round: number;
  playerIds: string[];
  hands: Record<string, Card[]>;
  betting: BettingState;
  phase: "betting" | "showdown";
  evaluations: Record<string, EvaluatedHand>;
  winnerIds: string[];
};

type GameState = {
  playerCount: number;
  session: RoundSession | null;
  obligations: HitObligation[];
};

type GameAction =
  | { type: "set-count"; count: number }
  | { type: "start"; session: RoundSession }
  | {
      type: "act";
      playerId: string;
      action: { type: "call" } | { type: "raise"; amount: ExactInteger };
    }
  | { type: "record-hit"; obligationId: string }
  | { type: "leave-table" };

const ACCOUNTS: Account[] = [
  { id: "account-moon", name: "밤도깨비", handle: "@moonlight", mark: "밤" },
  { id: "account-yuna", name: "유나의패", handle: "@yoona", mark: "유" },
  { id: "account-min", name: "민들레", handle: "@min_card", mark: "민" },
  { id: "account-danbi", name: "단비", handle: "@danbi", mark: "단" },
];

const MY_ACCOUNT_ID = ACCOUNTS[0].id;

function exactBigInt(value: ExactQuantity | bigint) {
  return typeof value === "bigint" ? value : BigInt(value);
}

function formatExact(value: ExactQuantity | bigint) {
  return exactBigInt(value).toLocaleString("ko-KR");
}

function isPositiveTotal(values: ExactQuantity[]) {
  return values.some((value) => exactBigInt(value) > BigInt(0));
}

function progressPercent(delivered: ExactQuantity, initial: ExactQuantity) {
  const total = exactBigInt(initial);
  if (total === BigInt(0)) return 0;
  return Number((exactBigInt(delivered) * BigInt(10_000)) / total) / 100;
}

function createRound(playerCount: number, round: number): RoundSession {
  const playerIds = ACCOUNTS.slice(0, playerCount).map(({ id }) => id);
  return {
    round,
    playerIds,
    hands: dealRound(playerIds),
    betting: createBettingState(playerIds, "1", (round - 1) % playerIds.length),
    phase: "betting",
    evaluations: {},
    winnerIds: [],
  };
}

function resolveRound(session: RoundSession, betting: BettingState) {
  const evaluations = Object.fromEntries(
    session.playerIds.map((playerId) => [playerId, evaluateHand(session.hands[playerId])]),
  );
  const best = session.playerIds.reduce((winnerId, candidateId) =>
    compareHands(evaluations[candidateId], evaluations[winnerId]) > 0
      ? candidateId
      : winnerId,
  );
  const winnerIds = session.playerIds.filter(
    (playerId) => compareHands(evaluations[playerId], evaluations[best]) === 0,
  );
  return { evaluations, winnerIds, betting };
}

function gameReducer(state: GameState, action: GameAction): GameState {
  if (action.type === "set-count") {
    return { ...state, playerCount: action.count, session: null };
  }
  if (action.type === "start") {
    return { ...state, session: action.session };
  }
  if (action.type === "leave-table") {
    return { ...state, session: null };
  }
  if (action.type === "record-hit") {
    return {
      ...state,
      obligations: recordHit(state.obligations, action.obligationId),
    };
  }
  if (!state.session || state.session.phase !== "betting") return state;

  const betting = applyAction(state.session.betting, action.playerId, action.action);
  if (betting.status !== "complete") {
    return { ...state, session: { ...state.session, betting } };
  }

  const result = resolveRound(state.session, betting);
  const winnerId = result.winnerIds.length === 1 ? result.winnerIds[0] : null;
  const obligations = settleRound(state.obligations, {
    winnerId,
    loserIds: winnerId
      ? state.session.playerIds.filter((playerId) => playerId !== winnerId)
      : [],
    stake: betting.currentStake,
  });

  return {
    ...state,
    obligations,
    session: {
      ...state.session,
      ...result,
      phase: "showdown",
    },
  };
}

function accountById(accountId: string) {
  return ACCOUNTS.find(({ id }) => id === accountId) ?? ACCOUNTS[0];
}

function PlayingCards({ cards, hidden }: { cards: Card[]; hidden: boolean }) {
  return (
    <div className="playing-cards" aria-label={hidden ? "뒤집힌 패 두 장" : "공개된 패 두 장"}>
      {cards.map((card, index) => (
        // Card PNG files are intentionally kept as their original artwork dimensions.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={card.id}
          src={hidden ? "/cards/back.png" : `/cards/${card.imageId}.png`}
          alt={hidden ? "뒷면" : `${card.month}월 ${card.variant}번 패`}
          width={119}
          height={176}
          className={index === 1 ? "card card--second" : "card"}
          draggable={false}
        />
      ))}
    </div>
  );
}

function PlayerSeat({
  account,
  index,
  total,
  cards,
  commitment,
  isTurn,
  isMine,
  phase,
  evaluation,
  isWinner,
}: {
  account: Account;
  index: number;
  total: number;
  cards: Card[];
  commitment: ExactQuantity;
  isTurn: boolean;
  isMine: boolean;
  phase: RoundSession["phase"];
  evaluation?: EvaluatedHand;
  isWinner: boolean;
}) {
  const hidden = phase === "betting" && !isMine;
  return (
    <article
      className={`player-seat seat--${index}-of-${total}${isTurn ? " is-turn" : ""}${isWinner ? " is-winner" : ""}`}
      aria-label={`${account.name} 계정${isTurn ? ", 현재 차례" : ""}`}
    >
      <div className="seat-head">
        <span className="account-mark" aria-hidden="true">{account.mark}</span>
        <span className="account-copy">
          <strong>{account.name}{isMine ? <em>나</em> : null}</strong>
          <small>{account.handle}</small>
        </span>
        <span className="seat-stake">{formatExact(commitment)}<small>딱밤</small></span>
      </div>
      <PlayingCards cards={cards} hidden={hidden} />
      <div className="seat-result" aria-live="polite">
        {evaluation ? (
          <>
            <strong>{evaluation.name}</strong>
            <span>{isWinner ? "이번 판 승자" : "패 공개"}</span>
          </>
        ) : isTurn ? (
          <><i className="turn-pulse" aria-hidden="true" /> 차례</>
        ) : (
          "대기"
        )}
      </div>
    </article>
  );
}

function Ledger({
  obligations,
  onRecordHit,
}: {
  obligations: HitObligation[];
  onRecordHit: (obligationId: string) => void;
}) {
  const totals = ACCOUNTS.map((account) => ({
    account,
    ...summarizeAccountLedger(obligations, account.id),
  })).filter(({ owes, isOwed, hitsDelivered, hitsReceived }) =>
    isPositiveTotal([owes, isOwed, hitsDelivered, hitsReceived]),
  );

  return (
    <aside className="ledger-panel" aria-labelledby="ledger-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">ACCOUNT LEDGER</span>
          <h2 id="ledger-title">계정별 딱밤 장부</h2>
        </div>
        <span className="ledger-count">{obligations.length}건</span>
      </div>
      <p className="ledger-note">자리와 방이 바뀌어도 계정 사이 기록은 그대로 남습니다.</p>

      {obligations.length === 0 ? (
        <div className="empty-ledger">
          <span aria-hidden="true">○</span>
          <strong>아직 오간 딱밤이 없어요</strong>
          <p>첫 승부가 끝나면 패자 → 승자 방향으로 따로 기록됩니다.</p>
        </div>
      ) : (
        <div className="obligation-list">
          {obligations.map((obligation) => {
            const debtor = accountById(obligation.debtorId);
            const creditor = accountById(obligation.creditorId);
            const complete = exactBigInt(obligation.remaining) === BigInt(0);
            return (
              <article className={`obligation${complete ? " is-complete" : ""}`} key={obligation.id}>
                <div className="obligation-route">
                  <span><b>{debtor.mark}</b>{debtor.name}</span>
                  <i aria-label="에서">→</i>
                  <span><b>{creditor.mark}</b>{creditor.name}</span>
                </div>
                <div className="hit-progress" aria-label={`총 ${obligation.initial}대 중 ${obligation.delivered}대 완료`}>
                  <span style={{ width: `${progressPercent(obligation.delivered, obligation.initial)}%` }} />
                </div>
                <div className="obligation-meta">
                  <span>남음 <strong>{formatExact(obligation.remaining)}</strong></span>
                  <span>때림 <strong>{formatExact(obligation.delivered)}</strong></span>
                  <button
                    type="button"
                    onClick={() => onRecordHit(obligation.id)}
                    disabled={complete}
                    aria-label={`${debtor.name}이 ${creditor.name}에게 딱밤 한 대 때린 것으로 기록`}
                  >
                    {complete ? "완료" : "한 대 기록"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {totals.length > 0 ? (
        <div className="account-totals" aria-label="계정별 요약">
          {totals.map(({ account, owes, isOwed }) => (
            <div key={account.id}>
              <span><b>{account.mark}</b>{account.name}</span>
              <small>줄 {formatExact(owes)} · 받을 {formatExact(isOwed)}</small>
            </div>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

export function GameTable() {
  const [state, dispatch] = useReducer(gameReducer, {
    playerCount: 4,
    session: null,
    obligations: [],
  });
  const [raiseAmount, setRaiseAmount] = useState("");
  const [actionError, setActionError] = useState("");
  const session = state.session;
  const activeAccounts = session
    ? session.playerIds.map(accountById)
    : ACCOUNTS.slice(0, state.playerCount);

  useEffect(() => {
    if (!session || session.phase !== "betting") return;
    const turnPlayerId = session.betting.turnPlayerId;
    if (!turnPlayerId || turnPlayerId === MY_ACCOUNT_ID) return;

    const timer = window.setTimeout(() => {
      const shouldRaise = Math.random() < 0.24;
      const amount = (
        exactBigInt(session.betting.currentStake) + BigInt(Math.ceil(Math.random() * 3))
      ).toString();
      dispatch({
        type: "act",
        playerId: turnPlayerId,
        action: shouldRaise ? { type: "raise", amount } : { type: "call" },
      });
    }, 680 + Math.random() * 620);
    return () => window.clearTimeout(timer);
  }, [session]);

  function startRound() {
    const nextRound = (state.session?.round ?? 0) + 1;
    setRaiseAmount("");
    setActionError("");
    dispatch({ type: "start", session: createRound(state.playerCount, nextRound) });
  }

  function call() {
    if (!session || session.betting.turnPlayerId !== MY_ACCOUNT_ID) return;
    setRaiseAmount("");
    setActionError("");
    dispatch({ type: "act", playerId: MY_ACCOUNT_ID, action: { type: "call" } });
  }

  function raise() {
    if (!session || session.betting.turnPlayerId !== MY_ACCOUNT_ID) return;
    const suggestedAmount = (exactBigInt(session.betting.currentStake) + BigInt(1)).toString();
    const requestedAmount = raiseAmount || suggestedAmount;
    if (!/^\d+$/.test(requestedAmount)) {
      setActionError("올릴 총 딱밤을 숫자로 입력해 주세요.");
      return;
    }
    const amount = BigInt(requestedAmount);
    if (amount <= exactBigInt(session.betting.currentStake)) {
      setActionError(`현재 ${formatExact(session.betting.currentStake)}보다 큰 정수를 입력해 주세요.`);
      return;
    }
    setRaiseAmount("");
    setActionError("");
    dispatch({ type: "act", playerId: MY_ACCOUNT_ID, action: { type: "raise", amount } });
  }

  const isMyTurn = session?.phase === "betting" && session.betting.turnPlayerId === MY_ACCOUNT_ID;
  const singleWinner = session?.phase === "showdown" && session.winnerIds.length === 1
    ? accountById(session.winnerIds[0])
    : null;

  return (
    <main className="app-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="딱밤소사이어티 홈">
          <span className="brand-seal" aria-hidden="true">딱</span>
          <span><strong>딱밤소사이어티</strong><small>DDAKBAM SOCIETY · SEOUL</small></span>
        </a>
        <div className="header-meta">
          <span className="live-mark"><i aria-hidden="true" /> 로컬 게임</span>
          <span className="header-account"><b>밤</b><span>밤도깨비<small>@moonlight</small></span></span>
        </div>
      </header>

      <section className="hero-strip" id="top">
        <div>
          <span className="eyebrow">TWO-CARD SEOTDA</span>
          <h1>돈 말고, <em>딱밤으로.</em></h1>
          <p>받거나 올리거나. 끝까지 패를 겨루는 2–4인 계정 대전.</p>
        </div>
        <div className="table-config" aria-label="테이블 인원 설정">
          <span>참가 계정</span>
          <div className="count-switch">
            {[2, 3, 4].map((count) => (
              <button
                key={count}
                type="button"
                className={state.playerCount === count ? "is-active" : ""}
                onClick={() => dispatch({ type: "set-count", count })}
                aria-pressed={state.playerCount === count}
              >
                {count}인
              </button>
            ))}
          </div>
          {session ? (
            <button type="button" className="text-button" onClick={() => dispatch({ type: "leave-table" })}>
              새 테이블
            </button>
          ) : null}
        </div>
      </section>

      <div className="content-grid">
        <section className="game-panel" aria-labelledby="game-title">
          <div className="game-toolbar">
            <div>
              <span className="room-code">PRIVATE ROOM · 0714</span>
              <h2 id="game-title">자정의 사랑방</h2>
            </div>
            <div className="rule-pills" aria-label="게임 규칙">
              <span>2장 섯다</span><span>포기 없음</span><span>상한 없음</span>
            </div>
          </div>

          <div className={`table-stage players-${activeAccounts.length}`}>
            <div className="felt-ring" aria-hidden="true"><span>DDAKBAM<br />SOCIETY</span></div>

            {session
              ? activeAccounts.map((account, index) => (
                  <PlayerSeat
                    key={account.id}
                    account={account}
                    index={index}
                    total={activeAccounts.length}
                    cards={session.hands[account.id]}
                    commitment={session.betting.commitments[account.id]}
                    isTurn={session.phase === "betting" && session.betting.turnPlayerId === account.id}
                    isMine={account.id === MY_ACCOUNT_ID}
                    phase={session.phase}
                    evaluation={session.evaluations[account.id]}
                    isWinner={session.winnerIds.includes(account.id)}
                  />
                ))
              : activeAccounts.map((account, index) => (
                  <div className={`preview-seat seat--${index}-of-${activeAccounts.length}`} key={account.id}>
                    <span className="account-mark">{account.mark}</span>
                    <strong>{account.name}</strong>
                    <small>{account.handle}</small>
                  </div>
                ))}

            <div className="table-center" aria-live="polite">
              {session ? (
                <>
                  <span className="round-label">ROUND {String(session.round).padStart(2, "0")}</span>
                  <small>판 딱밤</small>
                  <strong>{formatExact(session.betting.currentStake)}</strong>
                  <p>{session.phase === "showdown" ? "패 공개 완료" : "모두 같은 수로 받으면 공개"}</p>
                </>
              ) : (
                <>
                  <span className="round-label">TONIGHT&apos;S TABLE</span>
                  <strong className="ready-number">{state.playerCount}</strong>
                  <p>{state.playerCount}개 계정으로 판을 엽니다</p>
                </>
              )}
            </div>
          </div>

          <div className="action-dock">
            {!session ? (
              <div className="start-copy">
                <div><span className="eyebrow">READY</span><strong>{state.playerCount}인 패를 섞어 둘까요?</strong></div>
                <button type="button" className="primary-button" onClick={startRound}>게임 시작 <span>↗</span></button>
              </div>
            ) : session.phase === "showdown" ? (
              <div className="showdown-copy">
                <div>
                  <span className="eyebrow">SHOWDOWN</span>
                  <strong>{singleWinner ? `${singleWinner.name} 승리` : "공동 1위 · 재경기"}</strong>
                  <p>{singleWinner
                    ? `패자마다 ${formatExact(session.betting.currentStake)}대씩 별도 기록됐습니다.`
                    : "동률이면 새 딱밤 의무 없이 다시 겨룹니다."}</p>
                </div>
                <button type="button" className="primary-button" onClick={startRound}>한 판 더 <span>↻</span></button>
              </div>
            ) : isMyTurn ? (
              <div className="turn-actions">
                <div className="turn-copy"><span className="eyebrow">YOUR TURN</span><strong>받을까요, 올릴까요?</strong></div>
                <button type="button" className="call-button" onClick={call}>
                  <span>받기</span><small>{formatExact(session.betting.currentStake)}에 맞추기</small>
                </button>
                <div className="raise-control">
                  <label htmlFor="raise-amount">올릴 총 딱밤</label>
                  <input
                    id="raise-amount"
                    value={raiseAmount}
                    onChange={(event) => setRaiseAmount(event.target.value.trim())}
                    placeholder={(exactBigInt(session.betting.currentStake) + BigInt(1)).toString()}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    aria-describedby={actionError ? "raise-error" : undefined}
                  />
                  <button type="button" onClick={raise}>올리기 <span>↑</span></button>
                  {actionError ? <p id="raise-error" role="alert">{actionError}</p> : null}
                </div>
              </div>
            ) : (
              <div className="waiting-copy">
                <span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>
                <div><span className="eyebrow">OPPONENT&apos;S TURN</span><strong>{accountById(session.betting.turnPlayerId ?? "").name} 계정이 생각 중입니다</strong></div>
              </div>
            )}
          </div>
        </section>

        <Ledger
          obligations={state.obligations}
          onRecordHit={(obligationId) => dispatch({ type: "record-hit", obligationId })}
        />
      </div>

      <footer className="site-footer">
        <span>실제 금전이 오가지 않는 친선 게임입니다.</span>
        <span>© 2026 DDAKBAM SOCIETY</span>
      </footer>
    </main>
  );
}
